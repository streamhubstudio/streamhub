package playback

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/web"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// Apps is the slice of the apps service the guard reads.
type Apps interface {
	GetConfig(ctx context.Context, name string) (*contracts.AppConfig, error)
	AppDir(name string) string
}

// Options configure a Guard.
type Options struct {
	Apps Apps
	// Secret is the server secret the HLS token key is derived from
	// (STREAMHUB_JWT_SECRET through DeriveKey — never used raw).
	Secret string
	// Geo is the country base (STREAMHUB_GEOIP_DB); nil turns geo off.
	Geo CountryLookup
	Log *slog.Logger
}

// policyTTL bounds how long a config change takes to reach /hls: every
// segment request consults the policy, so it is cached per app instead of
// resolving config.yaml each time.
const policyTTL = 3 * time.Second

// policy is the per-app access state /hls and the token routes need.
type policy struct {
	private  bool
	ttl      int64
	geo      *contracts.GeoFeatures
	playAuth *contracts.PlayAuthFeatures
	secret   string // callbacks.secret (signs the play-auth webhook)
}

type cachedPolicy struct {
	p  policy
	at time.Time
}

// Guard enforces signed HLS, geo-blocking and the play-auth webhook.
type Guard struct {
	apps Apps
	key  []byte
	geo  CountryLookup
	log  *slog.Logger

	now     func() time.Time
	client  *http.Client
	resolve security.HostResolver

	mu     sync.Mutex
	cache  map[string]cachedPolicy
	warned map[string]bool
}

// New builds the guard.
func New(o Options) *Guard {
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	return &Guard{
		apps: o.Apps, key: DeriveKey(o.Secret), geo: o.Geo, log: log,
		now: time.Now, client: noRedirectClient(), resolve: security.DefaultHostResolver,
		cache: map[string]cachedPolicy{}, warned: map[string]bool{},
	}
}

// GeoEnabled reports whether a country base is loaded.
func (g *Guard) GeoEnabled() bool { return g.geo != nil }

// appExists is a stat of apps/<app>/: an unknown app never reaches the
// registry (and never grows the policy cache) — its files do not exist
// either, so /hls answers the plain 404.
func (g *Guard) appExists(app string) bool {
	if app == "" || strings.HasPrefix(app, ".") || strings.ContainsAny(app, `/\`) {
		return false
	}
	st, err := os.Stat(g.apps.AppDir(app))
	return err == nil && st.IsDir()
}

// policy returns the cached access state of an app (errors are not cached).
func (g *Guard) policy(ctx context.Context, app string) (policy, error) {
	now := g.now()
	g.mu.Lock()
	c, ok := g.cache[app]
	g.mu.Unlock()
	if ok && now.Sub(c.at) < policyTTL {
		return c.p, nil
	}
	cfg, err := g.apps.GetConfig(ctx, app)
	if err != nil {
		return policy{}, err
	}
	p := policy{
		private:  !cfg.Features.PublicPlayback,
		ttl:      TTLOr(cfg.Features.HlsTokenTTLSeconds),
		geo:      cfg.Features.Geo,
		playAuth: cfg.Features.PlayAuth,
		secret:   cfg.Callbacks.Secret,
	}
	g.mu.Lock()
	g.cache[app] = cachedPolicy{p: p, at: now}
	g.mu.Unlock()
	return p, nil
}

// Invalidate drops an app's cached policy (after a config write).
func (g *Guard) Invalidate(app string) {
	g.mu.Lock()
	delete(g.cache, app)
	g.mu.Unlock()
}

// checkGeo applies features.geo; without a base the feature is off and the
// operator is told once per app.
func (g *Guard) checkGeo(app string, p policy, ip string) GeoVerdict {
	if !p.geo.Active() {
		return GeoVerdict{Allowed: true}
	}
	if g.geo == nil {
		g.mu.Lock()
		first := !g.warned[app]
		g.warned[app] = true
		g.mu.Unlock()
		if first {
			g.log.Warn("features.geo is configured but STREAMHUB_GEOIP_DB is not loaded — geo-blocking is OFF for this app", "app", app)
		}
		return GeoVerdict{Allowed: true}
	}
	return CheckGeo(g.geo, p.geo, ip)
}

// Messages of the denials (403).
const (
	msgHLSToken    = "HLS playback for this app requires a valid token (?st=)"
	msgHLSExpired  = "HLS token expired"
	msgHLSConfig   = "HLS playback is unavailable for this app"
	msgGeoBlocked  = "playback is not available in your region"
	msgPublishGeo  = "publishing is not available from your region"
	msgPlayAuthNok = "playback denied by the app's authorization webhook"
)

func denied(code, msg string) web.HLSDecision {
	return web.HLSDecision{Status: http.StatusForbidden, Code: code, Message: msg}
}

// AuthorizeHLS implements web.HLSGate for /hls/<app>/<dir>/… (and the
// direct-serve /hls-auth subrequest): geo first, then — private apps only —
// the ?st= token bound to (app, dir). A config that cannot be read fails
// closed: the app's privacy is unknown.
func (g *Guard) AuthorizeHLS(r *http.Request, app, dir string) web.HLSDecision {
	if !g.appExists(app) {
		return web.HLSDecision{}
	}
	p, err := g.policy(r.Context(), app)
	if err != nil {
		g.log.Warn("hls: app config unavailable, denying", "app", app, "error", err.Error())
		return denied("forbidden", msgHLSConfig)
	}
	if v := g.checkGeo(app, p, httpx.ClientIP(r)); !v.Allowed {
		return denied("geo_blocked", msgGeoBlocked)
	}
	if !p.private {
		return web.HLSDecision{}
	}
	st := strings.TrimSpace(r.URL.Query().Get(web.HLSTokenParam))
	switch VerifyHLS(g.key, app, dir, st, g.now()) {
	case TokenOK:
		return web.HLSDecision{Private: true, Token: st}
	case TokenExpired:
		return denied("forbidden", msgHLSExpired)
	}
	return denied("forbidden", msgHLSToken)
}

var _ web.HLSGate = (*Guard)(nil)

// EdgeCacheable reports whether an app's /hls may be handed to a shared
// cache that serves hits without asking the core (a cdn-edge, STREAMHUB_HLS_
// EDGE_SELECT): only a public app without enforced geo rules — a private
// app's segments need the ?st= check and a geo rule the viewer's IP, on
// every request (geo rules without a loaded base enforce nothing). An unknown
// app or an unreadable config is not.
func (g *Guard) EdgeCacheable(ctx context.Context, app string) bool {
	if !g.appExists(app) {
		return false
	}
	p, err := g.policy(ctx, app)
	return err == nil && !p.private && !(p.geo.Active() && g.geo != nil)
}

// HLSGrant is a minted HLS token (Required=false: the app is public and its
// /hls needs none — Token is then "").
type HLSGrant struct {
	Required   bool   `json:"required"`
	Token      string `json:"st"`
	Exp        int64  `json:"exp"`
	TTLSeconds int64  `json:"ttlSeconds"`
}

// MintHLS mints the token for one room dir of a private app, valid for the
// app's TTL. A private app with no server secret cannot mint (503).
func (g *Guard) MintHLS(ctx context.Context, app, dir string) (HLSGrant, error) {
	p, err := g.policy(ctx, app)
	if err != nil {
		return HLSGrant{}, err
	}
	if !p.private {
		return HLSGrant{}, nil
	}
	if len(g.key) == 0 {
		return HLSGrant{}, httpx.Unavailable("STREAMHUB_JWT_SECRET is required to mint HLS tokens")
	}
	exp := g.now().Unix() + p.ttl
	return HLSGrant{Required: true, Token: SignHLS(g.key, app, dir, exp), Exp: exp, TTLSeconds: p.ttl}, nil
}

// HLSTokenFor is MintHLS for the playlistUrl the core hands out: "" for a
// public app, and "" (logged) when the token cannot be minted — the player
// then gets the 403 that explains it.
func (g *Guard) HLSTokenFor(ctx context.Context, app, dir string) string {
	grant, err := g.MintHLS(ctx, app, dir)
	if err != nil {
		g.log.Warn("hls: cannot mint the playlist token", "app", app, "error", err.Error())
		return ""
	}
	return grant.Token
}

// PlaybackRequest is one anonymous playback grant to check.
type PlaybackRequest struct {
	App  string
	Room string
	Mode string // viewer | listener | hls
	// Token is the viewer's own ?token= (forwarded to the webhook).
	Token string
	// Req is the inbound request (client IP, User-Agent, Referer).
	Req *http.Request
}

// CheckPlayback runs geo and the play-auth webhook for a playback grant
// (public play-token, listen-token, HLS token). 403 when denied.
func (g *Guard) CheckPlayback(ctx context.Context, in PlaybackRequest) error {
	p, err := g.policy(ctx, in.App)
	if err != nil {
		return nil // the caller already resolved the app; nothing more to enforce
	}
	r := in.Req
	if r == nil {
		r = &http.Request{Header: http.Header{}}
	}
	ip := httpx.ClientIP(r)
	geo := g.checkGeo(in.App, p, ip)
	if !geo.Allowed {
		return httpx.Forbidden(msgGeoBlocked)
	}
	if p.playAuth == nil {
		return nil
	}
	if geo.Country == "" {
		geo.Country, _ = countryOf(g.geo, ip)
	}
	err = g.callPlayAuth(ctx, p.playAuth, p.secret, PlayAuthRequest{
		Event: PlayAuthEvent, App: in.App, Room: in.Room, Mode: in.Mode, IP: ip, Country: geo.Country,
		UserAgent: r.Header.Get("User-Agent"), Referer: r.Header.Get("Referer"), Token: in.Token,
		Ts: jsx.ISO(g.now()),
	})
	if err == nil {
		return nil
	}
	if !errors.Is(err, errPlayAuthDenied) {
		g.log.Warn("play-auth webhook failed", "app", in.App, "failOpen", p.playAuth.FailOpen, "error", err.Error())
		if p.playAuth.FailOpen {
			return nil
		}
	}
	return httpx.Forbidden(msgPlayAuthNok)
}

// CheckPublish applies features.geo (with publish:true) to a publisher IP
// (the RTMP publishes the MediaMTX front hands to the core). 403-style error
// when blocked, nil otherwise (unknown app included: the caller decides).
func (g *Guard) CheckPublish(ctx context.Context, app, ip string) error {
	if !g.appExists(app) {
		return nil
	}
	p, err := g.policy(ctx, app)
	if err != nil || p.geo == nil || !p.geo.Publish {
		return nil
	}
	if v := g.checkGeo(app, p, ip); !v.Allowed {
		return httpx.Forbidden(msgPublishGeo)
	}
	return nil
}
