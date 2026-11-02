package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	selfSignedValidity = 2 * 365 * 24 * time.Hour
	renewBefore        = 30 * 24 * time.Hour
)

// CertReloader serves a certificate/key pair from disk and can reload it
// (e.g. on SIGHUP) without restarting the listener.
type CertReloader struct {
	certFile, keyFile string
	mu                sync.RWMutex
	cert              *tls.Certificate
}

// NewCertReloader loads certFile/keyFile (PEM).
func NewCertReloader(certFile, keyFile string) (*CertReloader, error) {
	c := &CertReloader{certFile: certFile, keyFile: keyFile}
	if err := c.Reload(); err != nil {
		return nil, err
	}
	return c, nil
}

// Reload re-reads the pair; on error the previous certificate stays in use.
func (c *CertReloader) Reload() error {
	cert, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
	if err != nil {
		return fmt.Errorf("auth: load TLS pair %s / %s: %w", c.certFile, c.keyFile, err)
	}
	c.mu.Lock()
	c.cert = &cert
	c.mu.Unlock()
	return nil
}

// GetCertificate implements tls.Config.GetCertificate.
func (c *CertReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cert, nil
}

// TLSConfig returns a hardened server config backed by the reloader.
func (c *CertReloader) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: c.GetCertificate,
		// TLS 1.2 suites: forward-secret AEADs only (TLS 1.3 suites are fixed).
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
	}
}

// LoadOrCreateTLS returns a server TLS config. With certFile and keyFile it
// serves that pair; otherwise it creates (or reuses) a self-signed ECDSA
// P-256 certificate in <dataDir>/tls/ valid two years whose SANs cover the
// hostname, every non-loopback interface IP, localhost and hosts.
func LoadOrCreateTLS(dataDir, certFile, keyFile string, hosts []string) (*tls.Config, error) {
	cfg, _, err := LoadOrCreateTLSReloader(dataDir, certFile, keyFile, hosts)
	return cfg, err
}

// LoadOrCreateTLSReloader is LoadOrCreateTLS that also returns the reloader
// (call Reload on SIGHUP to pick up a renewed certificate).
func LoadOrCreateTLSReloader(dataDir, certFile, keyFile string, hosts []string) (*tls.Config, *CertReloader, error) {
	if (certFile == "") != (keyFile == "") {
		return nil, nil, errors.New("auth: TLS cert and key files must be given together")
	}
	if certFile == "" {
		dir := filepath.Join(dataDir, "tls")
		certFile, keyFile = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
		if err := ensureSelfSigned(dir, certFile, keyFile, desiredSANs(hosts), time.Now()); err != nil {
			return nil, nil, err
		}
	}
	r, err := NewCertReloader(certFile, keyFile)
	if err != nil {
		return nil, nil, err
	}
	return r.TLSConfig(), r, nil
}

// desiredSANs = hostname + non-loopback, non-link-local interface IPs +
// localhost/127.0.0.1/::1 + hosts (names or IPs).
func desiredSANs(hosts []string) []string {
	var out []string
	if h, err := os.Hostname(); err == nil && h != "" {
		out = append(out, h)
	}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.IsLoopback() || ipn.IP.IsLinkLocalUnicast() || ipn.IP.IsLinkLocalMulticast() {
				continue
			}
			out = append(out, ipn.IP.String())
		}
	}
	out = append(out, "localhost", "127.0.0.1", "::1")
	for _, h := range hosts {
		if h = strings.TrimSpace(h); h != "" {
			out = append(out, h)
		}
	}
	return normSANs(out)
}

func normSANs(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if ip := net.ParseIP(s); ip != nil {
			s = ip.String()
		} else {
			s = strings.ToLower(s)
		}
		out = append(out, s)
	}
	slices.Sort(out)
	return slices.Compact(out)
}

func certSANs(c *x509.Certificate) []string {
	out := slices.Clone(c.DNSNames)
	for _, ip := range c.IPAddresses {
		out = append(out, ip.String())
	}
	return normSANs(out)
}

// ensureSelfSigned keeps the existing certificate unless it is unreadable,
// expires within 30 days or misses a desired SAN; a regenerated certificate
// keeps the old SANs too, so a changing DHCP address does not churn it.
func ensureSelfSigned(dir, certFile, keyFile string, want []string, now time.Time) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	var keep []string
	if pair, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil && pair.Leaf != nil {
		have := certSANs(pair.Leaf)
		missing := false
		for _, s := range want {
			if !slices.Contains(have, s) {
				missing = true
				break
			}
		}
		if !missing && pair.Leaf.NotAfter.Sub(now) > renewBefore {
			return nil
		}
		keep = have
	}
	return writeSelfSigned(certFile, keyFile, normSANs(append(keep, want...)), now)
}

func writeSelfSigned(certFile, keyFile string, sans []string, now time.Time) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	cn := "streamhub-encoder"
	if h, err := os.Hostname(); err == nil && h != "" {
		cn = h
	}
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: cn, Organization: []string{"StreamHub Encoder (self-signed)"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(selfSignedValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, s := range sans {
		if ip := net.ParseIP(s); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else {
			tpl.DNSNames = append(tpl.DNSNames, s)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	kb, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return err
	}
	return writeFileAtomic(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
}

// RedirectHTTP returns a plain-HTTP server on addr that permanently redirects
// every request to https on httpsPort (443 is omitted from the URL). Start it
// with ListenAndServe.
func RedirectHTTP(addr string, httpsPort int) *http.Server {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if host == "" || strings.ContainsAny(host, "/\\@?#% ") {
			http.Error(w, "bad host", http.StatusBadRequest)
			return
		}
		if strings.Contains(host, ":") { // IPv6 literal
			host = "[" + host + "]"
		}
		if httpsPort != 443 {
			host += ":" + strconv.Itoa(httpsPort)
		}
		http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusPermanentRedirect)
	})
	return &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
}
