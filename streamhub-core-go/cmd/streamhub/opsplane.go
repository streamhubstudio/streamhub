package main

import (
	"context"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authn"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/backups"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/buildinfo"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/dbadmin"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/email"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/notifications"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/system"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tenancy"
)

// The ops plane: logs (+ the per-app app.log sink), email (binds the auth
// plane's mailer), notifications, system (GPU/hwaccel/settings/os-tuning),
// About / Build (GET /system/build + /system/changelog), db-admin + DB
// maintenance, and backups (+ the in-process daily schedule).
//
// Provides: "logs" (*logs.Service), "applog" (*logs.AppLog), "email"
// (*email.Service), "notifications" (*notifications.Service), "gpu"
// (*system.Gpu), "hwaccel" (*system.HwAccel), "backups" (*backups.Service).
//
// Optional, resolved at start (after every plane is wired): "callbacks"
// (notifications.Callbacks), "recording" (dbadmin.VodDeleter), "metrics"
// (system.GpuMetrics / system.TranscodeMetrics), "mqtt" (logs.MQTTSink).
func init() {
	registerPlane(30, "ops", func(ctx context.Context, c *core) error {
		logSvc := logs.New(c.cfg, c.global, c.log)
		logSvc.Init()
		appLog := logs.NewAppLog(c.cfg.DataDir, c.cfg.LogRetentionDays)

		apps, _ := maybe[contracts.AppsService](c, "apps")
		mail := email.New(c.cfg, email.SMTPTransport{}, apps, need[*tenancy.Service](c, "tenancy"), c.log)
		need[*authn.Service](c, "authn").SetMailer(email.AuthMailer{S: mail})

		notifier := notifications.New(c.cfg, appLog, notifications.HTTPPoster{}, mail)

		gpu := system.NewGpu(c.cfg, system.ExecRunner{}, system.OSDirReader, logSvc)
		hw := system.NewHwAccel(c.cfg, gpu, logSvc)
		sys := &system.Module{Gpu: gpu, HwAccel: hw, Settings: system.NewSettings(c.cfg, c.store, c.global)}

		aud := need[*audit.Service](c, "audit")
		dba := dbadmin.New(dbadmin.NewMaintenance(c.store, c.global, c.log), nil, aud)

		bk := backups.New(backups.ResolveSettings(c.cfg), c.store, c.global, logSvc, c.log)

		provide(c, "logs", logSvc)
		provide(c, "applog", appLog)
		provide(c, "email", mail)
		provide(c, "notifications", notifier)
		provide(c, "gpu", gpu)
		provide(c, "hwaccel", hw)
		provide(c, "backups", bk)

		c.modules = append(c.modules, logSvc, mail, sys, buildinfo.New(), dba, bk)
		c.binds = append(c.binds, func() {
			if cb, ok := maybe[notifications.Callbacks](c, "callbacks"); ok {
				notifier.SetCallbacks(cb)
			}
			if rec, ok := maybe[dbadmin.VodDeleter](c, "recording"); ok {
				dba.SetVods(rec)
			}
			if m, ok := maybe[system.GpuMetrics](c, "metrics"); ok {
				gpu.SetMetrics(m)
			}
			if m, ok := maybe[system.TranscodeMetrics](c, "metrics"); ok {
				hw.SetMetrics(m)
			}
			if m, ok := maybe[logs.MQTTSink](c, "mqtt"); ok {
				logSvc.SetMQTTSink(m)
			}
		})
		c.starters = append(c.starters, func(ctx context.Context) {
			logSvc.Start(ctx)
			// GpuService.onModuleInit: warm probe so /system/gpu is fast.
			go gpu.Refresh(ctx)
			backups.NewScheduler(bk).Start(ctx)
			go func() {
				<-ctx.Done()
				appLog.Close()
			}()
		})
		return nil
	})
}
