package passthrough

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// Module serves MediamtxHookController: the loopback-only auth / ready /
// notready sink of the single-port :1935 switch. @Public — the internal-peer
// + shared-secret guard replaces token auth; excluded from the OpenAPI.
type Module struct {
	Svc *Service
	// Guard is allowedPublisherCIDR on publishes (nil = no restriction).
	Guard *PublishGuard
	// Geo applies features.geo (publish:true) to the publisher IP MediaMTX
	// reports (G2); nil = no publish geo-blocking.
	Geo PublishGeo
}

// PublishGeo is playback.Guard's publish check.
type PublishGeo interface {
	CheckPublish(ctx context.Context, app, ip string) error
}

// MediamtxHookOK is the hooks' 200 body.
type MediamtxHookOK struct {
	OK bool `json:"ok"`
}

type hookIn struct {
	Secret  string `header:"X-MediaMTX-Secret"`
	Query   string `query:"secret"`
	RawBody []byte
}

// hookBody is the MediaMTX hook body (action + path, and the publisher ip
// and protocol of the auth hook); a non-object / non-string field reads as
// absent.
type hookBody struct{ action, path, ip, protocol string }

func parseHookBody(raw []byte) hookBody {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return hookBody{}
	}
	a, _ := m["action"].(string)
	p, _ := m["path"].(string)
	ip, _ := m["ip"].(string)
	proto, _ := m["protocol"].(string)
	return hookBody{a, p, ip, proto}
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	reg := func(id, path string, h func(ctx context.Context, b hookBody) error) {
		o := api.Public(&huma.Operation{
			OperationID: id, Method: http.MethodPost, Path: api.Prefix + "/internal/mediamtx/" + path,
			Tags: []string{"internal"}, Hidden: true, DefaultStatus: http.StatusOK,
		})
		// Hidden ops keep an optional body (an empty body reads as {}).
		rb := &huma.RequestBody{}
		o.RequestBody = rb
		huma.Register(a, *o, func(ctx context.Context, in *hookIn) (*api.Out[MediamtxHookOK], error) {
			if err := m.assertInternal(api.Request(ctx), in); err != nil {
				return nil, err
			}
			var body hookBody
			// body-parser only reads JSON bodies; anything else is {}.
			if strings.Contains(strings.ToLower(api.Request(ctx).Header.Get("Content-Type")), "json") {
				body = parseHookBody(in.RawBody)
			}
			if err := h(ctx, body); err != nil {
				return nil, err
			}
			return api.JSON(MediamtxHookOK{true}), nil
		})
		rb.Required = false
	}
	reg("MediamtxHookController_auth", "auth", m.auth)
	reg("MediamtxHookController_ready", "ready", m.ready)
	reg("MediamtxHookController_notready", "notready", m.notready)
}

// auth is authHTTPAddress: reads and the LiveKit plane pass; a passthrough
// publish must carry a minted key, else 401. Either publish is also held to
// the owning app's allowedPublisherCIDR (Guard) against the encoder's ip
// and, with features.geo publish:true, must come from an allowed country
// (401 too: MediaMTX only reads the status). The LiveKit plane's
// `live/<key>` path does not name the app, so its publishes are not
// geo-checked here (documented limit).
//
// E2: an SRT `read` (the core's own ffmpeg pulling an SRT publish off the
// front, which dials 127.0.0.1) passes only from loopback — the SRT
// listener is public, and without this anyone holding a path could read a
// passthrough stream raw.
func (m *Module) auth(ctx context.Context, b hookBody) error {
	if b.action == "read" && b.protocol == "srt" {
		if ip := net.ParseIP(b.ip); ip == nil || !ip.IsLoopback() {
			return httpx.Unauthorized("mediamtx read denied")
		}
		return nil
	}
	if b.action != "" && b.action != "publish" {
		return nil
	}
	cls := ClassifyMediamtxPath(b.path)
	if cls.Kind == PathLivekit {
		if !m.Guard.Allow(ctx, cls, b.ip) {
			return m.deniedSource(cls, b.ip)
		}
		return nil // LiveKit does its own auth
	}
	if cls.Kind == PathPassthrough && m.Svc.AuthorizeKey(ctx, cls.App, cls.Key) {
		if !m.Guard.Allow(ctx, cls, b.ip) {
			return m.deniedSource(cls, b.ip)
		}
		if m.Geo != nil && b.ip != "" {
			if err := m.Geo.CheckPublish(ctx, cls.App, b.ip); err != nil {
				return httpx.Unauthorized("mediamtx publish denied: " + err.Error())
			}
		}
		return nil
	}
	return httpx.Unauthorized("mediamtx publish denied")
}

// deniedSource logs and answers a publish refused by allowedPublisherCIDR
// (the same 401: MediaMTX only relays the status to the encoder).
func (m *Module) deniedSource(cls PathClass, ip string) error {
	m.Svc.log.Warn("mediamtx publish denied: source outside allowedPublisherCidr",
		"plane", cls.Kind, "app", cls.App, "ip", ip)
	return httpx.Unauthorized("mediamtx publish denied")
}

// ready is runOnReady: arm the pull remux / the LiveKit forward.
func (m *Module) ready(ctx context.Context, b hookBody) error {
	switch cls := ClassifyMediamtxPath(b.path); cls.Kind {
	case PathPassthrough:
		m.Svc.HandlePublish(ctx, cls.App, cls.Key, nil)
	case PathLivekit:
		m.Svc.HandleForwardPublish(cls.Key)
	}
	return nil
}

// notready is runOnNotReady: stop the remux (keep the key) / the forward.
func (m *Module) notready(ctx context.Context, b hookBody) error {
	switch cls := ClassifyMediamtxPath(b.path); cls.Kind {
	case PathPassthrough:
		m.Svc.HandleDone(ctx, cls.App, cls.Key)
	case PathLivekit:
		m.Svc.HandleForwardDone(cls.Key)
	}
	return nil
}

// assertInternal: an internal peer (loopback / RFC1918 / link-local — the
// compose bridge) AND the shared secret (header, else ?secret=), constant-
// time compared. An unset secret disables the routes.
func (m *Module) assertInternal(r *http.Request, in *hookIn) error {
	secret := m.Svc.cfg.MediamtxHookSecret
	if secret == "" {
		return httpx.Forbidden("mediamtx hooks disabled (no secret configured)")
	}
	ip := httpx.ClientIP(r)
	if ip == "" || !security.IsPrivateOrLoopback(ip) {
		return httpx.Forbidden("mediamtx hooks are internal-only")
	}
	presented := in.Secret
	if presented == "" {
		presented = in.Query
	}
	if presented == "" || subtle.ConstantTimeCompare([]byte(presented), []byte(secret)) != 1 {
		return httpx.Forbidden("mediamtx hook secret mismatch")
	}
	return nil
}
