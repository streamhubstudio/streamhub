package livecontrol

import (
	"bytes"
	"context"
	"io"
	"mime"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// maxAssetBytes caps a cover asset upload (FileInterceptor limit).
const maxAssetBytes = 50 * 1024 * 1024

// Register implements api.Module (live-control.controller.ts: 12 routes
// under /apps/:app/plugins/live-control).
func (s *Service) Register(a huma.API) {
	base := api.Prefix + "/apps/{app}/plugins/live-control"
	op := func(id, method, path, summary string, status int) *huma.Operation {
		return api.Bearer(&huma.Operation{OperationID: "LiveControlController_" + id, Method: method, Path: base + path,
			Summary: summary, Tags: []string{"live-control"}, DefaultStatus: status})
	}
	perm := func(o *huma.Operation, action string) huma.Operation { return *authz.Require(o, "config", action) }

	type pubIn struct {
		App    string `path:"app"`
		Stream string `query:"stream"`
		Room   string `query:"room"`
	}
	huma.Register(a, *api.Public(op("publicState", http.MethodGet, "/public", "Public live-control state for a stream (anonymous overlay).", 200)),
		func(ctx context.Context, in *pubIn) (*api.Out[api.Envelope[*LCControlView]], error) {
			v, err := s.PublicState(ctx, in.App, in.Stream, in.Room)
			return env(v, err)
		})

	type appIn struct {
		App string `path:"app"`
	}
	huma.Register(a, perm(op("streams", http.MethodGet, "/streams", "Live streams + their live-control state (operator list).", 200), "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*LCStreamList]], error) {
			v, err := s.ListStreams(ctx, in.App)
			return env(v, err)
		})

	type streamIn struct {
		App      string `path:"app"`
		StreamID string `path:"streamId"`
	}
	huma.Register(a, perm(op("stream", http.MethodGet, "/streams/{streamId}", "One stream + its live-control state.", 200), "read"),
		func(ctx context.Context, in *streamIn) (*api.Out[api.Envelope[*LCControlView]], error) {
			v, err := s.GetStream(ctx, in.App, in.StreamID)
			return env(v, err)
		})

	type bodyIn struct {
		App      string `path:"app"`
		StreamID string `path:"streamId"`
		api.RawBodyInput
	}
	transition := func(opName string) func(context.Context, *bodyIn) (*api.Out[api.Envelope[*LCControlView]], error) {
		return func(ctx context.Context, in *bodyIn) (*api.Out[api.Envelope[*LCControlView]], error) {
			o, err := parseOverride(in.RawBody)
			if err != nil {
				return nil, err
			}
			v, err := s.Transition(ctx, in.App, in.StreamID, opName, o)
			return env(v, err)
		}
	}
	huma.Register(a, perm(op("pause", http.MethodPost, "/streams/{streamId}/pause", "Pause a live stream — viewers see the cover; audio muted.", 201), "write"), transition("pause"))
	huma.Register(a, perm(op("resume", http.MethodPost, "/streams/{streamId}/resume", "Resume a paused stream — back to the live feed; audio unmuted.", 201), "write"),
		func(ctx context.Context, in *streamIn) (*api.Out[api.Envelope[*LCControlView]], error) {
			v, err := s.Transition(ctx, in.App, in.StreamID, "resume", Override{})
			return env(v, err)
		})
	huma.Register(a, perm(op("finish", http.MethodPost, "/streams/{streamId}/finish", "Finish a live stream — end with a final card/asset.", 201), "write"), transition("finish"))

	huma.Register(a, perm(op("assets", http.MethodGet, "/assets", "List uploaded cover assets (each with a signed URL).", 200), "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]LCAssetView]], error) {
			v, err := s.ListAssets(ctx, in.App)
			return env(v, err)
		})

	huma.Register(a, perm(op("upload", http.MethodPost, "/assets", "Upload a cover asset (image/* or video/*) to the app S3.", 201), "write"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*LCAssetView]], error) {
			f, label, err := readUpload(api.Request(ctx))
			if err != nil {
				return nil, err
			}
			v, err := s.UploadAsset(ctx, in.App, f, label)
			return env(v, err)
		})

	type idIn struct {
		App string `path:"app"`
		ID  string `path:"id"`
	}
	huma.Register(a, perm(op("assetUrl", http.MethodGet, "/assets/{id}/url", "Fresh signed preview URL for one asset.", 200), "read"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*LCURLView]], error) {
			id, err := api.ParseNumberIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			v, err := s.AssetURL(ctx, in.App, id)
			return env(v, err)
		})
	huma.Register(a, perm(op("deleteAsset", http.MethodDelete, "/assets/{id}", "Delete an asset (db row + S3 object).", 200), "write"),
		func(ctx context.Context, in *idIn) (*api.Out[api.Envelope[*LCRemoved]], error) {
			id, err := api.ParseNumberIntParam(in.ID)
			if err != nil {
				return nil, err
			}
			v, err := s.DeleteAsset(ctx, in.App, id)
			return env(v, err)
		})

	huma.Register(a, perm(op("settings", http.MethodGet, "/settings", "Per-app live-control defaults (static + default assets).", 200), "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*LCSettingsView]], error) {
			v, err := s.GetSettings(ctx, in.App)
			return env(v, err)
		})
	type settingsIn struct {
		App string `path:"app"`
		api.RawBodyInput
	}
	huma.Register(a, perm(op("updateSettings", http.MethodPut, "/settings", "Update the per-app default cover assets (pause/finish).", 200), "write"),
		func(ctx context.Context, in *settingsIn) (*api.Out[api.Envelope[*LCSettingsView]], error) {
			b, err := validate.Parse(in.RawBody)
			if err != nil {
				return nil, err
			}
			b.Optional("defaultPauseAssetId").IsInt()
			b.Optional("defaultFinishAssetId").IsInt()
			if err := b.Err(); err != nil {
				return nil, err
			}
			m := rawMap(in.RawBody)
			p := SettingsPatch{}
			p.Pause, p.SetPause = intField(m, "defaultPauseAssetId")
			p.Finish, p.SetFinish = intField(m, "defaultFinishAssetId")
			v, err := s.UpdateSettings(ctx, in.App, p)
			return env(v, err)
		})
}

func env[T any](v T, err error) (*api.Out[api.Envelope[T]], error) {
	if err != nil {
		return nil, err
	}
	return api.OK(v), nil
}

func rawMap(raw []byte) *y.Map {
	if v, err := y.ParseJSON(raw); err == nil {
		if m, ok := v.(*y.Map); ok {
			return m
		}
	}
	return y.NewMap()
}

// intField: (value, present). A present null clears.
func intField(m *y.Map, k string) (*int64, bool) {
	v, ok := m.Lookup(k)
	if !ok {
		return nil, false
	}
	if f, isNum := v.(float64); isNum {
		i := int64(f)
		return &i, true
	}
	return nil, true
}

func strField(m *y.Map, k string) (*string, bool) {
	v, ok := m.Lookup(k)
	if !ok {
		return nil, false
	}
	if s, isStr := v.(string); isStr {
		return &s, true
	}
	return nil, true
}

// parseOverride validates CoverOverrideDto.
func parseOverride(raw []byte) (Override, error) {
	b, err := validate.Parse(raw)
	if err != nil {
		return Override{}, err
	}
	b.Optional("mode").IsIn("image", "video", "text")
	b.Optional("assetId").IsInt()
	b.Optional("cardTitle").MaxLength(200).IsString()
	b.Optional("cardText").MaxLength(1000).IsString()
	b.Optional("cardColor").MaxLength(32).IsString()
	if err := b.Err(); err != nil {
		return Override{}, err
	}
	m := rawMap(raw)
	var o Override
	o.Mode, o.SetMode = strField(m, "mode")
	o.AssetID, o.SetAsset = intField(m, "assetId")
	o.CardTitle, o.SetTitle = strField(m, "cardTitle")
	o.CardText, o.SetText = strField(m, "cardText")
	o.CardColor, o.SetColor = strField(m, "cardColor")
	return o, nil
}

// readUpload is FileInterceptor('file', 50 MB) + the `label` field (also
// read from a JSON body, as Nest's @Body() would).
func readUpload(r *http.Request) (Upload, *string, error) {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mt != "multipart/form-data" {
		if mt == "application/json" && r.Body != nil {
			raw, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(raw))
			l, _ := strField(rawMap(raw), "label")
			return Upload{}, l, nil
		}
		return Upload{}, nil, nil
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return Upload{}, nil, httpx.BadRequest("Multipart: Boundary not found")
	}
	var up Upload
	var label *string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Upload{}, nil, httpx.BadRequest("Multipart: Unexpected end of form")
		}
		data, err := io.ReadAll(io.LimitReader(part, maxAssetBytes+1))
		if err != nil {
			return Upload{}, nil, httpx.BadRequest(err.Error())
		}
		if part.FileName() != "" {
			if part.FormName() != "file" {
				return Upload{}, nil, httpx.BadRequest("Unexpected field")
			}
			if len(data) > maxAssetBytes {
				return Upload{}, nil, httpx.Nest(http.StatusRequestEntityTooLarge, "File too large")
			}
			up = Upload{Body: data, Filename: part.FileName(), MimeType: part.Header.Get("Content-Type")}
			continue
		}
		if part.FormName() == "label" {
			l := string(data)
			label = &l
		}
	}
	return up, label, nil
}
