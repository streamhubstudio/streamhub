package httpx

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// The egress-guarded client. No DNS and no network: Resolve is a fake and
// Dial routes every vetted address to an in-process httptest server, so
// "93.184.216.34" stands for any public host.

type dialLog struct {
	mu    sync.Mutex
	addrs []string
}

func (d *dialLog) dialTo(t *testing.T, srv *httptest.Server) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		d.mu.Lock()
		d.addrs = append(d.addrs, addr)
		d.mu.Unlock()
		if srv == nil {
			t.Errorf("unexpected dial to %s", addr)
			return nil, net.ErrClosed
		}
		var nd net.Dialer
		return nd.DialContext(ctx, network, srv.Listener.Addr().String())
	}
}

func fixedResolve(addrs ...string) Resolver {
	return func(context.Context, string) ([]string, error) { return addrs, nil }
}

func TestSafeClientBlocksResolvedPrivateAddress(t *testing.T) {
	for _, answers := range [][]string{
		{"169.254.169.254"},           // cloud metadata via a DNS name
		{"93.184.216.34", "10.0.0.7"}, // partial poison: one bad answer is enough
		{"::ffff:7f00:1"},             // IPv4-mapped loopback in hex form
		{"0.0.0.0"},
	} {
		d := &dialLog{}
		c := NewSafeClient(&EgressGuard{Resolve: fixedResolve(answers...), Dial: d.dialTo(t, nil)})
		_, err := c.Get("http://metadata.example/latest/meta-data/")
		if err == nil || !IsEgressBlocked(err) {
			t.Fatalf("%v: want an egress block, got %v", answers, err)
		}
		if len(d.addrs) != 0 {
			t.Fatalf("%v: dialed %v", answers, d.addrs)
		}
	}
	// IP literals never reach the resolver.
	c := NewSafeClient(&EgressGuard{Resolve: func(context.Context, string) ([]string, error) {
		t.Fatal("resolver called for an IP literal")
		return nil, nil
	}, Dial: (&dialLog{}).dialTo(t, nil)})
	if _, err := c.Get("http://127.0.0.1:8080/"); !IsEgressBlocked(err) {
		t.Fatalf("loopback literal: %v", err)
	}
}

func TestSafeClientAllowsPublicDestination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer srv.Close()
	d := &dialLog{}
	c := NewSafeClient(&EgressGuard{Resolve: fixedResolve("93.184.216.34"), Dial: d.dialTo(t, srv)})
	res, err := c.Get("http://hooks.example/x")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("public: %v %v", res, err)
	}
	_ = res.Body.Close()
	// The vetted IP is what gets dialed (no second resolution).
	if len(d.addrs) != 1 || d.addrs[0] != "93.184.216.34:80" {
		t.Fatalf("dialed %v", d.addrs)
	}
}

// swapHandler lets one server change behaviour between requests.
type swapHandler struct {
	mu sync.Mutex
	h  http.HandlerFunc
}

func (s *swapHandler) set(h http.HandlerFunc) { s.mu.Lock(); s.h = h; s.mu.Unlock() }

func (s *swapHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	h := s.h
	s.mu.Unlock()
	h(w, r)
}

func TestSafeClientRedirectToLoopbackBlocked(t *testing.T) {
	var mu sync.Mutex
	internalHits := 0
	redirectTo := func(loc string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/internal" {
				mu.Lock()
				internalHits++
				mu.Unlock()
				return
			}
			http.Redirect(w, r, loc, http.StatusFound)
		}
	}
	sw := &swapHandler{}
	srv := httptest.NewServer(sw)
	defer srv.Close()
	for _, loc := range []string{"http://127.0.0.1/internal", "http://169.254.169.254/latest/", "http://[::1]/internal"} {
		sw.set(redirectTo(loc))
		c := NewSafeClient(&EgressGuard{Resolve: fixedResolve("93.184.216.34"), Dial: (&dialLog{}).dialTo(t, srv)})
		_, err := c.Get("http://hooks.example/start")
		if err == nil || !IsEgressBlocked(err) {
			t.Fatalf("redirect to %s: want an egress block, got %v", loc, err)
		}
	}
	// A redirect to a hostname that resolves private is refused too.
	sw.set(redirectTo("http://evil.example/internal"))
	resolve := func(_ context.Context, host string) ([]string, error) {
		if host == "evil.example" {
			return []string{"192.168.0.1"}, nil
		}
		return []string{"93.184.216.34"}, nil
	}
	c := NewSafeClient(&EgressGuard{Resolve: resolve, Dial: (&dialLog{}).dialTo(t, srv)})
	if _, err := c.Get("http://hooks.example/start"); !IsEgressBlocked(err) {
		t.Fatalf("redirect to a private name: %v", err)
	}
	// Non-http schemes are refused on redirect.
	sw.set(redirectTo("file:///etc/passwd"))
	if _, err := c.Get("http://hooks.example/start"); err == nil || !strings.Contains(err.Error(), `scheme "file"`) {
		t.Fatalf("redirect to file: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if internalHits != 0 {
		t.Fatalf("internal target hit %d times", internalHits)
	}
}

func TestSafeClientRedirectCap(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, "/next", http.StatusFound)
	}))
	defer srv.Close()
	c := NewSafeClient(&EgressGuard{Resolve: fixedResolve("93.184.216.34"), Dial: (&dialLog{}).dialTo(t, srv)})
	_, err := c.Get("http://hooks.example/")
	if err == nil || !strings.Contains(err.Error(), "stopped after 5 redirects") {
		t.Fatalf("want the redirect cap, got %v", err)
	}
	if hits != MaxEgressRedirects+1 {
		t.Fatalf("hits = %d, want %d", hits, MaxEgressRedirects+1)
	}
}

func TestSafeClientAllowlistAndOptOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	get := func(g *EgressGuard, url string) ([]string, error) {
		d := &dialLog{}
		g.Dial = d.dialTo(t, srv)
		res, err := NewSafeClient(g).Get(url)
		if err == nil {
			_ = res.Body.Close()
		}
		return d.addrs, err
	}
	// CIDR entry: the resolved 10.x is exempt and dialed by IP.
	addrs, err := get(&EgressGuard{Resolve: fixedResolve("10.1.2.3"), Allowlist: func() []string { return []string{"10.0.0.0/8"} }}, "http://svc.internal/")
	if err != nil || len(addrs) != 1 || addrs[0] != "10.1.2.3:80" {
		t.Fatalf("cidr allowlist: %v %v", addrs, err)
	}
	// Hostname entry: not even resolved, dialed as given.
	addrs, err = get(&EgressGuard{Resolve: fixedResolve("10.1.2.3"), Allowlist: func() []string { return []string{"SVC.internal"} }}, "http://svc.internal:9000/")
	if err != nil || len(addrs) != 1 || addrs[0] != "svc.internal:9000" {
		t.Fatalf("hostname allowlist: %v %v", addrs, err)
	}
	// An allowlisted hostname does not exempt a different private one.
	if _, err = get(&EgressGuard{Resolve: fixedResolve("10.1.2.3"), Allowlist: func() []string { return []string{"svc.internal"} }}, "http://other.internal/"); !IsEgressBlocked(err) {
		t.Fatalf("other host: %v", err)
	}
	// AllowPrivate opts out entirely.
	if _, err = get(&EgressGuard{AllowPrivate: true}, "http://127.0.0.1:1/"); err != nil {
		t.Fatalf("allow private: %v", err)
	}
}

func TestSafeClientDialControl(t *testing.T) {
	g := &EgressGuard{}
	ctl := g.control(g.allowlist())
	for addr, blocked := range map[string]bool{
		"169.254.169.254:80": true, "127.0.0.1:6379": true, "10.0.0.1:443": true, "[::1]:80": true,
		"[fe80::1]:80": true, "0.0.0.0:80": true, "93.184.216.34:443": false, "[2606:4700::1111]:443": false,
	} {
		if err := ctl("tcp", addr, nil); (err != nil) != blocked {
			t.Fatalf("control(%s) = %v, want blocked=%v", addr, err, blocked)
		}
	}
	allowed := &EgressGuard{Allowlist: func() []string { return []string{"10.0.0.0/8"} }}
	if err := allowed.control(allowed.allowlist())("tcp", "10.0.0.1:443", nil); err != nil {
		t.Fatalf("allowlisted control: %v", err)
	}
}
