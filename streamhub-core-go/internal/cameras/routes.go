package cameras

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// HTTP surface: /api/v1/apps/{app}/plugins/cameras/…, Bearer +
// config:read|write (like fleet). Bodies are parsed by hand (RawBody) so a
// bad field answers a 400 with a precise message.

const base = "/apps/{app}/plugins/cameras"

// mapErr turns service errors into HTTP errors.
func mapErr(err error) error {
	var ce *CommandError
	var ie *InactiveError
	var ne *NotFoundError
	var cf *ConflictError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &ce):
		return httpx.BadRequest(ce.Error())
	case errors.As(err, &ne):
		return httpx.NotFound(ne.Error())
	case errors.As(err, &ie):
		return httpx.Conflict(ie.Error())
	case errors.As(err, &cf):
		return httpx.Conflict(cf.Error())
	}
	var he *httpx.Error
	if errors.As(err, &he) {
		return he
	}
	return httpx.Internal("Internal server error")
}

// body is a parsed JSON object body (nil/invalid → empty object; a non-object
// → error).
func body(raw []byte) (*y.Map, error) {
	if len(raw) == 0 {
		return y.NewMap(), nil
	}
	v, err := y.ParseJSON(raw)
	if err != nil {
		return nil, httpx.BadRequest("body must be a JSON object")
	}
	m, ok := v.(*y.Map)
	if !ok || m == nil {
		return nil, httpx.BadRequest("body must be a JSON object")
	}
	return m, nil
}

func optString(m *y.Map, k string) (*string, error) {
	v, ok := m.Lookup(k)
	if !ok || v == nil {
		return nil, nil
	}
	s, isStr := v.(string)
	if !isStr {
		return nil, httpx.BadRequest("'" + k + "' must be a string")
	}
	s = y.Trim(s)
	if len(s) > 512 {
		return nil, httpx.BadRequest("'" + k + "' is too long")
	}
	return &s, nil
}

func optNumber(m *y.Map, k string) (*float64, error) {
	v, ok := m.Lookup(k)
	if !ok || v == nil {
		return nil, nil
	}
	n, isNum := v.(float64)
	if !isNum {
		return nil, httpx.BadRequest("'" + k + "' must be a number")
	}
	return &n, nil
}

func waitOf(m *y.Map) (time.Duration, error) {
	n, err := optNumber(m, "waitMs")
	if err != nil || n == nil || *n <= 0 {
		return 0, err
	}
	return time.Duration(*n) * time.Millisecond, nil
}

func parseInventory(m *y.Map) (Inventory, error) {
	var inv Inventory
	var err error
	for _, f := range []struct {
		key string
		dst **string
	}{{"name", &inv.Name}, {"site", &inv.Site}, {"stand", &inv.Stand}, {"model", &inv.Model}, {"room", &inv.Room},
		{"streamUrl", &inv.StreamURL}, {"streamKey", &inv.StreamKey}, {"mqttUser", &inv.MqttUser}, {"mqttPass", &inv.MqttPass}} {
		if *f.dst, err = optString(m, f.key); err != nil {
			return inv, err
		}
	}
	if v, ok := m.Lookup("tags"); ok && v != nil {
		arr, isArr := v.([]any)
		if !isArr {
			return inv, httpx.BadRequest("'tags' must be an array of strings")
		}
		tags := []string{}
		for _, t := range arr {
			s, isStr := t.(string)
			if !isStr || y.Trim(s) == "" {
				return inv, httpx.BadRequest("'tags' must be an array of strings")
			}
			tags = append(tags, y.Trim(s))
		}
		inv.Tags = &tags
	}
	return inv, nil
}

// CameraDeleted is the DELETE payload.
type CameraDeleted struct {
	Device  string `json:"device"`
	Deleted bool   `json:"deleted"`
}

// HdResult is the stream/hd payload.
type HdResult struct {
	Command *CamerasCommandRow `json:"command"`
	HdUntil *string            `json:"hdUntil"`
}

// EventsPage is the GET events payload.
type EventsPage struct {
	Events []CamerasEventRow `json:"events"`
}

// Register implements api.Module.
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary, action string) *huma.Operation {
		return authz.Require(api.Bearer(&huma.Operation{
			OperationID: "CamerasController_" + id, Method: method, Path: api.Prefix + base + path, Summary: summary, Tags: []string{"cameras"},
		}), "config", action)
	}
	type appIn struct {
		App    string `path:"app"`
		Site   string `query:"site" doc:"Only cameras of this site."`
		Stand  string `query:"stand" doc:"Only cameras of this stand."`
		Tag    string `query:"tag" doc:"Only cameras carrying this tag."`
		Online string `query:"online" enum:"true,false," doc:"true = online only, false = offline/unknown only."`
	}
	type appBody struct {
		App     string `path:"app"`
		RawBody []byte
	}
	type devIn struct {
		App    string `path:"app"`
		Device string `path:"device"`
	}
	type devBody struct {
		App     string `path:"app"`
		Device  string `path:"device"`
		RawBody []byte
	}
	type eventsIn struct {
		App    string `path:"app"`
		Device string `path:"device"`
		Level  string `query:"level" enum:"debug,info,warn,error," doc:"Only this level."`
		Src    string `query:"src" doc:"Only this source (stream, ptz, system, …)."`
		Before int64  `query:"before" doc:"Cursor: events with id < before."`
		Limit  int64  `query:"limit" doc:"Page size (1..1000, default 100)."`
	}
	type cmdIn struct {
		App    string `path:"app"`
		Device string `path:"device"`
		ID     string `path:"id"`
	}

	huma.Register(a, *op("list", http.MethodGet, "/cameras",
		"Camera inventory + last state (hello/status/state over MQTT).", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*CamerasList]], error) {
			f := ListFilter{Site: in.Site, Stand: in.Stand, Tag: in.Tag}
			if in.Online != "" {
				b := in.Online == "true"
				f.Online = &b
			}
			d, err := s.List(ctx, in.App, f)
			if err != nil {
				return nil, mapErr(err)
			}
			return api.OK(d), nil
		})

	create := op("create", http.MethodPost, "/cameras",
		"Register a camera (alta): inventory fields + the per-camera MQTT credential used by its config.ini.", "write")
	create.DefaultStatus = http.StatusCreated
	huma.Register(a, *create, func(ctx context.Context, in *appBody) (*api.Out[api.Envelope[*CameraView]], error) {
		m, err := body(in.RawBody)
		if err != nil {
			return nil, err
		}
		dev, _ := m.Get("device").(string)
		dev = y.Trim(dev)
		if dev == "" {
			return nil, httpx.BadRequest("body must carry a 'device'")
		}
		inv, err := parseInventory(m)
		if err != nil {
			return nil, err
		}
		v, _, err := s.Upsert(ctx, in.App, dev, inv, true)
		if err != nil {
			return nil, mapErr(err)
		}
		return api.OK(v), nil
	})

	huma.Register(a, *op("get", http.MethodGet, "/cameras/{device}",
		"One camera: last hello/state, state history, recent commands and events.", "read"),
		func(ctx context.Context, in *devIn) (*api.Out[api.Envelope[*CameraDetail]], error) {
			d, err := s.Get(ctx, in.App, in.Device)
			if err != nil {
				return nil, mapErr(err)
			}
			if d == nil {
				return nil, httpx.NotFound("camera '" + in.Device + "' not found")
			}
			return api.OK(d), nil
		})

	huma.Register(a, *op("update", http.MethodPatch, "/cameras/{device}",
		"Edit a camera's inventory fields (name, site, stand, model, room, streamUrl, streamKey, tags).", "write"),
		func(ctx context.Context, in *devBody) (*api.Out[api.Envelope[*CameraView]], error) {
			m, err := body(in.RawBody)
			if err != nil {
				return nil, err
			}
			inv, err := parseInventory(m)
			if err != nil {
				return nil, err
			}
			v, _, err := s.Upsert(ctx, in.App, in.Device, inv, false)
			if err != nil {
				return nil, mapErr(err)
			}
			return api.OK(v), nil
		})

	huma.Register(a, *op("delete", http.MethodDelete, "/cameras/{device}",
		"Forget a camera (inventory, history, commands, events). A camera still publishing re-appears as discovered.", "write"),
		func(ctx context.Context, in *devIn) (*api.Out[api.Envelope[CameraDeleted]], error) {
			ok, err := s.Delete(ctx, in.App, in.Device)
			if err != nil {
				return nil, mapErr(err)
			}
			if !ok {
				return nil, httpx.NotFound("camera '" + in.Device + "' not found")
			}
			return api.OK(CameraDeleted{in.Device, true}), nil
		})

	type iniOut struct {
		ContentType        string `header:"Content-Type"`
		ContentDisposition string `header:"Content-Disposition"`
		Body               []byte
	}
	huma.Register(a, *op("configIni", http.MethodGet, "/cameras/{device}/config.ini",
		"The provisioning config.ini for the camera's microSD (carries its MQTT credential, hence config:write).", "write"),
		func(ctx context.Context, in *devIn) (*iniOut, error) {
			txt, err := s.ConfigIni(ctx, in.App, in.Device)
			if err != nil {
				return nil, mapErr(err)
			}
			return &iniOut{"text/plain; charset=utf-8", `attachment; filename="config.ini"`, []byte(txt)}, nil
		})

	type thumbOut struct {
		ContentType  string `header:"Content-Type"`
		LastModified string `header:"X-Thumb-At"`
		CacheControl string `header:"Cache-Control"`
		Body         []byte
	}
	huma.Register(a, *op("thumb", http.MethodGet, "/cameras/{device}/thumb",
		"The camera's retained thumbnail (<base>/thumb JPEG); 404 when it never sent one.", "read"),
		func(ctx context.Context, in *devIn) (*thumbOut, error) {
			b, at, err := s.Thumb(ctx, in.App, in.Device)
			if err != nil {
				return nil, mapErr(err)
			}
			if len(b) == 0 {
				return nil, httpx.NotFound("no thumbnail for camera '" + in.Device + "'")
			}
			return &thumbOut{"image/jpeg", at, "no-store", b}, nil
		})

	huma.Register(a, *op("events", http.MethodGet, "/cameras/{device}/events",
		"The camera's event log (newest first; bounded per camera).", "read"),
		func(ctx context.Context, in *eventsIn) (*api.Out[api.Envelope[EventsPage]], error) {
			evs, err := s.Events(ctx, in.App, in.Device, EventQuery{Level: in.Level, Src: in.Src, Before: in.Before, Limit: in.Limit})
			if err != nil {
				return nil, mapErr(err)
			}
			return api.OK(EventsPage{evs}), nil
		})

	cmd := op("command", http.MethodPost, "/cameras/{device}/command",
		"Send any allowlisted OpenCam command {cmd, args?, exp?, ifRev?, confirm?, waitMs?}; dangerous ones need confirm:true and are audited.", "write")
	cmd.DefaultStatus = http.StatusCreated
	huma.Register(a, *cmd, func(ctx context.Context, in *devBody) (*api.Out[api.Envelope[*CamerasCommandRow]], error) {
		m, err := body(in.RawBody)
		if err != nil {
			return nil, err
		}
		name, _ := m.Get("cmd").(string)
		if y.Trim(name) == "" {
			return nil, httpx.BadRequest("body must carry a 'cmd'")
		}
		req := CommandRequest{Cmd: y.Trim(name), Args: m.Get("args"), Confirm: m.Get("confirm") == true}
		if y.IsUndefined(req.Args) {
			req.Args = nil
		}
		if req.ExpSec, err = optNumber(m, "exp"); err != nil {
			return nil, err
		}
		if req.IfRev, err = optNumber(m, "ifRev"); err != nil {
			return nil, err
		}
		if req.Wait, err = waitOf(m); err != nil {
			return nil, err
		}
		row, err := s.SendCommand(ctx, in.App, in.Device, req)
		if err != nil {
			return nil, mapErr(err)
		}
		return api.OK(row), nil
	})

	huma.Register(a, *op("commandGet", http.MethodGet, "/cameras/{device}/commands/{id}",
		"One command and its phase (pending → accepted → progress → done | failed | timeout).", "read"),
		func(ctx context.Context, in *cmdIn) (*api.Out[api.Envelope[*CamerasCommandRow]], error) {
			r, err := s.GetCommand(ctx, in.App, in.Device, in.ID)
			if err != nil {
				return nil, mapErr(err)
			}
			if r == nil {
				return nil, httpx.NotFound("command '" + in.ID + "' not found")
			}
			return api.OK(r), nil
		})

	// Typed helpers: one route per console action (stable operationIds for
	// MCP/SDKs); each builds the OpenCam command and goes through SendCommand.
	type helper struct {
		id, path, summary string
		build             func(m *y.Map, device string) (CommandRequest, error)
	}
	fixed := func(name string) func(*y.Map, string) (CommandRequest, error) {
		return func(*y.Map, string) (CommandRequest, error) { return CommandRequest{Cmd: name}, nil }
	}
	helpers := []helper{
		{"ptzMove", "/ptz/move", "PTZ pad: ptz/dir {dir, speed?, step?, hold_ms} with the deadman — repeat every ~300 ms while held (not persisted).",
			func(m *y.Map, _ string) (CommandRequest, error) {
				args := y.NewMap()
				dir, _ := m.Get("dir").(string)
				args.Set("dir", dir)
				for _, k := range []string{"speed", "step"} {
					n, err := optNumber(m, k)
					if err != nil {
						return CommandRequest{}, err
					}
					if n != nil {
						args.Set(k, *n)
					}
				}
				hold := 500.0
				n, err := optNumber(m, "holdMs")
				if err != nil {
					return CommandRequest{}, err
				}
				if n != nil {
					hold = *n
				}
				args.Set("hold_ms", hold)
				return CommandRequest{Cmd: "ptz/dir", Args: args}, nil
			}},
		{"ptzStop", "/ptz/stop", "PTZ stop (sent when the pad is released).", fixed("ptz/stop")},
		{"ptzHome", "/ptz/home", "PTZ home position.", fixed("ptz/home")},
		{"ptzPreset", "/ptz/preset", "Go to a PTZ preset {preset}.",
			func(m *y.Map, _ string) (CommandRequest, error) {
				args := y.NewMap()
				if v, ok := m.Lookup("preset"); ok {
					args.Set("preset", v)
				}
				return CommandRequest{Cmd: "ptz/preset", Args: args}, nil
			}},
		{"streamStart", "/stream/start", "Start the camera's RTMP push.", fixed("stream/start")},
		{"streamStop", "/stream/stop", "Stop the camera's RTMP push.", fixed("stream/stop")},
		{"snapshot", "/snapshot", "Take a snapshot now (snapshot/take; uploaded to the camera's configured targets).", fixed("snapshot/take")},
		{"reboot", "/reboot", "Reboot the camera (system/reboot {reason}); resolves when it reconnects with a new boot_id. Audited.",
			func(m *y.Map, _ string) (CommandRequest, error) {
				args := y.NewMap()
				reason, err := optString(m, "reason")
				if err != nil {
					return CommandRequest{}, err
				}
				r := "streamhub"
				if reason != nil && *reason != "" {
					r = *reason
				}
				args.Set("reason", r)
				return CommandRequest{Cmd: "system/reboot", Args: args, Confirm: true}, nil
			}},
		{"voiceTest", "/voice/test", "Play a voice phrase on the camera speaker (voice/say {key}, default network_offline).",
			func(m *y.Map, _ string) (CommandRequest, error) {
				args := y.NewMap()
				key, err := optString(m, "key")
				if err != nil {
					return CommandRequest{}, err
				}
				k := "network_offline"
				if key != nil && *key != "" {
					k = *key
				}
				args.Set("key", k)
				return CommandRequest{Cmd: "voice/say", Args: args}, nil
			}},
	}
	for _, h := range helpers {
		o := op(h.id, http.MethodPost, "/cameras/{device}"+h.path, h.summary, "write")
		o.DefaultStatus = http.StatusCreated
		build := h.build
		huma.Register(a, *o, func(ctx context.Context, in *devBody) (*api.Out[api.Envelope[*CamerasCommandRow]], error) {
			m, err := body(in.RawBody)
			if err != nil {
				return nil, err
			}
			req, err := build(m, in.Device)
			if err != nil {
				return nil, err
			}
			if req.Wait, err = waitOf(m); err != nil {
				return nil, err
			}
			row, err := s.SendCommand(ctx, in.App, in.Device, req)
			if err != nil {
				return nil, mapErr(err)
			}
			return api.OK(row), nil
		})
	}

	// A RawBody operation accepts a missing body (api.New does this through
	// api.OptionalRawBody at boot; set it here too so a bare huma API — the
	// tests — behaves the same).
	defer func() {
		for p, item := range a.OpenAPI().Paths {
			if !strings.HasPrefix(p, api.Prefix+base) {
				continue
			}
			for _, o := range []*huma.Operation{item.Post, item.Patch} {
				if o != nil && o.RequestBody != nil {
					o.RequestBody.Required = false
				}
			}
		}
	}()

	hd := op("streamHd", http.MethodPost, "/cameras/{device}/stream/hd",
		"Temporarily switch to the main stream {on, minutes?} (stream/set {source:0}); reverts to the sub-stream after minutes (default hdRevertMin).", "write")
	hd.DefaultStatus = http.StatusCreated
	huma.Register(a, *hd, func(ctx context.Context, in *devBody) (*api.Out[api.Envelope[HdResult]], error) {
		m, err := body(in.RawBody)
		if err != nil {
			return nil, err
		}
		on, isBool := m.Get("on").(bool)
		if !isBool {
			return nil, httpx.BadRequest("body must carry 'on' (boolean)")
		}
		minutes, err := optNumber(m, "minutes")
		if err != nil {
			return nil, err
		}
		mins := 0.0
		if minutes != nil {
			mins = *minutes
		}
		row, until, err := s.SetHD(ctx, in.App, in.Device, on, mins, "")
		if err != nil {
			return nil, mapErr(err)
		}
		return api.OK(HdResult{row, until}), nil
	})
}
