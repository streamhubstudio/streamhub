package email

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// SMTP host SSRF: a tenant SMTP (per-app / per-user) is dialed through the
// egress guard, and smtp/test answers fixed codes instead of the raw
// dial/SMTP error (which made it a port scanner). The "internal service" is
// an in-process loopback listener counting accepts; nothing else is dialed.

func loopbackListener(t *testing.T) (port int, accepts *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	accepts = &atomic.Int32{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepts.Add(1)
			_ = c.Close()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, accepts
}

func realTransportService(t *testing.T, apps contracts.AppsService) *Service {
	t.Helper()
	clearSMTPEnv(t)
	return New(&config.Config{JWTSecret: master}, SMTPTransport{Timeout: 2 * time.Second}, apps, nil, testutil.Log())
}

func TestSmtpProbeToPrivateHostIsRefusedGenerically(t *testing.T) {
	port, accepts := loopbackListener(t)
	for _, port465 := range []bool{false, true} {
		p := port
		if port465 {
			p = 465 // implicit-TLS path: blocked before any dial too
		}
		s := realTransportService(t, fakeApps{cfg: appCfg(contracts.SmtpConfig{Host: "127.0.0.1", Port: float64(p), User: "u", Pass: "p"})})
		res := s.TestAppSmtp(context.Background(), "live", "a@b.c")
		if res.OK || res.Error != "smtp_host_not_allowed" {
			t.Fatalf("port %d: want smtp_host_not_allowed, got %+v", p, res)
		}
	}
	// A name resolving private (fake DNS) is refused the same way.
	s := realTransportService(t, fakeApps{cfg: appCfg(contracts.SmtpConfig{Host: "smtp.corp.example", Port: float64(port), User: "u", Pass: "p"})})
	s.Resolve = func(context.Context, string) ([]string, error) { return []string{"10.0.0.5"}, nil }
	if res := s.TestAppSmtp(context.Background(), "live", "a@b.c"); res.OK || res.Error != "smtp_host_not_allowed" {
		t.Fatalf("private name: %+v", res)
	}
	if accepts.Load() != 0 {
		t.Fatalf("the private SMTP host was dialed (%d accepts)", accepts.Load())
	}

	// STREAMHUB_ALLOW_PRIVATE_SMTP_HOST opts out: the dial happens, and its
	// failure is still a fixed code.
	s = realTransportService(t, fakeApps{cfg: appCfg(contracts.SmtpConfig{Host: "127.0.0.1", Port: float64(port), User: "u", Pass: "p"})})
	t.Setenv(security.AllowPrivateSMTPHostEnv, "1")
	if res := s.TestAppSmtp(context.Background(), "live", "a@b.c"); res.OK || res.Error != "smtp_send_failed" {
		t.Fatalf("opt-out: %+v", res)
	}
	if accepts.Load() == 0 {
		t.Fatal("the opt-out did not dial")
	}
}

func TestSmtpProbeErrorsAreGeneric(t *testing.T) {
	raw := errors.New("dial failed: dial tcp 203.0.113.9:2525: connect: connection refused")
	s, tr := build(t, nil, fakeApps{cfg: appCfg(contracts.SmtpConfig{Host: "smtp.app", Pass: "p"})},
		fakeTenancy{"u1": {Host: "smtp.user", PassEnc: encrypted(t, "pw")}})
	tr.err = raw
	if res := s.TestAppSmtp(context.Background(), "live", "a@b.c"); res.Error != "smtp_send_failed" {
		t.Fatalf("app probe leaks %q", res.Error)
	}
	if res := s.TestUserSmtp(context.Background(), "u1", "a@b.c"); res.Error != "smtp_send_failed" {
		t.Fatalf("user probe leaks %q", res.Error)
	}
}

// ctxTransport records whether each send carried the dial guard.
type ctxTransport struct{ guarded []bool }

func (c *ctxTransport) Send(ctx context.Context, _ SMTP, _ string, _ Message) (string, error) {
	c.guarded = append(c.guarded, egressGuardFrom(ctx) != nil)
	return "<id>", nil
}

func TestOnlyTenantSmtpIsGuarded(t *testing.T) {
	clearSMTPEnv(t)
	t.Setenv("STREAMHUB_SMTP_HOST", "10.0.0.25") // the operator's relay may be private
	t.Setenv("STREAMHUB_SMTP_PASS", "g")
	tr := &ctxTransport{}
	apps := fakeApps{cfg: appCfg(contracts.SmtpConfig{Enabled: true, Host: "smtp.app", Pass: "p"})}
	s := New(&config.Config{JWTSecret: master}, tr, apps, nil, testutil.Log())
	msg := Message{To: "a@b.c", Subject: "s", Text: "t"}
	// global, per-app, probe
	s.Send(context.Background(), msg, nil)
	s.Send(context.Background(), msg, &SendContext{App: "live"})
	s.TestAppSmtp(context.Background(), "live", "a@b.c")
	if want := []bool{false, true, true}; len(tr.guarded) != 3 || tr.guarded[0] != want[0] || tr.guarded[1] != want[1] || tr.guarded[2] != want[2] {
		t.Fatalf("guarded = %v, want %v", tr.guarded, want)
	}
}
