package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func decodeB64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

func readCert(t *testing.T, p string) *x509.Certificate {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		t.Fatal("no PEM block")
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSelfSignedTLS(t *testing.T) {
	dir := t.TempDir()
	cfg, err := LoadOrCreateTLS(dir, "", "", []string{"Encoder.Example.com", "203.0.113.10"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MinVersion != tls.VersionTLS12 || cfg.GetCertificate == nil || len(cfg.CipherSuites) == 0 {
		t.Fatalf("weak config: %+v", cfg)
	}
	certPath, keyPath := filepath.Join(dir, "tls", "cert.pem"), filepath.Join(dir, "tls", "key.pem")
	if fi, err := os.Stat(keyPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", err, fi.Mode())
	}
	c := readCert(t, certPath)
	pub, ok := c.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("key is %T, want ECDSA P-256", c.PublicKey)
	}
	if v := c.NotAfter.Sub(c.NotBefore); v < 729*24*time.Hour || v > 732*24*time.Hour {
		t.Fatalf("validity %v, want ~2 years", v)
	}
	host, _ := os.Hostname()
	sans := certSANs(c)
	for _, want := range []string{"encoder.example.com", "203.0.113.10", "localhost", "127.0.0.1", normSANs([]string{host})[0]} {
		if !slices.Contains(sans, want) {
			t.Errorf("SAN %q missing from %v", want, sans)
		}
	}
	for _, ip := range c.IPAddresses {
		if ip.IsLinkLocalUnicast() {
			t.Errorf("link-local SAN %v", ip)
		}
	}
	if !slices.Contains(c.ExtKeyUsage, x509.ExtKeyUsageServerAuth) {
		t.Fatal("missing serverAuth EKU")
	}

	// Reuse: same hosts → same certificate.
	if _, err := LoadOrCreateTLS(dir, "", "", []string{"encoder.example.com"}); err != nil {
		t.Fatal(err)
	}
	if c2 := readCert(t, certPath); c2.SerialNumber.Cmp(c.SerialNumber) != 0 {
		t.Fatal("certificate regenerated although the SANs were covered")
	}
	// A new host → regenerated, keeping the previous SANs.
	if _, err := LoadOrCreateTLS(dir, "", "", []string{"new.example.com"}); err != nil {
		t.Fatal(err)
	}
	c3 := readCert(t, certPath)
	if c3.SerialNumber.Cmp(c.SerialNumber) == 0 {
		t.Fatal("certificate not regenerated for a new host")
	}
	if s := certSANs(c3); !slices.Contains(s, "new.example.com") || !slices.Contains(s, "encoder.example.com") {
		t.Fatalf("SANs after regeneration %v", s)
	}
	// Close to expiry → renewed.
	if err := ensureSelfSigned(filepath.Join(dir, "tls"), certPath, keyPath, nil, time.Now().Add(720*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if c4 := readCert(t, certPath); c4.SerialNumber.Cmp(c3.SerialNumber) == 0 {
		t.Fatal("expiring certificate not renewed")
	}
}

// TestTLSHandshakeAndReload serves through the config and reloads the
// operator-provided pair in place.
func TestTLSHandshakeAndReload(t *testing.T) {
	gen := t.TempDir()
	certPath, keyPath := filepath.Join(gen, "c.pem"), filepath.Join(gen, "k.pem")
	if err := writeSelfSigned(certPath, keyPath, []string{"localhost", "127.0.0.1"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	cfg, rl, err := LoadOrCreateTLSReloader(t.TempDir(), certPath, keyPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "hi") })}
	go srv.Serve(ln)
	defer srv.Close()

	get := func(want *x509.Certificate) {
		t.Helper()
		pool := x509.NewCertPool()
		pool.AddCert(want)
		cl := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "localhost"}}}
		defer cl.CloseIdleConnections()
		resp, err := cl.Get("https://" + ln.Addr().String() + "/")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if b, _ := io.ReadAll(resp.Body); string(b) != "hi" {
			t.Fatalf("body %q", b)
		}
	}
	first := readCert(t, certPath)
	get(first)

	// Old TLS versions are refused.
	if c, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{InsecureSkipVerify: true, MaxVersion: tls.VersionTLS11}); err == nil {
		c.Close()
		t.Fatal("TLS 1.1 accepted")
	}

	// Renew on disk, Reload, and the new certificate is served.
	if err := writeSelfSigned(certPath, keyPath, []string{"localhost", "127.0.0.1"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := rl.Reload(); err != nil {
		t.Fatal(err)
	}
	get(readCert(t, certPath))

	// A broken file keeps the current certificate.
	os.WriteFile(certPath, []byte("garbage"), 0o644)
	if err := rl.Reload(); err == nil {
		t.Fatal("Reload accepted garbage")
	}
	if c, _ := rl.GetCertificate(nil); c == nil {
		t.Fatal("certificate lost after a failed reload")
	}
	if _, err := LoadOrCreateTLS(t.TempDir(), certPath, "", nil); err == nil {
		t.Fatal("cert without key accepted")
	}
}

func TestRedirectHTTP(t *testing.T) {
	srv := RedirectHTTP(":0", 8443)
	cases := []struct{ host, uri, want string }{
		{"enc.local", "/x?y=1", "https://enc.local:8443/x?y=1"},
		{"enc.local:8090", "/", "https://enc.local:8443/"},
		{"[fd00::1]:80", "/a", "https://[fd00::1]:8443/a"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", c.uri, nil)
		r.Host = c.host
		w := httptest.NewRecorder()
		srv.Handler.ServeHTTP(w, r)
		if w.Code != http.StatusPermanentRedirect || w.Header().Get("Location") != c.want {
			t.Errorf("%s%s → %d %q, want %q", c.host, c.uri, w.Code, w.Header().Get("Location"), c.want)
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Host = "evil.com@x"
	w := httptest.NewRecorder()
	srv.Handler.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("bad host → %d", w.Code)
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.Host = "enc.local"
	RedirectHTTP(":0", 443).Handler.ServeHTTP(w, r)
	if loc := w.Header().Get("Location"); loc != "https://enc.local/" {
		t.Fatalf("443 location %q", loc)
	}
}
