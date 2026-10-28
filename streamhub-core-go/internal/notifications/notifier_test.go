package notifications

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/email"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
)

// Ports notifier.service.spec.ts: channel selection (env defaults + per-app
// overrides), the 300s rate limit, isolation, event filter / master switch
// and the per-app log record. HTTP is a recording Poster (no network).

const (
	app        = "live"
	webhook    = "https://discord.com/api/webhooks/1/token"
	envWebhook = "https://discord.com/api/webhooks/env/token"
)

type post struct {
	url  string
	body any
}

type fakePoster struct {
	mu    sync.Mutex
	posts []post
	err   error
}

func (f *fakePoster) PostJSON(_ context.Context, url string, body any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.posts = append(f.posts, post{url, body})
	return f.err
}

func (f *fakePoster) urls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []string{}
	for _, p := range f.posts {
		out = append(out, p.url)
	}
	return out
}

type fakeCallbacks struct {
	mu    sync.Mutex
	calls int
	err   error
}

func (f *fakeCallbacks) Dispatch(context.Context, string, string, any) error {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.err
}

type mailCall struct {
	msg email.Message
	sc  *email.SendContext
}

type fakeMailer struct {
	mu    sync.Mutex
	calls []mailCall
}

func (f *fakeMailer) Send(_ context.Context, msg email.Message, sc *email.SendContext) email.SendResult {
	f.mu.Lock()
	f.calls = append(f.calls, mailCall{msg, sc})
	f.mu.Unlock()
	return email.SendResult{OK: true}
}

type logCall struct {
	app string
	rec any
}

type fakeAppLog struct{ calls []logCall }

func (f *fakeAppLog) Record(app string, rec any) { f.calls = append(f.calls, logCall{app, rec}) }

type harness struct {
	svc    *Service
	poster *fakePoster
	cb     *fakeCallbacks
	mail   *fakeMailer
	log    *fakeAppLog
}

func makeSvc(t *testing.T, cfg config.Config, yaml string) harness {
	t.Helper()
	cfg.DataDir = t.TempDir()
	if yaml != "" {
		dir := filepath.Join(cfg.DataDir, "apps", app)
		_ = os.MkdirAll(dir, 0o755)
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(yaml), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := harness{poster: &fakePoster{}, cb: &fakeCallbacks{}, mail: &fakeMailer{}, log: &fakeAppLog{}}
	h.svc = New(&cfg, h.log, h.poster, h.mail)
	h.svc.SetCallbacks(h.cb)
	return h
}

type nodePayload struct {
	Node string `json:"node"`
}

func TestFanOutFromEnvDefaults(t *testing.T) {
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook, NotifyTelegramBotToken: "123:abc", NotifyTelegramChatID: "999"}, "")
	h.svc.Notify(context.Background(), app, "node.offline", nodePayload{"edge-1"}, nil)
	if h.cb.calls != 1 {
		t.Fatal("callback not dispatched")
	}
	urls := strings.Join(h.poster.urls(), " ")
	if !strings.Contains(urls, envWebhook) || !strings.Contains(urls, "api.telegram.org/bot123:abc/sendMessage") {
		t.Fatal(urls)
	}
	for _, p := range h.poster.posts {
		if p.url == envWebhook {
			if got := p.body.(struct {
				Content string `json:"content"`
			}).Content; got != "**StreamHub: node.offline**\n{\"node\":\"edge-1\"}" {
				t.Fatalf("discord content %q", got)
			}
		}
	}
}

func TestPerAppOverrides(t *testing.T) {
	yaml := "notifications:\n  discord:\n    webhook: " + webhook + "\n  email:\n    enabled: true\n    to: ops@example.com\n"
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, yaml)
	h.svc.Notify(context.Background(), app, "network.threshold_exceeded", map[string]any{"app": app}, nil)
	if urls := h.poster.urls(); !reflect.DeepEqual(urls, []string{webhook}) {
		t.Fatalf("per-app webhook must win: %v", urls)
	}
	if len(h.mail.calls) != 1 || h.mail.calls[0].msg.To != "ops@example.com" || *h.mail.calls[0].sc != (email.SendContext{App: app}) {
		t.Fatalf("%+v", h.mail.calls)
	}
	if m := h.mail.calls[0].msg; m.Subject != "StreamHub: network.threshold_exceeded" || m.Text != "StreamHub: network.threshold_exceeded\n\n{\"app\":\"live\"}" {
		t.Fatalf("%+v", m)
	}
}

func TestRateLimit(t *testing.T) {
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, "")
	now := time.Unix(1_000_000, 0)
	h.svc.now = func() time.Time { return now }
	ctx := context.Background()
	h.svc.Notify(ctx, app, "node.offline", nodePayload{"e1"}, nil)
	h.svc.Notify(ctx, app, "node.offline", nodePayload{"e1"}, nil)
	if h.cb.calls != 1 || len(h.poster.urls()) != 1 {
		t.Fatalf("duplicate not suppressed: %d %v", h.cb.calls, h.poster.urls())
	}
	h.svc.Notify(ctx, app, "node.offline", nodePayload{"e2"}, &Options{RateKey: "e2"})
	if h.cb.calls != 2 {
		t.Fatal("distinct rateKey suppressed")
	}
	if rec := h.log.calls[1].rec.(notifyRecord); !reflect.DeepEqual(rec.Suppressed, []Channel{"callback", "discord"}) || len(rec.Sent) != 0 {
		t.Fatalf("suppressed record: %+v", rec)
	}
	now = now.Add(RateLimit)
	h.svc.Notify(ctx, app, "node.offline", nodePayload{"e1"}, nil)
	if h.cb.calls != 3 {
		t.Fatal("window must reopen after 300s")
	}
}

func TestIsolation(t *testing.T) {
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, "notifications:\n  email:\n    enabled: true\n    to: ops@example.com\n")
	h.poster.err = errors.New("discord down")
	h.cb.err = errors.New("callback down")
	h.svc.Notify(context.Background(), app, "node.offline", nodePayload{"e1"}, nil)
	if h.cb.calls != 1 || len(h.mail.calls) != 1 || len(h.poster.urls()) != 1 {
		t.Fatal("a failing channel broke the others")
	}
}

func TestFilterAndMasterSwitch(t *testing.T) {
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, "notifications:\n  events: [node.online]\n")
	h.svc.Notify(context.Background(), app, "node.offline", map[string]any{}, nil)
	if h.cb.calls != 0 || len(h.poster.urls()) != 0 || len(h.log.calls) != 0 {
		t.Fatal("filtered event fanned out")
	}
	h.svc.Notify(context.Background(), app, "node.online", map[string]any{}, nil)
	if h.cb.calls != 1 {
		t.Fatal("listed event not delivered")
	}
	h = makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, "notifications:\n  enabled: false\n")
	h.svc.Notify(context.Background(), app, "node.offline", map[string]any{}, nil)
	if h.cb.calls != 0 {
		t.Fatal("master switch ignored")
	}
}

func TestChannelRestrictionAndDisable(t *testing.T) {
	yaml := "notifications:\n  callback:\n    enabled: false\n  telegram:\n    bot_token: ' t '\n    chat_id: 7\n"
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, yaml)
	h.svc.Notify(context.Background(), app, "x", nil, &Options{Channels: []Channel{ChannelTelegram}, Title: "T"})
	if h.cb.calls != 0 {
		t.Fatal("callback disabled per app")
	}
	urls := h.poster.urls()
	// chat_id: 7 is a number in YAML → asString → "" → env default "" → off.
	if len(urls) != 0 {
		t.Fatalf("numeric chat_id must not enable telegram: %v", urls)
	}
	if got := h.svc.ChannelsFor(app); got != (ChannelsEnabled{Discord: true}) {
		t.Fatalf("%+v", got)
	}
}

func TestAppLogRecord(t *testing.T) {
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook}, "")
	h.svc.Notify(context.Background(), app, "node.offline", nodePayload{"e1"}, nil)
	if len(h.log.calls) != 1 || h.log.calls[0].app != app {
		t.Fatal(h.log.calls)
	}
	rec := h.log.calls[0].rec.(notifyRecord)
	if rec.Source != "notify" || rec.Event != "node.offline" || rec.Key != "node.offline" ||
		!reflect.DeepEqual(rec.Sent, []Channel{"callback", "discord"}) || len(rec.Suppressed) != 0 {
		t.Fatalf("%+v", rec)
	}
}

func TestNotifyGlobal(t *testing.T) {
	h := makeSvc(t, config.Config{NotifyDiscordWebhook: envWebhook, NotifyTelegramBotToken: "b", NotifyTelegramChatID: "c"}, "")
	ctx := context.Background()
	h.svc.NotifyGlobal(ctx, "node.offline", nodePayload{"e1"}, &Options{RateKey: "node.offline:e1"})
	h.svc.NotifyGlobal(ctx, "node.offline", nodePayload{"e1"}, &Options{RateKey: "node.offline:e1"})
	if n := len(h.poster.urls()); n != 2 || h.cb.calls != 0 || len(h.log.calls) != 0 {
		t.Fatalf("global fan-out: %d posts", n)
	}
}

func TestSummarize(t *testing.T) {
	long := strings.Repeat("é", 2000)
	got := summarize(map[string]string{"k": long})
	if !strings.HasSuffix(got, "…") || len([]rune(got)) != 1501 {
		t.Fatalf("len %d", len([]rune(got)))
	}
	if summarize(nil) != "{}" {
		t.Fatal("nil payload")
	}
}
