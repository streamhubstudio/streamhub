package main

import (
	"context"
	"os"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/audit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/callbacks"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/clips"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/logsink"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/mqtt"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/notifications"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/plugins"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/s3"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streamflow"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streams"
)

// The streamflow plane: the Streamflow engine (store + runner + trigger
// service + secrets + AI client) and its 16 routes.
//
// Needs "apps". Optional, resolved lazily at call time (so plane order
// within 50 does not matter): "plugins.repo" (install state + config),
// "callbacks" (trigger tap + emit + lifecycle), "mqtt" (action.mqtt),
// "streams" (action.snapshot), "notifications" (action.notify), "s3" +
// "s3.secrets" (action.s3 + the AI key ref), "logsink", "audit" (the boot
// quarantine of execution boxes outside STREAMHUB_STREAMFLOW_DANGEROUS).
//
// Provides: "streamflow" (*streamflow.Service). Background work — the 4 run
// workers, the trigger subscription, the 60 s reconcile and the schedule
// triggers — starts only from c.starters (none in STREAMHUB_SHADOW).
func init() {
	registerPlane(50, "streamflow", func(ctx context.Context, c *core) error {
		apps := need[contracts.AppsService](c, "apps")
		var logw logsink.Writer = logsink.Slog{Log: c.log}
		if w, ok := maybe[*logsink.Switch](c, "logsink"); ok {
			logw = w
		}
		store := streamflow.NewStore()

		plugin := func(ctx context.Context, app string) (bool, bool, *y.Map) {
			repo, ok := maybe[*plugins.Repo](c, "plugins.repo")
			if !ok {
				return false, false, nil
			}
			row, err := repo.Get(ctx, app, "streamflow")
			if err != nil || row == nil {
				return false, false, nil
			}
			return true, row.Enabled, row.Config
		}
		ai := &streamflow.AIClient{Usage: store, Resolve: security.DefaultHostResolver, Now: time.Now}
		if sec, ok := maybe[*s3.SecretsStore](c, "s3.secrets"); ok {
			ai.Secrets = aiKeyResolver{sec}
		}
		secrets := streamflow.NewSecrets(store, apps, c.cfg.JWTSecret)

		deps := streamflow.RunnerDeps{
			Store: store, Apps: apps, Plugin: plugin, AI: ai, Secrets: secrets, Logs: logw, PublicBaseURL: c.cfg.PublicBaseURL,
			Env: c.cfg.Env,
			Snapshot: func(ctx context.Context, app, room string, participant *string) (string, string, error) {
				svc, ok := maybe[*streams.Service](c, "streams")
				if !ok {
					return "", "", errUnavailable("streams")
				}
				r, err := svc.Snapshot(ctx, streams.SnapshotInput{AppName: app, RoomName: room, ParticipantIdentity: participant})
				if err != nil {
					return "", "", err
				}
				return r.Key, r.URL, nil
			},
			Clip: func(ctx context.Context, in streamflow.ClipInput) (*streamflow.ClipOutput, error) {
				svc, ok := maybe[*clips.Service](c, "clips")
				if !ok {
					return nil, errUnavailable("clips")
				}
				return streamflowClip(ctx, svc, in)
			},
			MQTT: func(ctx context.Context, app, topic string, payload any, qos int, retain bool) {
				if m, ok := maybe[*mqtt.Service](c, "mqtt"); ok {
					m.PublishRaw(ctx, app, topic, payload, &mqtt.PublishOptions{Qos: qos, Retain: retain})
				}
			},
			Notify: func(ctx context.Context, app, event string, payload *y.Map, title string, channels []string) {
				if n, ok := maybe[*notifications.Service](c, "notifications"); ok {
					n.Notify(ctx, app, event, payload, &notifications.Options{Title: title, Channels: channels})
				}
			},
		}
		if cb, ok := maybe[*callbacks.Service](c, "callbacks"); ok {
			deps.Callbacks = cb
		}
		if s3svc, ok := maybe[*s3.Service](c, "s3"); ok {
			deps.S3 = s3svc
		}
		runner := streamflow.NewRunner(deps)
		svc := streamflow.NewService(store, runner, apps, plugin, logw)
		if a, ok := maybe[*audit.Service](c, "audit"); ok {
			svc.Audit = a
		}

		provide(c, "streamflow", svc)
		c.modules = append(c.modules, &streamflow.Routes{Svc: svc, Secrets: secrets})
		c.starters = append(c.starters, func(ctx context.Context) {
			runner.Start(ctx)
			var subscribe func(func(app, event string, payload any)) func()
			if cb, ok := maybe[*callbacks.Service](c, "callbacks"); ok {
				subscribe = func(l func(app, event string, payload any)) func() { return cb.OnDispatch(l) }
			}
			svc.Start(ctx, subscribe)
			go func() {
				<-ctx.Done()
				store.CloseAll()
			}()
		})
		return nil
	})
}

// clipWait bounds action.clip's `wait` inside the 60 s run budget.
const clipWait = 45 * time.Second

// streamflowClip is the action.clip seam: a clips job whose origin links
// back to the triggering event and run (clip.ready carries it).
func streamflowClip(ctx context.Context, svc *clips.Service, in streamflow.ClipInput) (*streamflow.ClipOutput, error) {
	before, after := in.Before, in.After
	origin := &clips.Origin{Kind: "streamflow", Event: in.Event, WorkflowID: in.WorkflowID, RunID: in.RunID}
	if ms, ok := clips.ParseInstant(in.EventTs); ok {
		origin.EventTs = &ms
	}
	if in.Payload != nil {
		if raw, err := y.Stringify(in.Payload); err == nil {
			origin.Data = []byte(raw)
		}
	}
	clip, err := svc.Create(ctx, clips.CreateInput{
		App: in.App, Room: in.Room, Origin: origin,
		Request: clips.Request{EventTs: in.EventTs, Before: &before, After: &after},
	})
	if err != nil {
		return nil, err
	}
	if in.Wait {
		if done, err := svc.WaitDone(ctx, in.App, clip.ID, clipWait); err == nil {
			clip = done
		}
	}
	return &streamflow.ClipOutput{
		ClipID: clip.ID, Status: clip.Status, From: clip.From, To: clip.To, VodID: clip.VodID, URL: clip.URL, Error: clip.Error,
	}, nil
}

type unavailableErr string

func (e unavailableErr) Error() string { return string(e) + " service not available" }

func errUnavailable(name string) error { return unavailableErr(name) }

// aiKeyRef is the one ref the runner hands the AI client (runner.go).
const aiKeyRef = "STREAMFLOW_AI_API_KEY"

// aiKeyResolver keeps the operator-level AI key working now that the
// secrets store never reads env (security 3.3.3): secrets.json first, then
// os.Getenv — for that one fixed name only.
type aiKeyResolver struct{ store *s3.SecretsStore }

func (r aiKeyResolver) Get(ref string) (string, bool) {
	if v, ok := r.store.Get(ref); ok {
		return v, true
	}
	if ref == aiKeyRef {
		if v := os.Getenv(ref); v != "" {
			return v, true
		}
	}
	return "", false
}
