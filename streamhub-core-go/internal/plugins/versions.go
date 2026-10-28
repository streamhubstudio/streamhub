package plugins

import (
	"context"
	"fmt"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Port of appstore/plugin-version.service.ts: per-app pin / rollback /
// version view over the app-agnostic store, plus the delete-refusal scan.

// AppVersionView is GET /apps/:app/plugins/:id/versions.
type AppVersionView struct {
	PluginID  string          `json:"pluginId"`
	App       string          `json:"app"`
	Active    *string         `json:"active"`
	Effective *string         `json:"effective"`
	Available VersionCatalog  `json:"available"`
	History   []VersionChange `json:"history"`
}

// Versions is PluginVersionService.
type Versions struct {
	svc     *Service
	store   *Appstore
	history *History
}

// NewVersions builds the service.
func NewVersions(svc *Service, store *Appstore, history *History) *Versions {
	return &Versions{svc: svc, store: store, history: history}
}

// View is the per-app version state.
func (v *Versions) View(ctx context.Context, app, id string) (AppVersionView, error) {
	if _, err := v.svc.requireApp(ctx, app); err != nil {
		return AppVersionView{}, err
	}
	if _, err := v.svc.requireMeta(id); err != nil {
		return AppVersionView{}, err
	}
	row, err := v.svc.repo.Get(ctx, app, id)
	if err != nil {
		return AppVersionView{}, err
	}
	var active *string
	if row != nil {
		active = row.WorkerVersion
	}
	available := v.store.ListVersions(id)
	effective := active
	if effective == nil {
		effective = available.BuiltinVersion
	}
	return AppVersionView{PluginID: id, App: app, Active: active, Effective: effective,
		Available: available, History: v.history.List(ctx, app, id, 50)}, nil
}

func eqPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (v *Versions) installed(ctx context.Context, app, id string) (*Installed, int64, error) {
	rec, err := v.svc.requireApp(ctx, app)
	if err != nil {
		return nil, 0, err
	}
	if _, err := v.svc.requireMeta(id); err != nil {
		return nil, 0, err
	}
	row, err := v.svc.repo.Get(ctx, app, id)
	if err != nil {
		return nil, 0, err
	}
	if row == nil {
		return nil, 0, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not installed in app '%s'", id, app))
	}
	return row, rec.ID, nil
}

// Pin pins (or unpins, version nil) the version an install runs.
func (v *Versions) Pin(ctx context.Context, app, id string, version *string) (AppVersionView, error) {
	row, appID, err := v.installed(ctx, app, id)
	if err != nil {
		return AppVersionView{}, err
	}
	if version != nil && !v.store.HasVersion(id, *version) {
		return AppVersionView{}, httpx.NotFound(fmt.Sprintf("version '%s' of '%s' is not in the appstore", *version, id))
	}
	if !eqPtr(row.WorkerVersion, version) {
		v.applyPin(ctx, app, id, row.WorkerVersion, version, "pin", appID)
	}
	return v.View(ctx, app, id)
}

// Rollback repins to the `from` of the latest history entry.
func (v *Versions) Rollback(ctx context.Context, app, id string) (AppVersionView, error) {
	row, appID, err := v.installed(ctx, app, id)
	if err != nil {
		return AppVersionView{}, err
	}
	last := v.history.Latest(ctx, app, id)
	if last == nil {
		return AppVersionView{}, httpx.BadRequest(fmt.Sprintf("no version history for '%s' in app '%s' — nothing to roll back to", id, app))
	}
	target := last.From
	if target != nil && !v.store.HasVersion(id, *target) {
		return AppVersionView{}, httpx.BadRequest(fmt.Sprintf("rollback target '%s' is no longer in the appstore", *target))
	}
	if !eqPtr(row.WorkerVersion, target) {
		v.applyPin(ctx, app, id, row.WorkerVersion, target, "rollback", appID)
	}
	return v.View(ctx, app, id)
}

// DeleteVersion deletes a stored version unless an install pins it.
func (v *Versions) DeleteVersion(ctx context.Context, id, version string) error {
	if _, err := v.svc.requireMeta(id); err != nil {
		return err
	}
	if pinned := v.AppsPinning(ctx, id, version); len(pinned) > 0 {
		shown := pinned
		if len(shown) > 5 {
			shown = shown[:5]
		}
		more := ""
		if len(pinned) > 5 {
			more = "…"
		}
		return httpx.Conflict(fmt.Sprintf("version '%s' of '%s' is pinned by %d app(s) (%s%s) — unpin first",
			version, id, len(pinned), strings.Join(shown, ", "), more))
	}
	return v.store.DeleteVersion(id, version)
}

// AppsPinning lists the apps whose install of id pins version.
func (v *Versions) AppsPinning(ctx context.Context, id, version string) []string {
	list, err := v.svc.apps.List(ctx, nil)
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range list {
		if row, err := v.svc.repo.Get(ctx, a.Name, id); err == nil && row != nil && row.WorkerVersion != nil && *row.WorkerVersion == version {
			out = append(out, a.Name)
		}
	}
	return out
}

type pinLogMeta struct {
	App    string  `json:"app"`
	From   *string `json:"from"`
	To     *string `json:"to"`
	Action string  `json:"action"`
}

type versionChanged struct {
	Plugin string  `json:"plugin"`
	App    string  `json:"app"`
	From   *string `json:"from"`
	To     *string `json:"to"`
	Action string  `json:"action"`
}

func orBuiltin(s *string) string {
	if s == nil {
		return "builtin"
	}
	return *s
}

func (v *Versions) applyPin(ctx context.Context, app, id string, from, to *string, action string, appID int64) {
	_ = v.svc.repo.SetWorkerVersion(ctx, app, id, to)
	_ = v.history.Record(ctx, app, id, from, to)
	v.svc.write("info", "plugin:"+id, fmt.Sprintf("version %s: %s → %s (app '%s')", action, orBuiltin(from), orBuiltin(to), app),
		pinLogMeta{app, from, to, action}, &appID)
	v.restartIfRunning(ctx, app, id, appID)
	if v.svc.callbacks != nil {
		go func() {
			_ = v.svc.callbacks.Dispatch(context.Background(), app, "plugin.version_changed", versionChanged{id, app, from, to, action})
		}()
	}
}

func (v *Versions) restartIfRunning(ctx context.Context, app, id string, appID int64) {
	meta := v.svc.registry.GetMeta(id)
	if meta == nil || !meta.NeedsWorker || meta.Worker == nil || !v.svc.workers.IsRunning(app, id) {
		return
	}
	row, err := v.svc.repo.Get(ctx, app, id)
	if err != nil || row == nil || !row.Enabled {
		return
	}
	cfg, err := ValidateConfig(meta, row.Config, true)
	if err != nil {
		return
	}
	v.svc.workers.Stop(app, id)
	_, _ = v.svc.workers.Start(ctx, meta, app, v.svc.apps.AppDir(app), cfg, &appID, "")
}
