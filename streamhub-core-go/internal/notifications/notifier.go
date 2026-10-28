// Package notifications ports modules/notifications: the notifier fan-out
// (Vision-Edge §H). One Notify fans an event out to callback+MQTT, email,
// Discord and Telegram — the channels enabled by merging the global env
// defaults with the app's `notifications:` config.yaml block. Channels are
// isolated, rate-limited per (app, channel, key) for 300s, and every notify
// is recorded in the app's rotated app.log. Nothing here returns an error.
package notifications

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/email"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	// RateLimit is the per-(app,channel,key) window.
	RateLimit = 300 * time.Second
	// HTTPTimeout bounds one Discord/Telegram call.
	HTTPTimeout = 5 * time.Second
	// rateMapPruneAt prunes the rate map past this many entries.
	rateMapPruneAt = 5000
)

// Channel is callback | email | discord | telegram.
type Channel = string

const (
	ChannelCallback Channel = "callback"
	ChannelEmail    Channel = "email"
	ChannelDiscord  Channel = "discord"
	ChannelTelegram Channel = "telegram"
)

// Options are NotifyOptions.
type Options struct {
	// RateKey dedupes within (app, channel); default the event name.
	RateKey string
	// Title is the chat/email summary line (default "StreamHub: <event>").
	Title string
	// Channels restricts the fan-out (nil = every configured channel).
	Channels []Channel
}

// Callbacks is the callback+MQTT funnel (CallbacksService.dispatch).
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Mailer is the email channel (EmailService.send).
type Mailer interface {
	Send(ctx context.Context, msg email.Message, sc *email.SendContext) email.SendResult
}

// AppLog is the per-app rotated sink (AppLogService.appLog).
type AppLog interface {
	Record(app string, rec any)
}

// Poster POSTs a JSON body (fetch with an abort timeout).
type Poster interface {
	PostJSON(ctx context.Context, url string, body any) error
}

// HTTPPoster is the real Poster.
type HTTPPoster struct{ Client *http.Client }

// PostJSON implements Poster; the response status is not checked (as fetch).
func (p HTTPPoster) PostJSON(ctx context.Context, url string, body any) error {
	raw, err := jsx.Stringify(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, HTTPTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBufferString(raw))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	c := p.Client
	if c == nil {
		c = http.DefaultClient
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	return res.Body.Close()
}

// Service is NotifierService.
type Service struct {
	cfg    *config.Config
	appLog AppLog
	poster Poster
	now    func() time.Time

	mu        sync.Mutex
	email     Mailer    // optional
	callbacks Callbacks // optional
	lastSent  map[string]time.Time
}

// New builds the notifier; email/callbacks are optional (late-bindable).
func New(cfg *config.Config, appLog AppLog, poster Poster, mailer Mailer) *Service {
	return &Service{cfg: cfg, appLog: appLog, poster: poster, email: mailer, now: time.Now, lastSent: map[string]time.Time{}}
}

// SetCallbacks late-binds the callbacks funnel.
func (s *Service) SetCallbacks(c Callbacks) {
	s.mu.Lock()
	s.callbacks = c
	s.mu.Unlock()
}

type notifyRecord struct {
	Source     string    `json:"source"`
	Event      string    `json:"event"`
	Key        string    `json:"key"`
	Sent       []Channel `json:"sent"`
	Suppressed []Channel `json:"suppressed"`
}

// Notify fans event out to every configured, non-rate-limited channel of
// app and waits for all of them (each failure isolated).
func (s *Service) Notify(ctx context.Context, app, event string, payload any, opts *Options) {
	cfg, ok := s.resolve(app)
	if !ok || !cfg.enabled || !eventPasses(event, cfg.events) {
		return
	}
	if opts == nil {
		opts = &Options{}
	}
	key := rateKey(event, opts)
	s.mu.Lock()
	callbacks, mailer := s.callbacks, s.email
	s.mu.Unlock()

	sent, suppressed := []Channel{}, []Channel{}
	var tasks []func()
	consider := func(ch Channel, active bool, run func() error) {
		if !active || !wants(opts, ch) {
			return
		}
		if s.rateLimited(app, ch, key) {
			suppressed = append(suppressed, ch)
			return
		}
		sent = append(sent, ch)
		tasks = append(tasks, func() { safe(run) })
	}
	consider(ChannelCallback, cfg.callback && callbacks != nil, func() error {
		return callbacks.Dispatch(ctx, app, event, payload)
	})
	consider(ChannelEmail, cfg.emailEnabled && mailer != nil, func() error {
		subject := title(event, opts)
		mailer.Send(ctx, email.Message{To: cfg.emailTo, Subject: subject, Text: subject + "\n\n" + summarize(payload)}, &email.SendContext{App: app})
		return nil
	})
	consider(ChannelDiscord, cfg.discordEnabled, func() error {
		return s.sendDiscord(ctx, cfg.discordWebhook, event, payload, opts)
	})
	consider(ChannelTelegram, cfg.telegramEnabled, func() error {
		return s.sendTelegram(ctx, cfg.botToken, cfg.chatID, event, payload, opts)
	})

	if len(sent) > 0 || len(suppressed) > 0 {
		s.appLog.Record(app, notifyRecord{"notify", event, key, sent, suppressed})
	}
	run(tasks)
}

// NotifyGlobal is the app-less fan-out for cluster-scope events: only the
// env-configured Discord/Telegram channels, rate-limited under '_cluster'.
func (s *Service) NotifyGlobal(ctx context.Context, event string, payload any, opts *Options) {
	if opts == nil {
		opts = &Options{}
	}
	key := rateKey(event, opts)
	var tasks []func()
	consider := func(ch Channel, active bool, fn func() error) {
		if !active || !wants(opts, ch) || s.rateLimited("_cluster", ch, key) {
			return
		}
		tasks = append(tasks, func() { safe(fn) })
	}
	consider(ChannelDiscord, s.cfg.NotifyDiscordWebhook != "", func() error {
		return s.sendDiscord(ctx, s.cfg.NotifyDiscordWebhook, event, payload, opts)
	})
	consider(ChannelTelegram, s.cfg.NotifyTelegramBotToken != "" && s.cfg.NotifyTelegramChatID != "", func() error {
		return s.sendTelegram(ctx, s.cfg.NotifyTelegramBotToken, s.cfg.NotifyTelegramChatID, event, payload, opts)
	})
	run(tasks)
}

// ChannelsEnabled are the booleans the pipeline diagram shows (never the
// secrets behind them).
type ChannelsEnabled struct {
	Email    bool `json:"email"`
	Discord  bool `json:"discord"`
	Telegram bool `json:"telegram"`
}

// ChannelsFor reports which fan-out channels resolve as enabled for app.
func (s *Service) ChannelsFor(app string) ChannelsEnabled {
	cfg, ok := s.resolve(app)
	if !ok {
		return ChannelsEnabled{}
	}
	on := cfg.enabled
	return ChannelsEnabled{Email: on && cfg.emailEnabled, Discord: on && cfg.discordEnabled, Telegram: on && cfg.telegramEnabled}
}

func (s *Service) sendDiscord(ctx context.Context, webhook, event string, payload any, opts *Options) error {
	content := "**" + title(event, opts) + "**\n" + summarize(payload)
	return s.poster.PostJSON(ctx, webhook, struct {
		Content string `json:"content"`
	}{content})
}

func (s *Service) sendTelegram(ctx context.Context, botToken, chatID, event string, payload any, opts *Options) error {
	text := title(event, opts) + "\n" + summarize(payload)
	return s.poster.PostJSON(ctx, "https://api.telegram.org/bot"+botToken+"/sendMessage", struct {
		ChatID string `json:"chat_id"`
		Text   string `json:"text"`
	}{chatID, text})
}

// rateLimited reports whether (app,channel,key) fired within the window,
// recording the send otherwise.
func (s *Service) rateLimited(app string, ch Channel, key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if len(s.lastSent) > rateMapPruneAt {
		for k, t := range s.lastSent {
			if now.Sub(t) >= RateLimit {
				delete(s.lastSent, k)
			}
		}
	}
	k := app + "::" + ch + "::" + key
	if last, ok := s.lastSent[k]; ok && now.Sub(last) < RateLimit {
		return true
	}
	s.lastSent[k] = now
	return false
}

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

type resolved struct {
	enabled         bool
	events          []string
	callback        bool
	emailEnabled    bool
	emailTo         string
	discordEnabled  bool
	discordWebhook  string
	telegramEnabled bool
	botToken        string
	chatID          string
}

// resolve merges the env defaults with the app's notifications: block.
func (s *Service) resolve(app string) (resolved, bool) {
	block := s.readBlock(app)
	r := resolved{enabled: block.Get("enabled") != false, events: asStringArray(block.Get("events"))}
	if len(r.events) == 0 {
		r.events = []string{"all"}
	}
	discord := asObject(block.Get("discord"))
	r.discordWebhook = orDefault(asString(discord.Get("webhook")), s.cfg.NotifyDiscordWebhook)
	telegram := asObject(block.Get("telegram"))
	r.botToken = orDefault(asString(telegram.Get("bot_token")), s.cfg.NotifyTelegramBotToken)
	r.chatID = orDefault(asString(telegram.Get("chat_id")), s.cfg.NotifyTelegramChatID)
	mail := asObject(block.Get("email"))
	callback := asObject(block.Get("callback"))

	r.callback = callback.Get("enabled") != false
	r.emailTo = asString(mail.Get("to"))
	r.emailEnabled = mail.Get("enabled") == true && r.emailTo != ""
	r.discordEnabled = discord.Get("enabled") != false && r.discordWebhook != ""
	r.telegramEnabled = telegram.Get("enabled") != false && r.botToken != "" && r.chatID != ""
	return r, true
}

// readBlock reads notifications: from the raw config.yaml (missing or
// unparseable → {}: global defaults only).
func (s *Service) readBlock(app string) *yamljs.Map {
	raw, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "apps", app, "config.yaml"))
	if err != nil {
		return yamljs.NewMap()
	}
	parsed, err := yamljs.Load(string(raw))
	if err != nil {
		return yamljs.NewMap()
	}
	m, ok := parsed.(*yamljs.Map)
	if !ok {
		return yamljs.NewMap()
	}
	return asObject(m.Get("notifications"))
}

func asObject(v any) *yamljs.Map {
	if m, ok := v.(*yamljs.Map); ok {
		return m
	}
	return yamljs.NewMap()
}

func asString(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return yamljs.Trim(s)
}

func asStringArray(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, x := range arr {
		if s := yamljs.Trim(yamljs.ToString(x)); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func orDefault(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

func eventPasses(event string, events []string) bool {
	if len(events) == 0 {
		return true
	}
	for _, e := range events {
		if e == "all" || e == event {
			return true
		}
	}
	return false
}

func rateKey(event string, opts *Options) string {
	k := opts.RateKey
	if k == "" {
		k = event
	}
	if k = yamljs.Trim(k); k == "" {
		return event
	}
	return k
}

func wants(opts *Options, ch Channel) bool {
	if opts.Channels == nil {
		return true
	}
	for _, c := range opts.Channels {
		if c == ch {
			return true
		}
	}
	return false
}

func title(event string, opts *Options) string {
	if opts.Title != "" {
		return opts.Title
	}
	return "StreamHub: " + event
}

// summarize is the payload as compact JSON, cut at 1500 UTF-16 units + "…".
func summarize(payload any) string {
	if payload == nil {
		return "{}"
	}
	j, err := jsx.Stringify(payload)
	if err != nil || j == "null" {
		return "{}"
	}
	if jsx.UTF16Len(j) > 1500 {
		return jsx.UTF16Slice(j, 1500) + "…"
	}
	return j
}

// safe runs a channel send, swallowing errors and panics (isolation).
func safe(fn func() error) {
	defer func() { _ = recover() }()
	_ = fn()
}

func run(tasks []func()) {
	var wg sync.WaitGroup
	for _, t := range tasks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			t()
		}()
	}
	wg.Wait()
}
