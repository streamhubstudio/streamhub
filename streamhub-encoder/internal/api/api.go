// Package api is encoderd's local REST API (/api/v1, OpenAPI at
// /api/v1/docs), the Prometheus endpoint and the embedded web UI.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/caps"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/metrics"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/pipeline"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/presets"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/streamhub"
)

// Manager is the channel runtime the API drives.
type Manager interface {
	Sync(id string)
	SyncAll()
	RestartEngine(id string) bool
	RestartOutput(ch, out string) bool
	Logs(ch, proc string) ([]string, bool)
	Status() []channel.ChannelStatus
	ChannelStatusByID(id string) (channel.ChannelStatus, bool)
}

// Pairing is the StreamHub device-plane service.
type Pairing interface {
	State() streamhub.PairState
	StartPairing(ctx context.Context, baseURL string) (streamhub.PairState, error)
	Unpair() error
}

// Server holds the API dependencies.
type Server struct {
	Store     *config.Store
	Manager   Manager
	Caps      func() *caps.Report
	Pairing   Pairing
	Version   string
	Auth      *auth.Auth // users/roles/tokens/sessions + audit (internal/auth)
	Notifier  Notifier   // alarm notifications (nil = not configured)
	Web       fs.FS
	StartedAt time.Time
}

type out[T any] struct{ Body T }

type idIn struct {
	ID string `path:"id" maxLength:"32"`
}

type idRawIn struct {
	ID      string `path:"id" maxLength:"32"`
	RawBody []byte
}

type rawIn struct{ RawBody []byte }

type outIn struct {
	ID  string `path:"id" maxLength:"32"`
	OID string `path:"oid" maxLength:"32"`
}

type outRawIn struct {
	ID      string `path:"id" maxLength:"32"`
	OID     string `path:"oid" maxLength:"32"`
	RawBody []byte
}

type logsIn struct {
	ID   string `path:"id" maxLength:"32"`
	Proc string `query:"proc" maxLength:"32"`
}

// ChannelView = config (redacted) + live status.
type ChannelView struct {
	Config config.Channel        `json:"config"`
	Status channel.ChannelStatus `json:"status"`
}

func add[I, O any](a huma.API, method, path, id, summary string, status int, h func(context.Context, *I) (*O, error)) {
	huma.Register(a, huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, DefaultStatus: status, Tags: []string{strings.Split(strings.TrimPrefix(path, "/api/v1/"), "/")[0]}}, h)
}

// Handler builds the full HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	cfg := huma.DefaultConfig("StreamHub Encoder API", s.Version)
	cfg.OpenAPIPath = "/api/v1/openapi"
	cfg.DocsPath = "/api/v1/docs"
	cfg.SchemasPath = "/api/v1/schemas"
	cfg.Info.Description = "Local control API of encoderd (StreamHub Encoder). Bearer token required (see README)."
	a := humago.New(mux, cfg)
	s.register(a)
	if _, ok := s.Manager.(ProManager); ok {
		s.registerPro(a, mux)
	}
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		metrics.Write(w, s.Version, s.Manager.Status())
	})
	if s.Web != nil {
		mux.Handle("GET /", http.FileServerFS(s.Web))
	}
	s.Auth.Register(mux)
	return s.Auth.Middleware(nosniff(mux))
}

func nosniff(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// validationError maps config errors to a 422 with per-field details.
func validationError(err error) error {
	var ve config.Errors
	if errors.As(err, &ve) {
		details := make([]error, len(ve))
		for i, fe := range ve {
			details[i] = &huma.ErrorDetail{Location: fe.Field, Message: fe.Message}
		}
		return huma.Error422UnprocessableEntity("invalid configuration", details...)
	}
	var nf notFound
	if errors.As(err, &nf) {
		return huma.Error404NotFound(string(nf))
	}
	var cf conflict
	if errors.As(err, &cf) {
		return huma.Error409Conflict(string(cf))
	}
	var br badRequest
	if errors.As(err, &br) {
		return huma.Error400BadRequest(string(br))
	}
	return huma.Error500InternalServerError(err.Error())
}

type notFound string

func (e notFound) Error() string { return string(e) }

type conflict string

func (e conflict) Error() string { return string(e) }

type badRequest string

func (e badRequest) Error() string { return string(e) }

func (s *Server) view(id string) (ChannelView, error) {
	c := s.Store.Get()
	i := c.FindChannel(id)
	if i < 0 {
		return ChannelView{}, notFound("channel " + id + " not found")
	}
	ch := c.Channels[i]
	config.RedactChannel(&ch)
	st, _ := s.Manager.ChannelStatusByID(id)
	return ChannelView{Config: ch, Status: st}, nil
}

func decodeStrict(raw []byte, v any) error {
	if len(raw) == 0 {
		return badRequest("request body required")
	}
	// Bodies copied from our own GET answers carry huma's "$schema" link.
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) == nil {
		if _, ok := top["$schema"]; ok {
			delete(top, "$schema")
			raw, _ = json.Marshal(top)
		}
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return badRequest("invalid JSON: " + err.Error())
	}
	return nil
}

func (s *Server) register(a huma.API) {
	add(a, http.MethodGet, "/api/v1/health", "health", "Liveness (no auth).", 0,
		func(ctx context.Context, _ *struct{}) (*out[map[string]any], error) {
			return &out[map[string]any]{Body: map[string]any{"status": "ok", "version": s.Version}}, nil
		})

	add(a, http.MethodGet, "/api/v1/system", "system-info", "Box information.", 0,
		func(ctx context.Context, _ *struct{}) (*out[map[string]any], error) {
			c := s.Store.Get()
			host, _ := os.Hostname()
			return &out[map[string]any]{Body: map[string]any{"version": s.Version, "hostname": host, "device": c.Device,
				"cpus": runtime.NumCPU(), "go": runtime.Version(), "uptimeSeconds": int64(time.Since(s.StartedAt).Seconds()),
				"channels": len(c.Channels)}}, nil
		})

	add(a, http.MethodGet, "/api/v1/system/capabilities", "system-capabilities", "Encoders, inputs and devices available on this host.", 0,
		func(ctx context.Context, _ *struct{}) (*out[*caps.Report], error) {
			return &out[*caps.Report]{Body: s.Caps()}, nil
		})

	add(a, http.MethodGet, "/api/v1/channels", "channels-list", "List channels with live status.", 0,
		func(ctx context.Context, _ *struct{}) (*out[[]ChannelView], error) {
			c := s.Store.Get()
			views := make([]ChannelView, 0, len(c.Channels))
			for _, ch := range c.Channels {
				v, _ := s.view(ch.ID)
				views = append(views, v)
			}
			return &out[[]ChannelView]{Body: views}, nil
		})

	add(a, http.MethodPost, "/api/v1/channels", "channels-create", "Create a channel (body: channel JSON).", http.StatusCreated,
		func(ctx context.Context, in *rawIn) (*out[ChannelView], error) {
			var ch config.Channel
			if err := decodeStrict(in.RawBody, &ch); err != nil {
				return nil, validationError(err)
			}
			_, err := s.Store.Update(func(c *config.Config) error {
				if c.FindChannel(ch.ID) >= 0 {
					return conflict("channel " + ch.ID + " already exists")
				}
				c.Channels = append(c.Channels, ch)
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(ch.ID)
			v, err := s.view(ch.ID)
			return &out[ChannelView]{Body: v}, err
		})

	add(a, http.MethodGet, "/api/v1/channels/{id}", "channels-get", "Get a channel.", 0,
		func(ctx context.Context, in *idIn) (*out[ChannelView], error) {
			v, err := s.view(in.ID)
			if err != nil {
				return nil, validationError(err)
			}
			return &out[ChannelView]{Body: v}, nil
		})

	replace := func(id string, next config.Channel) error {
		_, err := s.Store.Update(func(c *config.Config) error {
			i := c.FindChannel(id)
			if i < 0 {
				return notFound("channel " + id + " not found")
			}
			prev := c.Channels[i]
			next.ID = id
			config.KeepSecrets(&prev, &next)
			// StreamHub-managed outputs belong to the paired core: keep them.
			var outs []config.Output
			for _, o := range next.Outputs {
				if o.ManagedBy == "" {
					outs = append(outs, o)
				}
			}
			for _, o := range prev.Outputs {
				if o.ManagedBy != "" {
					outs = append(outs, o)
				}
			}
			next.Outputs = outs
			c.Channels[i] = next
			return nil
		})
		return err
	}

	add(a, http.MethodPut, "/api/v1/channels/{id}", "channels-replace", "Replace a channel (outputs-only changes are applied hot).", 0,
		func(ctx context.Context, in *idRawIn) (*out[ChannelView], error) {
			var ch config.Channel
			if err := decodeStrict(in.RawBody, &ch); err != nil {
				return nil, validationError(err)
			}
			if err := replace(in.ID, ch); err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			v, err := s.view(in.ID)
			return &out[ChannelView]{Body: v}, err
		})

	add(a, http.MethodPatch, "/api/v1/channels/{id}", "channels-patch", "JSON merge patch (RFC 7386) of a channel.", 0,
		func(ctx context.Context, in *idRawIn) (*out[ChannelView], error) {
			c := s.Store.Get()
			i := c.FindChannel(in.ID)
			if i < 0 {
				return nil, huma.Error404NotFound("channel " + in.ID + " not found")
			}
			cur := c.Channels[i]
			config.RedactChannel(&cur)
			var base, patch any
			b, _ := json.Marshal(cur)
			_ = json.Unmarshal(b, &base)
			if err := json.Unmarshal(in.RawBody, &patch); err != nil {
				return nil, huma.Error400BadRequest("invalid JSON: " + err.Error())
			}
			merged, _ := json.Marshal(mergePatch(base, patch))
			var ch config.Channel
			if err := decodeStrict(merged, &ch); err != nil {
				return nil, validationError(err)
			}
			if err := replace(in.ID, ch); err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			v, err := s.view(in.ID)
			return &out[ChannelView]{Body: v}, err
		})

	add(a, http.MethodDelete, "/api/v1/channels/{id}", "channels-delete", "Delete a channel (stops it).", http.StatusNoContent,
		func(ctx context.Context, in *idIn) (*struct{}, error) {
			_, err := s.Store.Update(func(c *config.Config) error {
				i := c.FindChannel(in.ID)
				if i < 0 {
					return notFound("channel " + in.ID + " not found")
				}
				c.Channels = append(c.Channels[:i], c.Channels[i+1:]...)
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			return nil, nil
		})

	setEnabled := func(id string, on bool) error {
		_, err := s.Store.Update(func(c *config.Config) error {
			i := c.FindChannel(id)
			if i < 0 {
				return notFound("channel " + id + " not found")
			}
			c.Channels[i].Enabled = on
			return nil
		})
		if err == nil {
			s.Manager.Sync(id)
		}
		return err
	}
	for _, act := range []struct {
		name string
		fn   func(id string) error
	}{
		{"start", func(id string) error { return setEnabled(id, true) }},
		{"stop", func(id string) error { return setEnabled(id, false) }},
		{"restart", func(id string) error {
			if !s.Manager.RestartEngine(id) {
				return setEnabled(id, true)
			}
			return nil
		}},
	} {
		act := act
		add(a, http.MethodPost, "/api/v1/channels/{id}/"+act.name, "channels-"+act.name, strings.ToUpper(act.name[:1])+act.name[1:]+" a channel.", 0,
			func(ctx context.Context, in *idIn) (*out[ChannelView], error) {
				if err := act.fn(in.ID); err != nil {
					return nil, validationError(err)
				}
				v, err := s.view(in.ID)
				return &out[ChannelView]{Body: v}, err
			})
	}

	add(a, http.MethodGet, "/api/v1/channels/{id}/status", "channels-status", "Live status + TS analysis of a channel.", 0,
		func(ctx context.Context, in *idIn) (*out[channel.ChannelStatus], error) {
			st, ok := s.Manager.ChannelStatusByID(in.ID)
			if !ok {
				return nil, huma.Error404NotFound("channel " + in.ID + " not found")
			}
			return &out[channel.ChannelStatus]{Body: st}, nil
		})

	add(a, http.MethodGet, "/api/v1/channels/{id}/logs", "channels-logs", "Last log lines of the engine (proc=engine) or an output (proc=<output id>).", 0,
		func(ctx context.Context, in *logsIn) (*out[[]string], error) {
			lines, ok := s.Manager.Logs(in.ID, in.Proc)
			if !ok {
				return nil, huma.Error404NotFound("no running process " + in.Proc + " on channel " + in.ID)
			}
			return &out[[]string]{Body: lines}, nil
		})

	add(a, http.MethodGet, "/api/v1/channels/{id}/pipeline", "channels-pipeline", "Dry run: the exact engine and output command lines.", 0,
		func(ctx context.Context, in *idIn) (*out[map[string]any], error) {
			c := s.Store.Get()
			i := c.FindChannel(in.ID)
			if i < 0 {
				return nil, huma.Error404NotFound("channel " + in.ID + " not found")
			}
			ch := c.Channels[i]
			// the real command lines carry passphrases, keys and URL
			// credentials: the dry run shows them masked.
			sec := config.ChannelSecrets(ch)
			res := map[string]any{}
			if eng, err := pipeline.BuildEngine(ch, 0, s.Caps()); err != nil {
				res["engineError"] = config.Scrub(err.Error(), sec)
			} else {
				path, args := eng.Command(pipeline.GstLaunch, pipeline.FFmpeg)
				res["engine"] = map[string]any{"backend": eng.Backend, "element": eng.Element, "command": config.ScrubAll(append([]string{path}, args...), sec)}
			}
			outs := map[string]any{}
			for _, o := range ch.Outputs {
				if o.Type == config.OutStreamHub {
					outs[o.ID] = "resolved at runtime through the StreamHub API"
					continue
				}
				cmd, err := pipeline.BuildOutput(ch, o, 0, time.Now())
				if err != nil {
					outs[o.ID] = map[string]any{"error": config.Scrub(err.Error(), sec)}
					continue
				}
				outs[o.ID] = map[string]any{"command": config.ScrubAll(append([]string{cmd.Path}, cmd.Args...), sec)}
			}
			res["outputs"] = outs
			return &out[map[string]any]{Body: res}, nil
		})

	add(a, http.MethodPost, "/api/v1/channels/{id}/profile", "channels-apply-profile", "Apply a built-in encode profile ({\"profile\":\"…\"}).", 0,
		func(ctx context.Context, in *idRawIn) (*out[ChannelView], error) {
			var body struct {
				Profile string `json:"profile"`
			}
			if err := decodeStrict(in.RawBody, &body); err != nil {
				return nil, validationError(err)
			}
			p, ok := presets.FindProfile(body.Profile)
			if !ok {
				return nil, huma.Error404NotFound("unknown profile " + body.Profile)
			}
			_, err := s.Store.Update(func(c *config.Config) error {
				i := c.FindChannel(in.ID)
				if i < 0 {
					return notFound("channel " + in.ID + " not found")
				}
				presets.ApplyProfile(&c.Channels[i], p)
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			v, err := s.view(in.ID)
			return &out[ChannelView]{Body: v}, err
		})

	add(a, http.MethodPost, "/api/v1/channels/{id}/outputs", "outputs-add", "Add an output hot (body: output JSON, or {\"preset\":\"…\",\"params\":{…},\"id\":\"…\"}).", http.StatusCreated,
		func(ctx context.Context, in *idRawIn) (*out[map[string]any], error) {
			o, warnings, err := s.parseOutput(in.ID, in.RawBody)
			if err != nil {
				return nil, validationError(err)
			}
			_, err = s.Store.Update(func(c *config.Config) error {
				i := c.FindChannel(in.ID)
				if i < 0 {
					return notFound("channel " + in.ID + " not found")
				}
				if c.Channels[i].FindOutput(o.ID) >= 0 {
					return conflict("output " + o.ID + " already exists")
				}
				c.Channels[i].Outputs = append(c.Channels[i].Outputs, o)
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			v, err := s.view(in.ID)
			return &out[map[string]any]{Body: map[string]any{"output": o.ID, "warnings": warnings, "channel": v}}, err
		})

	add(a, http.MethodPut, "/api/v1/channels/{id}/outputs/{oid}", "outputs-replace", "Replace one output (only that output restarts).", 0,
		func(ctx context.Context, in *outRawIn) (*out[ChannelView], error) {
			var o config.Output
			if err := decodeStrict(in.RawBody, &o); err != nil {
				return nil, validationError(err)
			}
			o.ID = in.OID
			_, err := s.Store.Update(func(c *config.Config) error {
				i := c.FindChannel(in.ID)
				if i < 0 {
					return notFound("channel " + in.ID + " not found")
				}
				j := c.Channels[i].FindOutput(in.OID)
				if j < 0 {
					return notFound("output " + in.OID + " not found")
				}
				if c.Channels[i].Outputs[j].ManagedBy != "" {
					return conflict("output " + in.OID + " is managed by StreamHub")
				}
				tmp := config.Channel{Outputs: []config.Output{o}}
				config.KeepSecrets(&c.Channels[i], &tmp)
				c.Channels[i].Outputs[j] = tmp.Outputs[0]
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			v, err := s.view(in.ID)
			return &out[ChannelView]{Body: v}, err
		})

	add(a, http.MethodDelete, "/api/v1/channels/{id}/outputs/{oid}", "outputs-delete", "Remove an output hot (the others keep running).", http.StatusNoContent,
		func(ctx context.Context, in *outIn) (*struct{}, error) {
			_, err := s.Store.Update(func(c *config.Config) error {
				i := c.FindChannel(in.ID)
				if i < 0 {
					return notFound("channel " + in.ID + " not found")
				}
				j := c.Channels[i].FindOutput(in.OID)
				if j < 0 {
					return notFound("output " + in.OID + " not found")
				}
				c.Channels[i].Outputs = append(c.Channels[i].Outputs[:j], c.Channels[i].Outputs[j+1:]...)
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.Sync(in.ID)
			return nil, nil
		})

	add(a, http.MethodPost, "/api/v1/channels/{id}/outputs/{oid}/restart", "outputs-restart", "Restart (reconnect) one output.", 0,
		func(ctx context.Context, in *outIn) (*out[map[string]bool], error) {
			if !s.Manager.RestartOutput(in.ID, in.OID) {
				return nil, huma.Error404NotFound("output " + in.OID + " is not running")
			}
			return &out[map[string]bool]{Body: map[string]bool{"restarted": true}}, nil
		})

	add(a, http.MethodGet, "/api/v1/presets", "presets-list", "Built-in encode profiles and destination presets.", 0,
		func(ctx context.Context, _ *struct{}) (*out[map[string]any], error) {
			return &out[map[string]any]{Body: map[string]any{"profiles": presets.Profiles, "destinations": presets.Destinations}}, nil
		})

	add(a, http.MethodGet, "/api/v1/config/backup", "config-export", "Export the whole configuration. Secrets are exported as \"***\" placeholders: restoring on the same box keeps the stored values, on another box the import asks to re-enter them (422).", 0,
		func(ctx context.Context, _ *struct{}) (*out[config.Config], error) {
			return &out[config.Config]{Body: config.Redact(s.Store.Get())}, nil
		})

	add(a, http.MethodPut, "/api/v1/config/backup", "config-import", "Import a configuration export (validated; replaces channels).", 0,
		func(ctx context.Context, in *rawIn) (*out[map[string]any], error) {
			var nc config.Config
			if err := decodeStrict(in.RawBody, &nc); err != nil {
				return nil, validationError(err)
			}
			if nc.Version > config.SchemaVersion {
				return nil, huma.Error422UnprocessableEntity("backup schema is newer than this encoderd")
			}
			_, err := s.Store.Update(func(c *config.Config) error {
				// placeholders keep this box's secrets (same channel/output id
				// and destination); the rest must be re-entered (validation).
				for i := range nc.Channels {
					if j := c.FindChannel(nc.Channels[i].ID); j >= 0 {
						config.KeepSecrets(&c.Channels[j], &nc.Channels[i])
					} else {
						config.KeepSecrets(&config.Channel{}, &nc.Channels[i])
					}
				}
				config.KeepNotifySecrets(c.Settings.Notify, nc.Settings.Notify)
				c.Channels = nc.Channels
				if nc.Device.Name != "" {
					c.Device.Name = nc.Device.Name
				}
				if nc.StreamHub.Credential != "" && nc.StreamHub.Credential != config.Redacted {
					c.StreamHub = nc.StreamHub
				}
				c.Settings = nc.Settings
				return nil
			})
			if err != nil {
				return nil, validationError(err)
			}
			s.Manager.SyncAll()
			return &out[map[string]any]{Body: map[string]any{"imported": len(nc.Channels)}}, nil
		})

	add(a, http.MethodGet, "/api/v1/streamhub", "streamhub-state", "Native StreamHub pairing state.", 0,
		func(ctx context.Context, _ *struct{}) (*out[streamhub.PairState], error) {
			return &out[streamhub.PairState]{Body: s.Pairing.State()}, nil
		})

	add(a, http.MethodPost, "/api/v1/streamhub/pair", "streamhub-pair", "Start pairing with a StreamHub ({\"baseUrl\":\"https://…\"}); shows a code to claim in the dashboard.", 0,
		func(ctx context.Context, in *rawIn) (*out[streamhub.PairState], error) {
			var body struct {
				BaseURL string `json:"baseUrl"`
			}
			if err := decodeStrict(in.RawBody, &body); err != nil {
				return nil, validationError(err)
			}
			st, err := s.Pairing.StartPairing(ctx, body.BaseURL)
			if err != nil {
				return nil, huma.Error502BadGateway("pairing start failed: " + err.Error())
			}
			return &out[streamhub.PairState]{Body: st}, nil
		})

	add(a, http.MethodPost, "/api/v1/streamhub/unpair", "streamhub-unpair", "Forget the StreamHub credential and its managed outputs.", 0,
		func(ctx context.Context, _ *struct{}) (*out[streamhub.PairState], error) {
			if err := s.Pairing.Unpair(); err != nil {
				return nil, validationError(err)
			}
			return &out[streamhub.PairState]{Body: s.Pairing.State()}, nil
		})
}

// parseOutput accepts a literal output or a preset instantiation.
func (s *Server) parseOutput(chID string, raw []byte) (config.Output, []string, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return config.Output{}, nil, badRequest("invalid JSON: " + err.Error())
	}
	if _, ok := probe["preset"]; ok {
		var body struct {
			Preset string            `json:"preset"`
			Params map[string]string `json:"params"`
			ID     string            `json:"id"`
			Name   string            `json:"name"`
		}
		if err := decodeStrict(raw, &body); err != nil {
			return config.Output{}, nil, err
		}
		d, ok := presets.FindDestination(body.Preset)
		if !ok {
			return config.Output{}, nil, notFound("unknown destination preset " + body.Preset)
		}
		id := body.ID
		if id == "" {
			id = "o-" + config.RandomHex(3)
		}
		o, err := presets.Instantiate(d, body.Params, id)
		if err != nil {
			return config.Output{}, nil, badRequest(err.Error())
		}
		if body.Name != "" {
			o.Name = body.Name
		}
		c := s.Store.Get()
		var warn []string
		if i := c.FindChannel(chID); i >= 0 {
			warn = presets.Check(d, c.Channels[i])
		}
		return o, warn, nil
	}
	var o config.Output
	if err := decodeStrict(raw, &o); err != nil {
		return o, nil, err
	}
	if o.ID == "" {
		o.ID = "o-" + config.RandomHex(3)
	}
	if o.ManagedBy != "" {
		return o, nil, badRequest("managedBy is reserved for StreamHub-pushed outputs")
	}
	return o, nil, nil
}

// mergePatch implements RFC 7386.
func mergePatch(target, patch any) any {
	pm, ok := patch.(map[string]any)
	if !ok {
		return patch
	}
	tm, ok := target.(map[string]any)
	if !ok {
		tm = map[string]any{}
	}
	for k, v := range pm {
		if v == nil {
			delete(tm, k)
		} else {
			tm[k] = mergePatch(tm[k], v)
		}
	}
	return tm
}
