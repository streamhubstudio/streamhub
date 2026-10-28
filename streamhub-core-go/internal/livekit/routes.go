package livekit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Module serves the livekit routes (LiveKitController, RoomsController,
// WebhooksController) and GET /stats.
type Module struct {
	svc     *Service
	Auth    *IngressAuth
	Backup  *IngressBackup
	cfg     *config.Config
	apps    contracts.AppsService
	quotas  Quotas
	audit   Auditor
	opt     Optional
	log     *slog.Logger
	stats   *statsSource
	now     func() time.Time
	newUUID func() string
}

// New wires the module (and its Service).
func New(d Deps) *Module {
	svc := NewService(d.Config, d.Clients, d.Log, d.Optional, d.Resolve)
	appDB := func(ctx context.Context, app string) (*sql.DB, error) { return d.Store.App(ctx, app) }
	m := &Module{
		svc: svc, Auth: NewIngressAuth(appDB), Backup: NewIngressBackup(appDB),
		cfg: d.Config, apps: d.Apps, quotas: d.Quotas, audit: d.Audit, opt: d.Optional, log: d.Log,
		now: time.Now, newUUID: uuid.NewString,
	}
	m.stats = newStatsSource(d.Config, d.Store, svc.clients, d.Log)
	return m
}

// Service is the LiveKit SDK wrapper other planes depend on.
func (m *Module) Service() *Service { return m.svc }

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	m.registerTokens(a)
	m.registerIngress(a)
	m.registerData(a)
	m.registerRooms(a)
	m.registerWebhooks(a)
	m.registerStats(a)
}

// corsAnyOrigin is @Header('Access-Control-Allow-Origin', '*') on the public
// token routes: Nest sets it before the handler runs, so errors carry it too.
func corsAnyOrigin(o *huma.Operation) *huma.Operation {
	o.Middlewares = append(o.Middlewares, func(ctx huma.Context, next func(huma.Context)) {
		ctx.SetHeader("Access-Control-Allow-Origin", "*")
		next(ctx)
	})
	return o
}

func op(id, method, path, summary, tag string, status int) *huma.Operation {
	o := api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary, Tags: []string{tag}})
	if status != 0 {
		o.DefaultStatus = status
	}
	return o
}

// ---------------------------------------------------------------------------
// app config helpers (resolved through the apps module; null on any error)
// ---------------------------------------------------------------------------

func (m *Module) appConfig(ctx context.Context, app string) *contracts.AppConfig {
	if m.apps == nil {
		return nil
	}
	cfg, err := m.apps.GetConfig(ctx, app)
	if err != nil {
		return nil
	}
	return cfg
}

func prefixOf(cfg *contracts.AppConfig, app string) string {
	if cfg != nil && cfg.RoomPrefix != "" {
		return cfg.RoomPrefix
	}
	return app
}

// namespaceRoom puts room under prefix (tenant isolation).
func namespaceRoom(prefix, room string) string {
	if room == "" {
		return prefix
	}
	if room == prefix || strings.HasPrefix(room, prefix+"-") {
		return room
	}
	return prefix + "-" + room
}

func (m *Module) resolveRoom(ctx context.Context, app, room string) string {
	return namespaceRoom(prefixOf(m.appConfig(ctx, app), app), room)
}

func (m *Module) publicBase() string {
	return strings.TrimRight(m.cfg.Env("PUBLIC_BASE_URL"), "/")
}

type playerURLs struct {
	WsURL    string `json:"wsUrl"`
	PlayURL  string `json:"playUrl"`
	EmbedURL string `json:"embedUrl"`
	Iframe   string `json:"iframe"`
}

func (m *Module) playerURLs(app, room string) playerURLs {
	base := m.publicBase()
	tail := "/" + jsx.EncodeURIComponent(app) + "/" + jsx.EncodeURIComponent(room)
	play, embed := base+"/play"+tail, base+"/embed"+tail
	return playerURLs{
		WsURL: m.cfg.PublicWsURL, PlayURL: play, EmbedURL: embed,
		Iframe: `<iframe src="` + embed + `" width="640" height="360" frameborder="0" allow="autoplay; fullscreen; camera; microphone" allowfullscreen></iframe>`,
	}
}

func (m *Module) rtmpCfg() RtmpURLConfig {
	return RtmpURLConfig{m.cfg.RtmpPublicHost, m.cfg.RtmpsEnable, m.cfg.RtmpsPublicHost, m.cfg.RtmpsPort}
}

func (m *Module) rtmpURL(key string) string  { return BuildRtmpURL(key, m.rtmpCfg()) }
func (m *Module) rtmpsURL(key string) string { return BuildRtmpsURL(key, m.rtmpCfg()) }

func (m *Module) logWrite(level, source, msg string, meta map[string]any) {
	writeLog(m.opt, m.log, level, source, msg, meta)
}

// parseBody decodes and validates a JSON body with rules.
func parseBody(raw []byte, rules func(*validate.Body)) (*validate.Body, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return nil, err
	}
	rules(b)
	if err := b.Err(); err != nil {
		return nil, err
	}
	return b, nil
}

var roomPattern = regexp.MustCompile(`^[a-zA-Z0-9._\-]+$`)

const roomPatternMessage = "room may only contain letters, numbers, dot, underscore, hyphen"

func optStr(b *validate.Body, name string, max int) {
	b.Optional(name).MaxLength(max).IsString()
}

func optBool(b *validate.Body, names ...string) {
	for _, n := range names {
		b.Optional(n).IsBoolean()
	}
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ---------------------------------------------------------------------------
// Tokens, radio listen-token, public play-token, signed playback URLs
// ---------------------------------------------------------------------------

type appIn struct {
	App string `path:"app"`
}

type appBodyIn struct {
	App     string `path:"app"`
	RawBody []byte
}

type roomQueryIn struct {
	App  string `path:"app"`
	Room string `path:"room"`
	Exp  string `query:"exp"`
	Sig  string `query:"sig"`
}

type roomBodyIn struct {
	App     string `path:"app"`
	Room    string `path:"room"`
	RawBody []byte
}

// MintTokenResult is POST /apps/:app/tokens.data.
type MintTokenResult struct {
	Token     string  `json:"token"`
	App       string  `json:"app"`
	Room      string  `json:"room"`
	Identity  *string `json:"identity,omitempty"`
	Hidden    bool    `json:"hidden"`
	AudioOnly bool    `json:"audioOnly"`
	Adaptive  bool    `json:"adaptive"`
	playerURLs
}

// PublicTokenResult is the play-token / listen-token data.
type PublicTokenResult struct {
	Token string `json:"token"`
	App   string `json:"app"`
	Room  string `json:"room"`
	WsURL string `json:"wsUrl"`
	Mode  string `json:"mode"`
}

type corsOut struct {
	Body api.Data[PublicTokenResult]
}

// SignedPlayback is POST play-token/:room/sign.data.
type SignedPlayback struct {
	App        string `json:"app"`
	Room       string `json:"room"`
	Exp        int64  `json:"exp"`
	TTLSeconds int64  `json:"ttlSeconds"`
	Sig        string `json:"sig"`
	TokenURL   string `json:"tokenUrl"`
	PlayURL    string `json:"playUrl"`
	EmbedURL   string `json:"embedUrl"`
	Iframe     string `json:"iframe"`
}

func mintTokenRules(b *validate.Body) {
	b.Optional("room").Matches(roomPattern, roomPatternMessage).MaxLength(120).IsString()
	optStr(b, "identity", 120)
	optStr(b, "name", 120)
	optBool(b, "canPublish", "canSubscribe")
	optStr(b, "ttl", 20)
	optStr(b, "metadata", 2000)
	optBool(b, "hidden", "recorder", "audioOnly")
}

func (m *Module) registerTokens(a huma.API) {
	huma.Register(a, *authz.Require(op("LiveKitController_mintToken", http.MethodPost, "/apps/{app}/tokens",
		"Mint a LiveKit join token for an app room (+ public/iframe URLs).", "livekit", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *appBodyIn) (*api.Out[api.Data[MintTokenResult]], error) {
			b, err := parseBody(in.RawBody, mintTokenRules)
			if err != nil {
				return nil, err
			}
			res, err := m.MintTokenRoute(ctx, in.App, b, auth.From(ctx))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[MintTokenResult]{Data: *res}), nil
		})

	huma.Register(a, *corsAnyOrigin(api.Public(op("LiveKitController_listenToken", http.MethodGet, "/apps/{app}/radio/{room}/listen-token",
		"Mint a subscribe-only audio token for a radio room (wave-4 §6). Public, for the listener embed.", "livekit", 0))),
		func(ctx context.Context, in *roomQueryIn) (*corsOut, error) {
			res, err := m.publicToken(ctx, in, "listener")
			if err != nil {
				return nil, err
			}
			return &corsOut{Body: api.Data[PublicTokenResult]{Data: *res}}, nil
		})

	huma.Register(a, *corsAnyOrigin(api.Public(op("LiveKitController_playToken", http.MethodGet, "/apps/{app}/play-token/{room}",
		"Mint a subscribe-only (video+audio) token for a room. Public — powers the /play and /embed players. "+
			"Apps with public_playback:false require a signed URL (?exp=&sig=) from POST play-token/:room/sign.", "livekit", 0))),
		func(ctx context.Context, in *roomQueryIn) (*corsOut, error) {
			res, err := m.publicToken(ctx, in, "viewer")
			if err != nil {
				return nil, err
			}
			return &corsOut{Body: api.Data[PublicTokenResult]{Data: *res}}, nil
		})

	huma.Register(a, *authz.Require(op("LiveKitController_signPlaybackUrl", http.MethodPost, "/apps/{app}/play-token/{room}/sign",
		"Mint a signed short-TTL playback capability for a room (P0-3).", "livekit", http.StatusCreated), "stream", "read"),
		func(ctx context.Context, in *roomBodyIn) (*api.Out[api.Data[SignedPlayback]], error) {
			b, err := parseBody(in.RawBody, func(b *validate.Body) {
				b.Optional("ttlSeconds").Max(MaxPlaybackTTL).Min(MinPlaybackTTL).IsInt()
			})
			if err != nil {
				return nil, err
			}
			res, err := m.SignPlaybackURL(in.App, in.Room, b.Float("ttlSeconds"))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[SignedPlayback]{Data: *res}), nil
		})
}

// MintTokenRoute is POST /apps/:app/tokens on a validated body.
func (m *Module) MintTokenRoute(ctx context.Context, app string, b *validate.Body, p *auth.Principal) (*MintTokenResult, error) {
	cfg := m.appConfig(ctx, app)
	room := namespaceRoom(prefixOf(cfg, app), b.String("room"))

	// Hidden QC is gated by the app feature flag; a recorder or hidden
	// participant is subscribe-only unless canPublish is explicit.
	hiddenAllowed := cfg == nil || cfg.Features.HiddenQc
	hidden := boolOr(b.Bool("hidden"), false) && hiddenAllowed
	recorder := boolOr(b.Bool("recorder"), false)
	canPublish := b.Bool("canPublish")
	if canPublish == nil && (recorder || hidden) {
		f := false
		canPublish = &f
	}
	// Quota: a publisher token opens a new live stream slot.
	if canPublish == nil || *canPublish {
		if err := m.quotas.EnforceConcurrentStreams(ctx, p); err != nil {
			return nil, err
		}
		limit := -1.0
		if cfg != nil && cfg.Quotas != nil {
			limit = cfg.Quotas.MaxConcurrentStreams
		}
		if err := m.quotas.EnforceAppConcurrentStreams(ctx, app, limit, p); err != nil {
			return nil, err
		}
	}
	metadata := b.StringPtr("metadata")
	if cfg != nil && cfg.Features.AdaptivePlayer {
		md := withSimulcastHint(metadata, cfg)
		metadata = &md
	}
	audioOnly := boolOr(b.Bool("audioOnly"), false)
	token, err := m.svc.MintToken(MintTokenOptions{
		Room: room, Identity: b.String("identity"), Name: b.String("name"),
		CanPublish: canPublish, CanSubscribe: b.Bool("canSubscribe"),
		TTL: b.String("ttl"), Metadata: strOr(metadata), Hidden: hidden, Recorder: recorder, AudioOnly: audioOnly,
	})
	if err != nil {
		return nil, err
	}
	return &MintTokenResult{
		Token: token, App: app, Room: room, Identity: b.StringPtr("identity"), Hidden: hidden,
		AudioOnly: audioOnly, Adaptive: cfg != nil && cfg.Features.AdaptivePlayer, playerURLs: m.playerURLs(app, room),
	}, nil
}

// withSimulcastHint merges the app simulcast ladder into token metadata under
// the `streamhub` key (non-object / unparsable metadata → {_raw}).
func withSimulcastHint(raw *string, cfg *contracts.AppConfig) string {
	base := yamljs.NewMap()
	if raw != nil && *raw != "" {
		v, err := yamljs.ParseJSON([]byte(*raw))
		if mp, ok := v.(*yamljs.Map); err == nil && ok {
			base = mp
		} else if err == nil && isTruthyObject(v) {
			// arrays spread their indices like Object spread does
			base = spreadArray(v)
		} else {
			base.Set("_raw", *raw)
		}
	}
	layers := make([]any, 0, len(cfg.Webrtc.Layers))
	for _, l := range cfg.Webrtc.Layers {
		lm := yamljs.NewMap()
		lm.Set("name", l.Name)
		lm.Set("height", l.Height)
		layers = append(layers, lm)
	}
	sim := yamljs.NewMap()
	sim.Set("adaptiveStream", true)
	sim.Set("simulcast", true)
	sim.Set("layers", layers)
	sh := yamljs.NewMap()
	sh.Set("simulcast", sim)
	base.Set("streamhub", sh) // an existing key keeps its position (object spread)
	s, _ := yamljs.Stringify(base)
	return s
}

// isTruthyObject: `parsed && typeof parsed === 'object'` for a non-map
// (arrays are objects in JS).
func isTruthyObject(v any) bool { _, ok := v.([]any); return ok }

func spreadArray(v any) *yamljs.Map {
	out := yamljs.NewMap()
	for i, e := range v.([]any) {
		out.Set(fmt.Sprint(i), e)
	}
	return out
}

func (m *Module) publicToken(ctx context.Context, in *roomQueryIn, mode string) (*PublicTokenResult, error) {
	cfg := m.appConfig(ctx, in.App)
	if err := m.assertPlaybackAllowed(cfg, in.App, in.Room, in.Exp, in.Sig); err != nil {
		return nil, err
	}
	room := namespaceRoom(prefixOf(cfg, in.App), in.Room)
	f, t := false, true
	opts := MintTokenOptions{
		Room: room, CanPublish: &f, CanSubscribe: &t, CanPublishData: &f, Hidden: true, TTL: "6h",
	}
	if mode == "listener" {
		opts.Identity = "listener-" + m.newUUID()[:8]
		opts.AudioOnly = true
	} else {
		opts.Identity = "viewer-" + m.newUUID()[:8]
	}
	token, err := m.svc.MintToken(opts)
	if err != nil {
		return nil, err
	}
	return &PublicTokenResult{Token: token, App: in.App, Room: room, WsURL: m.cfg.PublicWsURL, Mode: mode}, nil
}

// assertPlaybackAllowed: public apps pass; private apps need a valid,
// unexpired signature (403 otherwise, never leaking room existence).
func (m *Module) assertPlaybackAllowed(cfg *contracts.AppConfig, app, room, exp, sig string) error {
	if cfg == nil || cfg.Features.PublicPlayback {
		return nil
	}
	switch VerifyPlayback(m.cfg.JWTSecret, app, room, exp, sig, m.now()) {
	case PlaybackOK:
		return nil
	case PlaybackExpired:
		return httpx.Forbidden("signed playback URL expired")
	}
	return httpx.Forbidden("playback for this app requires a valid signed URL")
}

// SignPlaybackURL mints a signed playback capability (+ player URLs).
func (m *Module) SignPlaybackURL(app, room string, ttlSeconds *float64) (*SignedPlayback, error) {
	master := m.cfg.JWTSecret
	if master == "" {
		return nil, httpx.Unavailable("STREAMHUB_JWT_SECRET is required to mint signed playback URLs")
	}
	ttl := ClampPlaybackTTL(ttlSeconds)
	exp := m.now().UnixMilli()/1000 + ttl
	sig := SignPlayback(master, app, room, exp)
	query := fmt.Sprintf("exp=%d&sig=%s", exp, sig)
	base := m.publicBase()
	ea, er := jsx.EncodeURIComponent(app), jsx.EncodeURIComponent(room)
	embed := base + "/embed/" + ea + "/" + er + "?" + query
	return &SignedPlayback{
		App: app, Room: room, Exp: exp, TTLSeconds: ttl, Sig: sig,
		TokenURL: base + "/api/v1/apps/" + ea + "/play-token/" + er + "?" + query,
		PlayURL:  base + "/play/" + ea + "/" + er + "?" + query,
		EmbedURL: embed,
		Iframe: `<iframe src="` + embed + `" width="640" height="360" frameborder="0" ` +
			`allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
	}, nil
}

// errorsAs is errors.As for *httpx.Error.
func errorsAs(err error) (*httpx.Error, bool) {
	var he *httpx.Error
	ok := errors.As(err, &he)
	return he, ok
}
