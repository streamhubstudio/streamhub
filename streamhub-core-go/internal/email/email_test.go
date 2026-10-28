package email

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// Ports email.service.spec.ts, email.service.precedence.spec.ts and
// email-smtp-test.controller.spec.ts. No SMTP is ever dialed: the
// Transport is a recorder.

const master = "master-secret-for-tests"

type sent struct {
	smtp SMTP
	from string
	msg  Message
}

type fakeTransport struct {
	calls []sent
	err   error
}

func (f *fakeTransport) Send(_ context.Context, smtp SMTP, from string, msg Message) (string, error) {
	f.calls = append(f.calls, sent{smtp, from, msg})
	if f.err != nil {
		return "", f.err
	}
	return "<abc@streamhub>", nil
}

type fakeApps struct {
	contracts.AppsService
	cfg *contracts.AppConfig
	err error
	rec *contracts.AppRecord
}

func (f fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	return f.cfg, f.err
}
func (f fakeApps) Get(context.Context, string) (*contracts.AppRecord, error) { return f.rec, nil }

type fakeTenancy map[string]*tenancy.UserSmtp

func (f fakeTenancy) GetUserSmtp(_ context.Context, id string) *tenancy.UserSmtp { return f[id] }

func appCfg(s contracts.SmtpConfig) *contracts.AppConfig {
	return &contracts.AppConfig{Smtp: s}
}

func clearSMTPEnv(t *testing.T) {
	for _, k := range []string{"STREAMHUB_SMTP_HOST", "STREAMHUB_SMTP_PORT", "STREAMHUB_SMTP_USER", "STREAMHUB_SMTP_PASS", "STREAMHUB_SMTP_FROM"} {
		t.Setenv(k, "")
	}
}

func build(t *testing.T, env map[string]string, apps contracts.AppsService, ten Tenancy) (*Service, *fakeTransport) {
	t.Helper()
	clearSMTPEnv(t)
	for k, v := range env {
		t.Setenv(k, v)
	}
	tr := &fakeTransport{}
	return New(&config.Config{JWTSecret: master}, tr, apps, ten, testutil.Log()), tr
}

func encrypted(t *testing.T, plain string) *string {
	t.Helper()
	enc, err := auth.EncryptUserSmtpSecret(plain, master)
	if err != nil {
		t.Fatal(err)
	}
	return &enc
}

func TestGlobalSettings(t *testing.T) {
	s, _ := build(t, map[string]string{"STREAMHUB_SMTP_PASS": ""}, nil, nil)
	if s.IsConfigured() {
		t.Fatal("no PASS must mean not configured")
	}
	s, _ = build(t, map[string]string{"STREAMHUB_SMTP_PASS": "s3cret"}, nil, nil)
	if !s.IsConfigured() || s.FromAddress() != "StreamHub <no-reply@streamhub.studio>" {
		t.Fatal("defaults")
	}
	if s.settings.Host != "mail.wipermax.online" || s.settings.Port != 587 || s.settings.User != "no-reply@streamhub.studio" {
		t.Fatalf("%+v", s.settings)
	}
	s, _ = build(t, map[string]string{"STREAMHUB_SMTP_PASS": "p", "STREAMHUB_SMTP_PORT": "465abc"}, nil, nil)
	if s.settings.Port != 465 {
		t.Fatal("port is parseInt")
	}
}

func TestSkipWhenUnconfigured(t *testing.T) {
	s, tr := build(t, nil, nil, nil)
	res := s.SendMagicLink(context.Background(), "a@b.com", "https://x/y", nil)
	if res.OK || !res.Skipped || res.Error != "smtp_not_configured" || len(tr.calls) != 0 {
		t.Fatalf("%+v %d", res, len(tr.calls))
	}
}

func TestMagicLinkMessage(t *testing.T) {
	s, tr := build(t, map[string]string{"STREAMHUB_SMTP_PASS": "p"}, nil, nil)
	res := s.SendMagicLink(context.Background(), "user@example.com", `https://h/auth?t=a&b="c"`, nil)
	if !res.OK || res.MessageID != "<abc@streamhub>" {
		t.Fatalf("%+v", res)
	}
	c := tr.calls[0]
	if c.from != "StreamHub <no-reply@streamhub.studio>" || c.msg.To != "user@example.com" || c.msg.Subject != "Your StreamHub sign-in link" {
		t.Fatalf("%+v", c)
	}
	if !strings.Contains(c.msg.Text, `https://h/auth?t=a&b="c"`) || !strings.Contains(c.msg.HTML, `href="https://h/auth?t=a&amp;b=&quot;c&quot;"`) {
		t.Fatal("url must be raw in text and escaped in html")
	}
}

func TestInviteMessage(t *testing.T) {
	s, tr := build(t, map[string]string{"STREAMHUB_SMTP_PASS": "p"}, nil, nil)
	s.SendInvite(context.Background(), "x@y.com", "https://u", InviteOptions{TeamName: "A&B", Role: "editor", InvitedBy: "ann"}, nil)
	m := tr.calls[0].msg
	if m.Subject != "You've been invited to A&B on StreamHub" ||
		!strings.Contains(m.Text, "You have been invited by ann to join A&B as editor. ") ||
		!strings.Contains(m.HTML, "<strong>A&amp;B</strong> as editor.") {
		t.Fatalf("%+v", m)
	}
	s.SendInvite(context.Background(), "x@y.com", "https://u", InviteOptions{}, nil)
	if tr.calls[1].msg.Subject != "You've been invited to a StreamHub team on StreamHub" {
		t.Fatal(tr.calls[1].msg.Subject)
	}
}

func TestNeverFailsOnTransportError(t *testing.T) {
	s, tr := build(t, map[string]string{"STREAMHUB_SMTP_PASS": "p"}, nil, nil)
	tr.err = errors.New("connect ECONNREFUSED")
	res := s.Send(context.Background(), Message{To: "a@b.com", Subject: "s", Text: "t"}, nil)
	if res.OK || res.Error != "connect ECONNREFUSED" || res.Skipped {
		t.Fatalf("%+v", res)
	}
}

func TestPrecedence(t *testing.T) {
	ctx := context.Background()
	global := SMTP{Host: "mail.wipermax.online", Port: 587, User: "no-reply@streamhub.studio", Pass: "g", From: "StreamHub <no-reply@streamhub.studio>"}
	appOn := fakeApps{cfg: appCfg(contracts.SmtpConfig{Enabled: true, Host: "smtp.app.test", Port: 465, User: "app-user", Pass: "app-pass", From: "App <app@test.com>"})}
	user := func(enabled bool, passEnc *string) fakeTenancy {
		return fakeTenancy{"u1": {Enabled: enabled, Host: "smtp.user.test", Port: ptrI(2525), User: "me", PassEnc: passEnc}}
	}
	cases := []struct {
		name string
		apps contracts.AppsService
		ten  Tenancy
		sc   *SendContext
		env  map[string]string
		want *SMTP // nil = skipped
	}{
		{"no context → global", nil, nil, nil, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, &global},
		{"app enabled + complete → app", appOn, nil, &SendContext{App: "live"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"},
			&SMTP{"smtp.app.test", 465, "app-user", "app-pass", "App <app@test.com>"}},
		{"app disabled → global", fakeApps{cfg: appCfg(contracts.SmtpConfig{Host: "h", Pass: "p"})}, nil, &SendContext{App: "live"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, &global},
		{"app missing host/pass → global", fakeApps{cfg: appCfg(contracts.SmtpConfig{Enabled: true})}, nil, &SendContext{App: "live"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, &global},
		{"app lookup fails → global", fakeApps{err: errors.New("not found")}, nil, &SendContext{App: "ghost"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, &global},
		{"neither configured → skipped", fakeApps{cfg: appCfg(contracts.SmtpConfig{})}, nil, &SendContext{App: "live"}, nil, nil},
		{"app port 0 → 587, from → global from", fakeApps{cfg: appCfg(contracts.SmtpConfig{Enabled: true, Host: "h", Pass: "p", User: "u"})}, nil, &SendContext{App: "live"}, nil,
			&SMTP{"h", 587, "u", "p", "StreamHub <no-reply@streamhub.studio>"}},
		{"user override wins over app", appOn, user(true, encrypted(t, "user-pass")), &SendContext{UserID: "u1", App: "live"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"},
			&SMTP{"smtp.user.test", 2525, "me", "user-pass", "StreamHub <no-reply@streamhub.studio>"}},
		{"user disabled → app tier", appOn, user(false, encrypted(t, "user-pass")), &SendContext{UserID: "u1", App: "live"}, nil,
			&SMTP{"smtp.app.test", 465, "app-user", "app-pass", "App <app@test.com>"}},
		{"user decrypt fails → global", nil, user(true, ptrS("garbage")), &SendContext{UserID: "u1"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, &global},
		{"unknown user → global", nil, fakeTenancy{}, &SendContext{UserID: "ghost"}, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, &global},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, tr := build(t, c.env, c.apps, c.ten)
			res := s.Send(ctx, Message{To: "a@b.com", Subject: "s", Text: "t"}, c.sc)
			if c.want == nil {
				if !res.Skipped || len(tr.calls) != 0 {
					t.Fatalf("want skipped, got %+v", res)
				}
				return
			}
			if len(tr.calls) != 1 || tr.calls[0].smtp != *c.want || tr.calls[0].from != c.want.From {
				t.Fatalf("got %+v", tr.calls)
			}
		})
	}
}

func TestProbes(t *testing.T) {
	ctx := context.Background()
	t.Run("testAppSmtp uses the app's own settings even when disabled", func(t *testing.T) {
		s, tr := build(t, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, fakeApps{cfg: appCfg(contracts.SmtpConfig{Host: "smtp.app", Pass: "p", User: "u"})}, nil)
		res := s.TestAppSmtp(ctx, "live", "ops@x.com")
		if !res.OK || tr.calls[0].smtp.Host != "smtp.app" || tr.calls[0].msg.Subject != "StreamHub SMTP test" ||
			tr.calls[0].msg.HTML != "<p>This is a test email from StreamHub confirming this SMTP configuration works.</p>" {
			t.Fatalf("%+v %+v", res, tr.calls)
		}
	})
	t.Run("testAppSmtp never falls back to global", func(t *testing.T) {
		s, tr := build(t, map[string]string{"STREAMHUB_SMTP_PASS": "g"}, fakeApps{cfg: appCfg(contracts.SmtpConfig{Enabled: true})}, nil)
		res := s.TestAppSmtp(ctx, "live", "ops@x.com")
		if res.OK || !res.Skipped || res.Error != "smtp_not_configured" || len(tr.calls) != 0 {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("testAppSmtp unknown app / no apps service", func(t *testing.T) {
		s, _ := build(t, nil, fakeApps{err: errors.New("x")}, nil)
		if r := s.TestAppSmtp(ctx, "ghost", "a@b.c"); r.Error != "app_not_found" {
			t.Fatal(r)
		}
		s, _ = build(t, nil, nil, nil)
		if r := s.TestAppSmtp(ctx, "ghost", "a@b.c"); r.Error != "apps_service_unavailable" {
			t.Fatal(r)
		}
	})
	t.Run("testUserSmtp uses the user's own settings even when disabled", func(t *testing.T) {
		s, tr := build(t, nil, nil, fakeTenancy{"u1": {Host: "smtp.user", PassEnc: encrypted(t, "pw")}})
		res := s.TestUserSmtp(ctx, "u1", "me@x.com")
		if !res.OK || tr.calls[0].smtp.Pass != "pw" || tr.calls[0].smtp.Port != 587 {
			t.Fatalf("%+v %+v", res, tr.calls)
		}
	})
	t.Run("testUserSmtp skipped / decrypt_failed / no tenancy", func(t *testing.T) {
		s, _ := build(t, nil, nil, fakeTenancy{"u1": {Host: "smtp.user"}, "u2": {Host: "h", PassEnc: ptrS("bad")}})
		if r := s.TestUserSmtp(ctx, "u1", "a@b.c"); !r.Skipped || r.Error != "smtp_not_configured" {
			t.Fatal(r)
		}
		if r := s.TestUserSmtp(ctx, "u2", "a@b.c"); r.Error != "decrypt_failed" || r.Skipped {
			t.Fatal(r)
		}
		s, _ = build(t, nil, nil, nil)
		if r := s.TestUserSmtp(ctx, "u1", "a@b.c"); r.Error != "tenancy_unavailable" {
			t.Fatal(r)
		}
	})
}

func TestMask(t *testing.T) {
	for in, want := range map[string]string{"alice@example.com": "al***@example.com", "a@x.io": "a***@x.io", "@x": "***", "nope": "***"} {
		if got := mask(in); got != want {
			t.Errorf("%s → %s", in, got)
		}
	}
}

func ptrI(v int64) *int64   { return &v }
func ptrS(v string) *string { return &v }
