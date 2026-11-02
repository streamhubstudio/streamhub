package devices

import (
	"context"
	"net/http"
	"regexp"

	"github.com/danielgtaylor/huma/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/validate"
)

// Module is the device plane's REST surface.
type Module struct {
	Svc *Service
}

var deviceIDRE = regexp.MustCompile(`^dev_[0-9a-f]{16}$`)

func op(id, method, path, summary string, status int) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: method, Path: api.Prefix + path, Summary: summary,
		Tags: []string{"devices"}, DefaultStatus: status})
}

func clientIP(ctx context.Context) string { return httpx.ClientIP(api.Request(ctx)) }

func parse(raw []byte, rules func(*validate.Body)) (*validate.Body, error) {
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

func requestScheme(r *http.Request) string {
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		return p
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

type pairStartIn struct {
	RawBody []byte
}

type pairPollIn struct {
	DeviceID string `path:"deviceId"`
	Token    string `query:"token"`
}

type appIn struct {
	App string `path:"app"`
}

type appBodyIn struct {
	App     string `path:"app"`
	RawBody []byte
}

type deviceIn struct {
	App string `path:"app"`
	ID  string `path:"id"`
}

type deviceBodyIn struct {
	App     string `path:"app"`
	ID      string `path:"id"`
	RawBody []byte
}

type statusOut[T any] struct {
	Status int
	Body   T
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	// ---- device side (public: the code / poll token / credential is the capability) ----
	huma.Register(a, *api.Public(op("DevicesController_pairStart", http.MethodPost, "/devices/pair/start",
		"Device side: start a pairing. Returns a short human code to show on the device, a deviceId and a pollToken (rate-limited, 10 min TTL).", http.StatusCreated)),
		func(ctx context.Context, in *pairStartIn) (*statusOut[api.Envelope[*DevicePairStart]], error) {
			b, err := parse(in.RawBody, func(b *validate.Body) {
				b.Optional("model").MaxLength(maxFieldLen).IsString()
				b.Optional("version").MaxLength(maxFieldLen).IsString()
				b.Optional("serial").MaxLength(maxFieldLen).IsString()
			})
			if err != nil {
				return nil, err
			}
			res, err := m.Svc.StartPairing(ctx, clientIP(ctx), StartInput{Model: b.String("model"), Version: b.String("version"), Serial: b.String("serial")})
			if err != nil {
				return nil, err
			}
			return &statusOut[api.Envelope[*DevicePairStart]]{Status: http.StatusCreated, Body: api.Envelope[*DevicePairStart]{Data: res}}, nil
		})

	huma.Register(a, *api.Public(op("DevicesController_pairPoll", http.MethodGet, "/devices/pair/{deviceId}",
		"Device side: poll a pairing with its pollToken. Pending until an operator claims the code; then returns the device credential, the WS URL and the app — exactly once.", 0)),
		func(ctx context.Context, in *pairPollIn) (*api.Out[api.Envelope[*DevicePollResult]], error) {
			if !deviceIDRE.MatchString(in.DeviceID) {
				if err := m.Svc.disabled(); err != nil {
					return nil, err
				}
				return nil, httpx.NotFound(msgUnknownPair)
			}
			r := api.Request(ctx)
			res, err := m.Svc.Poll(ctx, clientIP(ctx), in.DeviceID, in.Token, m.Svc.WsURL(requestScheme(r), r.Host))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})

	// ---- operator side (app-scoped) ----
	huma.Register(a, *authz.Require(op("DevicesController_claim", http.MethodPost, "/apps/{app}/devices/claim",
		"Claim a device into this app by the pairing code it shows ({code, name}).", http.StatusCreated), "app", "write"),
		func(ctx context.Context, in *appBodyIn) (*statusOut[api.Envelope[*Device]], error) {
			b, err := parse(in.RawBody, func(b *validate.Body) {
				b.Field("code").MaxLength(32).IsString()
				b.Optional("name").MaxLength(maxFieldLen).IsString()
			})
			if err != nil {
				return nil, err
			}
			d, err := m.Svc.Claim(ctx, in.App, b.String("code"), b.String("name"), auth.From(ctx), clientIP(ctx))
			if err != nil {
				return nil, err
			}
			return &statusOut[api.Envelope[*Device]]{Status: http.StatusCreated, Body: api.Envelope[*Device]{Data: d}}, nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_list", http.MethodGet, "/apps/{app}/devices",
		"List this app's paired devices (online flag, last status, channels).", 0), "app", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[[]Device]], error) {
			list, err := m.Svc.List(ctx, in.App)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_get", http.MethodGet, "/apps/{app}/devices/{id}",
		"Get one device (status, capabilities, channels).", 0), "app", "read"),
		func(ctx context.Context, in *deviceIn) (*api.Out[api.Envelope[*Device]], error) {
			d, err := m.Svc.Get(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(d), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_status", http.MethodGet, "/apps/{app}/devices/{id}/status",
		"The device's latest reported status (per-channel state, bitrate, fps, cpu/gpu, errors) and liveness.", 0), "app", "read"),
		func(ctx context.Context, in *deviceIn) (*api.Out[api.Envelope[DeviceStatus]], error) {
			d, err := m.Svc.Get(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(DeviceStatus{ID: d.ID, Online: d.Online, LastSeenAt: d.LastSeenAt, Status: d.Status}), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_rename", http.MethodPatch, "/apps/{app}/devices/{id}",
		"Rename a device ({name}).", 0), "app", "write"),
		func(ctx context.Context, in *deviceBodyIn) (*api.Out[api.Envelope[*Device]], error) {
			b, err := parse(in.RawBody, func(b *validate.Body) {
				b.Field("name").MaxLength(maxFieldLen).MinLength(1).IsString()
			})
			if err != nil {
				return nil, err
			}
			d, err := m.Svc.Rename(ctx, in.App, in.ID, b.String("name"))
			if err != nil {
				return nil, err
			}
			return api.OK(d), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_revoke", http.MethodDelete, "/apps/{app}/devices/{id}",
		"Revoke a device: its credential stops working at once (live socket closed 4401) and its channel ingresses are deleted.", 0), "app", "write"),
		func(ctx context.Context, in *deviceIn) (*api.Out[api.Envelope[*DeviceRevokeResult]], error) {
			res, err := m.Svc.Revoke(ctx, in.App, in.ID, auth.From(ctx), clientIP(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_command", http.MethodPost, "/apps/{app}/devices/{id}/commands",
		"Send a command to a connected device and wait for its result ({action: start|stop|restart|apply_preset|reboot, channel?, preset?, confirm?}).", 0), "app", "write"),
		func(ctx context.Context, in *deviceBodyIn) (*api.Out[api.Envelope[*DeviceCommandResult]], error) {
			b, err := parse(in.RawBody, func(b *validate.Body) {
				action, _ := b.Raw("action").(string)
				act := b.Field("action")
				act.Check(!channelActions[action] || b.String("channel") != "", "channel is required for action "+action)
				act.Check(action != ActionApplyPreset || b.String("preset") != "", "preset is required for action apply_preset")
				act.Check(action != ActionReboot || b.Raw("confirm") == true, "confirm: true is required for action reboot")
				act.IsIn(Actions...)
				b.Optional("channel").MaxLength(64).IsString()
				b.Optional("preset").MaxLength(maxFieldLen).IsString()
			})
			if err != nil {
				return nil, err
			}
			res, err := m.Svc.Command(ctx, in.App, in.ID, CommandInput{
				Action: b.String("action"), Channel: b.String("channel"), Preset: b.String("preset"),
			}, auth.From(ctx), clientIP(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})

	// ---- channels → streams (E6) ----
	type channelIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		Channel string `path:"channel"`
	}
	type channelBodyIn struct {
		App     string `path:"app"`
		ID      string `path:"id"`
		Channel string `path:"channel"`
		RawBody []byte
	}
	badChannel := func(ch string) error {
		if !channelIDRE.MatchString(ch) {
			return httpx.BadRequest("channel must match " + channelIDRE.String())
		}
		return nil
	}
	huma.Register(a, *authz.Require(op("DevicesController_listChannels", http.MethodGet, "/apps/{app}/devices/{id}/channels",
		"List the device's linked channels (room, protocol, ingress, publish URL + key).", 0), "app", "read"),
		func(ctx context.Context, in *deviceIn) (*api.Out[api.Envelope[[]DeviceChannel]], error) {
			list, err := m.Svc.ListChannels(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.OK(list), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_linkChannel", http.MethodPut, "/apps/{app}/devices/{id}/channels/{channel}",
		"Link a device channel to a room ({room, protocol: rtmp|srt, name?}): the core creates the ingress (same rules as POST /ingress) and pushes it to the device in `config`. Re-linking replaces the old ingress.", 0), "app", "write"),
		func(ctx context.Context, in *channelBodyIn) (*api.Out[api.Envelope[*DeviceChannel]], error) {
			b, err := parse(in.RawBody, func(b *validate.Body) {
				b.Field("room").MaxLength(120).MinLength(1).IsString()
				b.Field("protocol").IsIn(ProtocolRTMP, ProtocolSRT)
				b.Optional("name").MaxLength(maxFieldLen).IsString()
			})
			if err != nil {
				return nil, err
			}
			if err := badChannel(in.Channel); err != nil {
				return nil, err
			}
			ch, err := m.Svc.LinkChannel(ctx, in.App, in.ID, LinkInput{
				Channel: in.Channel, Room: b.String("room"), Protocol: b.String("protocol"), Name: b.String("name"),
			}, auth.From(ctx))
			if err != nil {
				return nil, err
			}
			return api.OK(ch), nil
		})

	huma.Register(a, *authz.Require(op("DevicesController_unlinkChannel", http.MethodDelete, "/apps/{app}/devices/{id}/channels/{channel}",
		"Unlink a device channel: deletes its ingress and pushes the new config.", 0), "app", "write"),
		func(ctx context.Context, in *channelIn) (*api.Out[api.Envelope[*UnlinkResult]], error) {
			if err := badChannel(in.Channel); err != nil {
				return nil, err
			}
			res, err := m.Svc.UnlinkChannel(ctx, in.App, in.ID, in.Channel)
			if err != nil {
				return nil, err
			}
			return api.OK(res), nil
		})
}

var channelIDRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// DeviceStatus is GET /apps/{app}/devices/{id}/status.data.
type DeviceStatus struct {
	ID         string  `json:"id"`
	Online     bool    `json:"online"`
	LastSeenAt *string `json:"lastSeenAt"`
	Status     any     `json:"status"`
}
