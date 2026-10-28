package main

import (
	"context"
	"net/http"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/callbacks"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/mqtt"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/s3"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streamflow"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

// The streamflow plane: the Streamflow engine (store + runner + trigger
// service + secrets + AI client) and its 16 routes.
//
// Needs "apps". Optional, resolved lazily at call time (so plane order
// within 50 does not matter): "plugins.repo" (install state + config),
// "callbacks" (trigger tap + emit + lifecycle), "mqtt" (action.mqtt),
// "streams" (action.snapshot), "notifications" (action.notify), "s3" +
// "s3.secrets" (action.s3 + the AI key ref), "logsink".
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
		ai := &streamflow.AIClient{Usage: store, HTTP: &http.Client{}, Resolve: security.DefaultHostResolver, Now: time.Now}
		if sec, ok := maybe[*s3.SecretsStore](c, "s3.secrets"); ok {
			ai.Secrets = sec
		}
		secrets := streamflow.NewSecrets(store, apps, c.cfg.JWTSecret)

		deps := streamflow.RunnerDeps{
			Store: store, Apps: apps, Plugin: plugin, AI: ai, Secrets: secrets, Logs: logw, PublicBaseURL: c.cfg.PublicBaseURL,
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

type unavailableErr string

func (e unavailableErr) Error() string { return string(e) + " service not available" }

func errUnavailable(name string) error { return unavailableErr(name) }
