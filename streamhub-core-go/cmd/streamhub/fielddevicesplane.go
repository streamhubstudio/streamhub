package main

import (
	"context"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/audit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/devices"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/livekit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streams"
)

// The field-devices plane (software/hardware encoders, E4 of
// planning/SOFTWARE-ENCODER-PLAN.md): code pairing, the device credential,
// the device WS control channel (/api/v1/devices/ws, a middleware like the
// edge gateway) and the app-scoped management routes. Off by default
// (STREAMHUB_DEVICES_ENABLE): the routes answer 503 and the WS refuses.
//
// Provides: "devices" (*devices.Service).
// Needs: "apps". Optional: "audit", "security.rules" +
// "security.reputation" (upgrade guard + auto-ban offenses).
func init() {
	registerPlane(50, "fielddevices", func(ctx context.Context, c *core) error {
		apps := need[contracts.AppsService](c, "apps")
		var offense devices.Offenses
		rep, okP := maybe[*security.Reputation](c, "security.reputation")
		if okP && rep != nil {
			offense = func(ip string) { rep.RecordOffense(ip, security.OffenseInvalidToken) }
		}
		var sink devices.AuditSink
		if a, ok := maybe[*audit.Service](c, "audit"); ok && a != nil {
			sink = a
		}
		svc := devices.New(devices.Deps{
			DB: c.global, Enabled: c.cfg.EnvBool(devices.EnableEnv, false), PublicBaseURL: c.cfg.PublicBaseURL,
			Apps: appExists{apps}, Audit: sink, Offense: offense, Log: c.log,
			Ingress: deviceIngress{lazy[*livekit.Module](c, "livekit.module")},
		})
		// E6: GET /apps/{app}/streams[/{id}] name the feeding device channel
		c.binds = append(c.binds, func() {
			if st, ok := maybe[*streams.Service](c, "streams"); ok && st != nil {
				st.SetSourceDevices(func(ctx context.Context, app string) map[string]streams.SourceDevice {
					src := svc.SourceDevices(ctx, app)
					out := make(map[string]streams.SourceDevice, len(src))
					for room, d := range src {
						out[room] = streams.SourceDevice{DeviceID: d.DeviceID, Name: d.Name, Channel: d.Channel}
					}
					return out
				})
			}
		})
		var guard devices.UpgradeGuard
		if rules, okR := maybe[*security.Rules](c, "security.rules"); okR && okP {
			guard = upgradeGuard{security.NewNetworkGuard(security.ResolveSettings(c.cfg.Env), rules, rep)}
		}
		gw := devices.NewGateway(svc, guard, c.log)
		c.middleware = append(c.middleware, gw.Middleware)
		provide(c, "devices", svc)
		c.modules = append(c.modules, &devices.Module{Svc: svc})
		c.starters = append(c.starters, func(ctx context.Context) {
			go func() { <-ctx.Done(); gw.Shutdown() }()
		})
		return nil
	})
}

// deviceIngress mints a device channel's ingress through the POST
// /apps/:app/ingress logic: rtmp → the app's default plane (LiveKit
// transcode unless rtmp.passthrough), srt → passthrough (behind the MediaMTX
// SRT front when STREAMHUB_MEDIAMTX_SRT_ENABLE is on).
type deviceIngress struct{ m func() *livekit.Module }

func (d deviceIngress) Create(ctx context.Context, app, room, protocol string, p *auth.Principal) (*devices.Publish, error) {
	m := d.m()
	if m == nil {
		return nil, httpx.Unavailable("ingress service unavailable")
	}
	body := map[string]any{"inputType": protocol, "room": room, "participantName": "device " + room}
	if protocol == devices.ProtocolSRT {
		body["mode"] = "passthrough"
	}
	res, err := m.CreateIngressFor(ctx, app, body, p)
	if err != nil {
		return nil, err
	}
	switch r := res.(type) {
	case *livekit.CreateIngressResult:
		return &devices.Publish{IngressID: r.IngressID, Room: r.RoomName, URL: r.RtmpURL, StreamKey: r.StreamKey, InputType: protocol}, nil
	case *livekit.PassthroughCreateResult:
		url := r.SrtURL
		if url == "" {
			url = r.RtmpURL
		}
		return &devices.Publish{IngressID: r.IngressID, Room: r.Room, URL: url, StreamKey: r.StreamKey, InputType: r.InputType, Passthrough: true}, nil
	}
	return nil, httpx.Internal("unexpected ingress result")
}

func (d deviceIngress) Delete(ctx context.Context, app, ingressID string) error {
	m := d.m()
	if m == nil {
		return nil
	}
	_, err := m.DeleteIngressRoute(ctx, app, ingressID)
	return err
}

// appExists adapts the apps registry to devices.Apps.
type appExists struct{ apps contracts.AppsService }

func (a appExists) Exists(ctx context.Context, app string) bool {
	rec, err := a.apps.Get(ctx, app)
	return err == nil && rec != nil
}
