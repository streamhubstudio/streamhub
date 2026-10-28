package passthrough

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// Module serves MediamtxHookController: the loopback-only auth / ready /
// notready sink of the single-port :1935 switch. @Public — the internal-peer
// + shared-secret guard replaces token auth; excluded from the OpenAPI.
type Module struct {
	Svc *Service
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

// hookBody is the MediaMTX hook body (only action + path are read); a
// non-object / non-string field reads as absent.
type hookBody struct{ action, path string }

func parseHookBody(raw []byte) hookBody {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return hookBody{}
	}
	a, _ := m["action"].(string)
	p, _ := m["path"].(string)
	return hookBody{a, p}
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
// publish must carry a minted key, else 401.
func (m *Module) auth(ctx context.Context, b hookBody) error {
	if b.action != "" && b.action != "publish" {
		return nil
	}
	cls := ClassifyMediamtxPath(b.path)
	if cls.Kind == PathLivekit {
		return nil // LiveKit does its own auth
	}
	if cls.Kind == PathPassthrough && m.Svc.AuthorizeKey(ctx, cls.App, cls.Key) {
		return nil
	}
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
