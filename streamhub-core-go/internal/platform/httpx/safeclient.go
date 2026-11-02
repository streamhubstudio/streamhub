package httpx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/netaddr"
)

// Egress-guarded outbound HTTP for tenant-controlled URLs (webhooks,
// streamflow action.http, AI endpoints, DRM key servers, notifier hooks).
// The URL guard (security.AssertSafeEgressURL) checks a hostname ONCE, before
// the request; two things slip past it: DNS rebinding (the name re-resolves
// to 169.254.169.254 between the check and the dial) and a 30x to an internal
// address. Here every dial resolves the host itself, refuses when ANY answer
// is private/loopback/link-local/unspecified (same ranges and allowlist
// semantics as the URL guard) and connects to the vetted IP; the real
// dialer's Control re-checks the address the socket actually connects to.
// Redirects are re-vetted and capped at MaxEgressRedirects.

// MaxEgressRedirects caps the redirect chain of a guarded client.
const MaxEgressRedirects = 5

// Resolver resolves a hostname (injectable: tests never dial DNS).
type Resolver func(ctx context.Context, host string) ([]string, error)

// EgressBlockedError is a dial or redirect the guard refused.
type EgressBlockedError struct {
	Host string // as requested
	Addr string // the offending address ("" when the host itself is the literal)
}

func (e *EgressBlockedError) Error() string {
	if e.Addr == "" || e.Addr == e.Host {
		return fmt.Sprintf("egress to %s blocked: private/loopback/link-local address", e.Host)
	}
	return fmt.Sprintf("egress to %s blocked: resolves to private/loopback/link-local address %s", e.Host, e.Addr)
}

// IsEgressBlocked reports whether err (or anything it wraps) is a guard refusal.
func IsEgressBlocked(err error) bool {
	var be *EgressBlockedError
	return errors.As(err, &be)
}

// EgressGuard is the dial-time half of the SSRF guard.
type EgressGuard struct {
	// AllowPrivate disables the address check (the STREAMHUB_ALLOW_PRIVATE_*
	// style opt-outs).
	AllowPrivate bool
	// Allowlist returns the hostnames / IPs / CIDRs exempted from the check;
	// read on every dial, as the URL guard reads its env on every call.
	Allowlist func() []string
	// Resolve is the DNS seam (nil = the system resolver).
	Resolve Resolver
	// Dial connects to an already-vetted address (nil = a net.Dialer whose
	// Control re-checks the connected IP). Tests inject one.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
}

func (g *EgressGuard) allowlist() netaddr.Allowlist {
	if g.Allowlist == nil {
		return netaddr.CompileAllowlist(nil)
	}
	return netaddr.CompileAllowlist(g.Allowlist())
}

// vet resolves host and checks every answer. exempt = dial host as given
// (AllowPrivate or an allowlisted hostname); otherwise addrs are the vetted
// IPs to connect to.
func (g *EgressGuard) vet(ctx context.Context, host string, allow netaddr.Allowlist) (addrs []string, exempt bool, err error) {
	if g.AllowPrivate || allow.HasHostname(host) {
		return nil, true, nil
	}
	if netaddr.ParseIP(host) != nil {
		addrs = []string{host}
	} else {
		resolve := g.Resolve
		if resolve == nil {
			resolve = net.DefaultResolver.LookupHost
		}
		if addrs, err = resolve(ctx, host); err != nil || len(addrs) == 0 {
			return nil, false, fmt.Errorf("egress host %q does not resolve", host)
		}
	}
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		// Canonical form: ::ffff:7f00:1 is 127.0.0.1 to the kernel.
		if ip := net.ParseIP(netaddr.NormalizeIP(a)); ip != nil {
			a = ip.String()
		}
		if netaddr.IsForbiddenEgress(a) && !allow.HasAddress(a) {
			return nil, false, &EgressBlockedError{Host: host, Addr: a}
		}
		out = append(out, a)
	}
	return out, false, nil
}

// control is net.Dialer.Control: the last word on the address the socket
// connects to, whatever resolved it.
func (g *EgressGuard) control(allow netaddr.Allowlist) func(string, string, syscall.RawConn) error {
	return func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			host = address
		}
		if netaddr.IsForbiddenEgress(host) && !allow.HasAddress(host) {
			return &EgressBlockedError{Host: host}
		}
		return nil
	}
}

func (g *EgressGuard) dial(ctx context.Context, network, addr string, control func(string, string, syscall.RawConn) error) (net.Conn, error) {
	if g.Dial != nil {
		return g.Dial(ctx, network, addr)
	}
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second, Control: control}
	return d.DialContext(ctx, network, addr)
}

// DialContext is the guarded dial (http.Transport.DialContext shape).
func (g *EgressGuard) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	allow := g.allowlist()
	addrs, exempt, err := g.vet(ctx, host, allow)
	if err != nil {
		return nil, err
	}
	if exempt {
		return g.dial(ctx, network, address, nil)
	}
	control := g.control(allow)
	var first error
	for _, a := range addrs {
		c, err := g.dial(ctx, network, net.JoinHostPort(a, port), control)
		if err == nil {
			return c, nil
		}
		if first == nil {
			first = err
		}
	}
	return nil, first
}

// CheckRedirect re-vets every hop and follows at most MaxEgressRedirects.
func (g *EgressGuard) CheckRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > MaxEgressRedirects {
		return fmt.Errorf("stopped after %d redirects", MaxEgressRedirects)
	}
	if s := strings.ToLower(req.URL.Scheme); s != "http" && s != "https" {
		return fmt.Errorf("redirect to scheme %q is not allowed", req.URL.Scheme)
	}
	_, _, err := g.vet(req.Context(), req.URL.Hostname(), g.allowlist())
	return err
}

// NewSafeClient is an http.Client whose every connection goes through g.
// No proxy: a proxy would dial the target on our behalf, past the guard.
// Timeouts stay with the caller's context.
func NewSafeClient(g *EgressGuard) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           g.DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
		CheckRedirect: g.CheckRedirect,
	}
}
