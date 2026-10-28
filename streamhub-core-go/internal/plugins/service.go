package plugins

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

// Port of plugins.service.ts: the catalog × per-app install state, config
// validation, the worker hook (reconcile on install/patch, boot resume) and
// the worker → core live-data / domain-event channels.

// LogsService is the logs surface (write + the per-plugin persisted view).
type LogsService interface {
	LogWriter
	Query(ctx context.Context, f logs.Filters) []logs.Entry
}

// ScopeResolver is the per-stream plugin opt-out resolver (streams module).
type ScopeResolver interface {
	ResolveDisabled(ctx context.Context, app string, scope streams.StreamScope) []string
}

// VisionSink taps vision-family events (vision-apps module).
type VisionSink interface {
	Record(app, event string, payload *y.Map)
}

var visionPrefixes = []string{"occupancy.", "count.", "crowd.", "demography."}

// IsVisionEvent reports a vision-family event name.
func IsVisionEvent(event string) bool {
	for _, p := range visionPrefixes {
		if strings.HasPrefix(event, p) {
			return true
		}
	}
	return false
}

// Service is PluginsService.
type Service struct {
	registry  *Registry
	repo      *Repo
	workers   *Manager
	apps      contracts.AppsService
	logs      LogsService
	livedata  *LiveData
	scope     ScopeResolver
	callbacks Dispatcher
	vision    VisionSink
	log       *slog.Logger
	// edgeIngest accepts the scoped ingest token of a live edge assignment
	// (bound late by the cluster plane; nil = local workers only).
	edgeIngest EdgeIngestVerifier
}

// EdgeIngestVerifier reports whether token is the ingest token of one of the
// app's active edge assignments of the plugin (edge.IngestVerifier.Valid).
type EdgeIngestVerifier func(ctx context.Context, app, pluginID, token string) bool

// SetEdgeIngest binds the edge ingest-token verifier.
//
// GO-DIVERGENCE: Node only accepts the token of a worker running ON the
// master, so the events/live posts of every edge-assigned worker (whose
// STREAMHUB_INGEST_TOKEN is HMAC(cluster token, app:plugin:room)) are 401 and
// edge results never reach the app; Go also accepts that scoped token.
func (s *Service) SetEdgeIngest(v EdgeIngestVerifier) { s.edgeIngest = v }

// ServiceDeps wires the service; Scope / Callbacks / Vision are optional.
type ServiceDeps struct {
	Registry  *Registry
	Repo      *Repo
	Workers   *Manager
	Apps      contracts.AppsService
	Logs      LogsService
	LiveData  *LiveData
	Scope     ScopeResolver
	Callbacks Dispatcher
	Vision    VisionSink
	Log       *slog.Logger
}

// NewService builds the service.
// SetVision binds the vision sink late (the vision-apps plane wires after
// this one).
func (s *Service) SetVision(v VisionSink) { s.vision = v }

func NewService(d ServiceDeps) *Service {
	return &Service{registry: d.Registry, repo: d.Repo, workers: d.Workers, apps: d.Apps, logs: d.Logs,
		livedata: d.LiveData, scope: d.Scope, callbacks: d.Callbacks, vision: d.Vision, log: d.Log}
}

// View is a marketplace entry (PluginView).
type View struct {
	Manifest      Manifest     `json:"manifest"`
	Installed     bool         `json:"installed"`
	Enabled       bool         `json:"enabled"`
	Config        *y.Map       `json:"config"`
	InstalledAt   *string      `json:"installedAt"`
	UpdatedAt     *string      `json:"updatedAt"`
	Worker        *WorkerState `json:"worker,omitempty"`
	WorkerVersion *string      `json:"workerVersion"`
}

// PublicOverlay is the anonymous view of an enabled player plugin.
type PublicOverlay struct {
	ID       string         `json:"id"`
	Manifest PublicManifest `json:"manifest"`
	Config   *y.Map         `json:"config"`
}

// PublicManifest is the trimmed manifest of a public overlay.
type PublicManifest struct {
	Name         string  `json:"name"`
	UI           string  `json:"ui"`
	ConfigSchema []any   `json:"configSchema"`
	Icon         *string `json:"icon,omitempty"`
}

// Logs is the per-plugin logs view.
type Logs struct {
	PluginID   string       `json:"pluginId"`
	Worker     *WorkerState `json:"worker,omitempty"`
	WorkerLogs []LogLine    `json:"workerLogs"`
	Persisted  []logs.Entry `json:"persisted"`
}

// Scope is a player's ?stream= / ?room= scope.
type Scope struct{ Stream, Room string }

func (s *Service) disabledFor(ctx context.Context, app string, sc *Scope) map[string]bool {
	out := map[string]bool{}
	if sc == nil || (sc.Stream == "" && sc.Room == "") || s.scope == nil {
		return out
	}
	for _, id := range s.scope.ResolveDisabled(ctx, app, streams.StreamScope{Stream: sc.Stream, Room: sc.Room}) {
		out[id] = true
	}
	return out
}

func (s *Service) requireApp(ctx context.Context, app string) (*contracts.AppRecord, error) {
	rec, err := s.apps.Get(ctx, app)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	return rec, nil
}

func (s *Service) requireMeta(id string) (*Meta, error) {
	if m := s.registry.GetMeta(id); m != nil {
		return m, nil
	}
	return nil, httpx.NotFound(fmt.Sprintf("plugin '%s' not found", id))
}

func (s *Service) appTimezone(ctx context.Context, app string) string {
	cfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		return ""
	}
	return cfg.Timezone
}

func (s *Service) write(level, source, message string, meta any, appID *int64) {
	if s.logs != nil {
		s.logs.Write(level, source, message, meta, appID)
	}
}

// configOf is the effective config (validated stored, or defaults). A
// stored config that no longer validates surfaces the error (500 in Node).
func configOf(meta *Meta, row *Installed) (*y.Map, error) {
	if row == nil {
		return DefaultConfig(meta), nil
	}
	return ValidateConfig(meta, row.Config, false)
}

func ptrStr(s string) *string { return &s }

func (s *Service) view(ctx context.Context, app string, meta *Meta, row *Installed, disabled bool) (View, error) {
	cfg, err := configOf(meta, row)
	if err != nil {
		return View{}, httpx.Internal(err.Error())
	}
	v := View{Manifest: ToManifest(meta), Installed: row != nil, Config: RedactSecrets(meta, cfg)}
	if row != nil {
		v.Enabled = row.Enabled && !disabled
		v.InstalledAt, v.UpdatedAt = ptrStr(row.InstalledAt), ptrStr(row.UpdatedAt)
		v.WorkerVersion = row.WorkerVersion
		if meta.NeedsWorker {
			st := s.workers.Status(app, meta.ID)
			v.Worker = &st
		}
	}
	return v, nil
}

// List is the marketplace (every catalog plugin × this app's install).
func (s *Service) List(ctx context.Context, app string, sc *Scope) ([]View, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	disabled := s.disabledFor(ctx, app, sc)
	rows, err := s.repo.List(ctx, app)
	if err != nil {
		return nil, err
	}
	installed := map[string]*Installed{}
	for _, r := range rows {
		installed[r.PluginID] = r
	}
	out := []View{}
	for _, man := range s.registry.ListManifests() {
		meta := s.registry.GetMeta(man.ID)
		v, err := s.view(ctx, app, meta, installed[man.ID], disabled[man.ID])
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// PublicOverlays is the anonymous enabled player/player-overlay set.
func (s *Service) PublicOverlays(ctx context.Context, app string, sc *Scope) ([]PublicOverlay, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	disabled := s.disabledFor(ctx, app, sc)
	rows, err := s.repo.List(ctx, app)
	if err != nil {
		return nil, err
	}
	out := []PublicOverlay{}
	for _, row := range rows {
		if !row.Enabled || disabled[row.PluginID] {
			continue
		}
		meta := s.registry.GetMeta(row.PluginID)
		if meta == nil || (meta.UI != "player-overlay" && meta.UI != "player") {
			continue
		}
		cfg, err := ValidateConfig(meta, row.Config, false)
		if err != nil {
			return nil, httpx.Internal(err.Error())
		}
		schema := meta.ConfigSchema
		if schema == nil {
			schema = []any{}
		}
		out = append(out, PublicOverlay{ID: meta.ID, Manifest: PublicManifest{Name: meta.Name, UI: meta.UI, ConfigSchema: schema, Icon: meta.Icon},
			Config: SanitizePublicConfig(meta, cfg)})
	}
	return out, nil
}

// Get is one marketplace entry.
func (s *Service) Get(ctx context.Context, app, id string) (View, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return View{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return View{}, err
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, app, meta, row, false)
}

type appMeta struct {
	App string `json:"app"`
}

// Install installs (disabled, defaults) idempotently.
func (s *Service) Install(ctx context.Context, app, id string) (View, error) {
	rec, err := s.requireApp(ctx, app)
	if err != nil {
		return View{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return View{}, err
	}
	existing, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return View{}, err
	}
	if existing == nil {
		if err := s.repo.Install(ctx, app, id, DefaultConfig(meta), false); err != nil {
			return View{}, err
		}
		s.write("info", "plugin:"+id, fmt.Sprintf("installed into app '%s'", app), appMeta{app}, &rec.ID)
		s.reconcileWorker(ctx, app, id)
	}
	return s.Get(ctx, app, id)
}

// Patch is the PATCH input (nil = absent).
type Patch struct {
	Enabled *bool
	Config  *y.Map
}

func badRequestOnConfig(err error) error {
	var ce *ConfigError
	if errors.As(err, &ce) {
		return httpx.BadRequest(ce.Msg)
	}
	return err
}

type updatedFlags struct {
	Enabled       *bool `json:"enabled,omitempty"`
	ConfigChanged bool  `json:"configChanged"`
}

// Patch enables/disables and/or reconfigures an install.
func (s *Service) Patch(ctx context.Context, app, id string, p Patch) (View, error) {
	rec, err := s.requireApp(ctx, app)
	if err != nil {
		return View{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return View{}, err
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return View{}, err
	}
	if row == nil {
		return View{}, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not installed in app '%s'", id, app))
	}
	willEnable := row.Enabled
	if p.Enabled != nil {
		willEnable = *p.Enabled
	}
	var next *y.Map
	if p.Config != nil {
		merged := y.Assign(row.Config.Clone(), p.Config)
		if next, err = ValidateConfig(meta, merged, willEnable); err != nil {
			return View{}, badRequestOnConfig(err)
		}
	} else if p.Enabled != nil && *p.Enabled {
		if _, err := ValidateConfig(meta, row.Config, true); err != nil {
			return View{}, badRequestOnConfig(err)
		}
	}
	if err := s.repo.Update(ctx, app, id, p.Enabled, next); err != nil {
		return View{}, err
	}
	flags, _ := stringifyJS(updatedFlags{Enabled: p.Enabled, ConfigChanged: next != nil})
	s.write("info", "plugin:"+id, fmt.Sprintf("updated in app '%s' (%s)", app, flags), appMeta{app}, &rec.ID)
	s.reconcileWorker(ctx, app, id)
	return s.Get(ctx, app, id)
}

// Remove uninstalls (stops the worker, drops the row + live data).
func (s *Service) Remove(ctx context.Context, app, id string) error {
	rec, err := s.requireApp(ctx, app)
	if err != nil {
		return err
	}
	if _, err := s.requireMeta(id); err != nil {
		return err
	}
	s.workers.Stop(app, id)
	s.livedata.Clear(app, id)
	if err := s.repo.Remove(ctx, app, id); err != nil {
		return err
	}
	s.write("info", "plugin:"+id, fmt.Sprintf("uninstalled from app '%s'", app), appMeta{app}, &rec.ID)
	return nil
}

func noWorker(id string) error { return httpx.BadRequest(fmt.Sprintf("plugin '%s' has no worker", id)) }

// StartWorker explicitly (re)starts a worker.
func (s *Service) StartWorker(ctx context.Context, app, id string) (WorkerState, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return WorkerState{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return WorkerState{}, err
	}
	if !meta.NeedsWorker || meta.Worker == nil {
		return WorkerState{}, noWorker(id)
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return WorkerState{}, err
	}
	if row == nil {
		return WorkerState{}, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not installed in app '%s'", id, app))
	}
	if !row.Enabled {
		return WorkerState{}, httpx.BadRequest(fmt.Sprintf("plugin '%s' must be enabled before starting its worker", id))
	}
	cfg, err := ValidateConfig(meta, row.Config, true)
	if err != nil {
		return WorkerState{}, badRequestOnConfig(err)
	}
	st, err := s.startWorker(ctx, meta, app, cfg)
	if err != nil {
		return WorkerState{}, err
	}
	_ = s.repo.SetWorkerDesired(ctx, app, id, "running")
	return st, nil
}

func (s *Service) startWorker(ctx context.Context, meta *Meta, app string, cfg *y.Map) (WorkerState, error) {
	rec, _ := s.apps.Get(ctx, app)
	var appID *int64
	if rec != nil {
		appID = &rec.ID
	}
	return s.workers.Start(ctx, meta, app, s.apps.AppDir(app), cfg, appID, s.appTimezone(ctx, app))
}

// StopWorker explicitly stops a worker.
func (s *Service) StopWorker(ctx context.Context, app, id string) (WorkerState, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return WorkerState{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return WorkerState{}, err
	}
	if !meta.NeedsWorker {
		return WorkerState{}, noWorker(id)
	}
	st := s.workers.Stop(app, id)
	_ = s.repo.SetWorkerDesired(ctx, app, id, "stopped")
	return st, nil
}

// WorkerStatus is a needsWorker plugin's state.
func (s *Service) WorkerStatus(ctx context.Context, app, id string) (WorkerState, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return WorkerState{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return WorkerState{}, err
	}
	if !meta.NeedsWorker {
		return WorkerState{}, noWorker(id)
	}
	return s.workers.Status(app, id), nil
}

func (s *Service) checkIngest(ctx context.Context, app, id, token string, meta *Meta, what string) error {
	if !meta.NeedsWorker {
		return httpx.BadRequest(fmt.Sprintf("plugin '%s' has no worker — %s ingest is worker-only", id, what))
	}
	expected := s.workers.IngestToken(app, id)
	if token != "" && expected != "" && token == expected {
		return nil
	}
	if token != "" && s.edgeIngest != nil && s.edgeIngest(ctx, app, id, token) {
		return nil
	}
	return httpx.Unauthorized("invalid or missing ingest token")
}

// OK is the {ok:true} ack.
type OK struct {
	OK bool `json:"ok"`
}

// IngestLive stores a worker's latest live payload.
func (s *Service) IngestLive(ctx context.Context, app, id, token string, body any) (OK, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return OK{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return OK{}, err
	}
	if err := s.checkIngest(ctx, app, id, token, meta, "live"); err != nil {
		return OK{}, err
	}
	payload, ok := body.(*y.Map)
	if !ok || payload == nil {
		return OK{}, httpx.BadRequest("live payload must be a JSON object")
	}
	room := ""
	if r, ok := payload.Get("room").(string); ok {
		room = y.Trim(r)
	}
	if room == "" {
		return OK{}, httpx.BadRequest("live payload must carry a 'room'")
	}
	if !s.livedata.Push(app, id, room, payload) {
		return OK{}, httpx.BadRequest("live payload too large")
	}
	return OK{true}, nil
}

// EventAck is the {ok, event} ack.
type EventAck struct {
	OK    bool   `json:"ok"`
	Event string `json:"event"`
}

type eventLogMeta struct {
	App   string `json:"app"`
	Event string `json:"event"`
}

// IngestEvent relays a worker's declared domain event through callbacks.
func (s *Service) IngestEvent(ctx context.Context, app, id, token string, body any) (EventAck, error) {
	rec, err := s.requireApp(ctx, app)
	if err != nil {
		return EventAck{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return EventAck{}, err
	}
	if err := s.checkIngest(ctx, app, id, token, meta, "event"); err != nil {
		return EventAck{}, err
	}
	m, ok := body.(*y.Map)
	if !ok || m == nil {
		return EventAck{}, httpx.BadRequest("event payload must be a JSON object")
	}
	// GO-DIVERGENCE: the vision runtime (vision_edge/events.py) posts BATCHES
	// {"events":[{event, room, ts, …flat fields}]}, which Node answers 400
	// ("must carry an 'event' name"), so no worker-batched event reached the
	// app. Each item is relayed as its own event (flat fields = the payload).
	if items, ok := m.Get("events").([]any); ok && y.IsUndefined(m.Get("event")) {
		return s.ingestBatch(app, id, rec.ID, meta, items)
	}
	event := ""
	if e, ok := m.Get("event").(string); ok {
		event = y.Trim(e)
	}
	if event == "" {
		return EventAck{}, httpx.BadRequest("event payload must carry an 'event' name")
	}
	declared := false
	for _, e := range meta.Events {
		declared = declared || e == event
	}
	if !declared {
		return EventAck{}, httpx.BadRequest(fmt.Sprintf("plugin '%s' does not declare event '%s' in its manifest", id, event))
	}
	room := ""
	if r, ok := m.Get("room").(string); ok {
		room = y.Trim(r)
	}
	payload := y.NewMap()
	if data, ok := m.Get("data").(*y.Map); ok && data != nil {
		payload = data.Clone()
	}
	payload.Set("plugin", id)
	payload.Set("room", room)
	s.relayEvent(app, id, rec.ID, event, room, payload)
	return EventAck{true, event}, nil
}

// relayEvent logs + dispatches one accepted worker event.
func (s *Service) relayEvent(app, id string, appID int64, event, room string, payload *y.Map) {
	logRoom := room
	if logRoom == "" {
		logRoom = "-"
	}
	s.write("info", "plugin:"+id, fmt.Sprintf("event '%s' (room '%s')", event, logRoom), eventLogMeta{app, event}, &appID)
	if s.callbacks != nil {
		go func() { _ = s.callbacks.Dispatch(context.Background(), app, event, payload) }()
	}
	if s.vision != nil && IsVisionEvent(event) {
		s.vision.Record(app, event, payload)
	}
}

// ingestBatch relays a {"events":[…]} batch: every item must be an object
// with a declared event name (the whole batch is refused otherwise, so the
// worker re-spools it); flat fields other than `event` form the payload.
func (s *Service) ingestBatch(app, id string, appID int64, meta *Meta, items []any) (EventAck, error) {
	type one struct {
		event, room string
		payload     *y.Map
	}
	batch := make([]one, 0, len(items))
	for _, it := range items {
		m, ok := it.(*y.Map)
		if !ok || m == nil {
			return EventAck{}, httpx.BadRequest("event payload must be a JSON object")
		}
		event := ""
		if e, ok := m.Get("event").(string); ok {
			event = y.Trim(e)
		}
		if event == "" {
			return EventAck{}, httpx.BadRequest("event payload must carry an 'event' name")
		}
		declared := false
		for _, e := range meta.Events {
			declared = declared || e == event
		}
		if !declared {
			return EventAck{}, httpx.BadRequest(fmt.Sprintf("plugin '%s' does not declare event '%s' in its manifest", id, event))
		}
		room := ""
		if r, ok := m.Get("room").(string); ok {
			room = y.Trim(r)
		}
		payload := m.Clone()
		if data, ok := m.Get("data").(*y.Map); ok && data != nil {
			payload = data.Clone()
		}
		payload.Delete("event")
		payload.Set("plugin", id)
		payload.Set("room", room)
		batch = append(batch, one{event, room, payload})
	}
	last := ""
	for _, e := range batch {
		s.relayEvent(app, id, appID, e.event, e.room, e.payload)
		last = e.event
	}
	return EventAck{true, last}, nil
}

func emptyLive() *LiveDataView { return &LiveDataView{} }

// LiveData is the authenticated latest payload of any installed plugin.
func (s *Service) LiveData(ctx context.Context, app, id, room string) (*LiveDataView, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	if _, err := s.requireMeta(id); err != nil {
		return nil, err
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, httpx.NotFound(fmt.Sprintf("plugin '%s' is not installed in app '%s'", id, app))
	}
	if v := s.livedata.Latest(app, id, y.Trim(room)); v != nil {
		return v, nil
	}
	return emptyLive(), nil
}

// LiveOverlayData is the public read for an enabled player-overlay plugin.
func (s *Service) LiveOverlayData(ctx context.Context, app, id, room string) (*LiveDataView, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return nil, err
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if meta.UI != "player-overlay" || row == nil || !row.Enabled {
		return nil, httpx.NotFound(fmt.Sprintf("plugin '%s' has no public live data for app '%s'", id, app))
	}
	if v := s.livedata.Latest(app, id, y.Trim(room)); v != nil {
		return v, nil
	}
	return emptyLive(), nil
}

// LiveWorkerData is the authenticated read for an enabled worker plugin.
func (s *Service) LiveWorkerData(ctx context.Context, app, id, room string) (*LiveDataView, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return nil, err
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if !meta.NeedsWorker || row == nil || !row.Enabled {
		return nil, httpx.NotFound(fmt.Sprintf("plugin '%s' has no live data for app '%s'", id, app))
	}
	if v := s.livedata.Latest(app, id, y.Trim(room)); v != nil {
		return v, nil
	}
	return emptyLive(), nil
}

// GetLogs is the worker ring buffer + persisted `plugin:<id>` rows.
func (s *Service) GetLogs(ctx context.Context, app, id string, limit int) (Logs, error) {
	if _, err := s.requireApp(ctx, app); err != nil {
		return Logs{}, err
	}
	meta, err := s.requireMeta(id)
	if err != nil {
		return Logs{}, err
	}
	out := Logs{PluginID: id, WorkerLogs: []LogLine{}, Persisted: []logs.Entry{}}
	if s.logs != nil {
		lim := 500
		for _, e := range s.logs.Query(ctx, logs.Filters{App: app, Limit: &lim}) {
			if e.Source == "plugin:"+id && len(out.Persisted) < limit {
				out.Persisted = append(out.Persisted, e)
			}
		}
	}
	if meta.NeedsWorker {
		st := s.workers.Status(app, id)
		out.Worker = &st
		out.WorkerLogs = s.workers.Logs(app, id, limit)
	}
	return out, nil
}

// reconcileWorker aligns the process with the install state.
func (s *Service) reconcileWorker(ctx context.Context, app, id string) {
	meta := s.registry.GetMeta(id)
	if meta == nil || !meta.NeedsWorker || meta.Worker == nil {
		return
	}
	row, err := s.repo.Get(ctx, app, id)
	if err != nil {
		return
	}
	if row == nil || !row.Enabled {
		s.workers.Stop(app, id)
		_ = s.repo.SetWorkerDesired(ctx, app, id, "stopped")
		return
	}
	cfg, err := ValidateConfig(meta, row.Config, true)
	if err != nil {
		s.workers.Stop(app, id)
		return
	}
	s.workers.Stop(app, id)
	if _, err := s.startWorker(ctx, meta, app, cfg); err == nil {
		_ = s.repo.SetWorkerDesired(ctx, app, id, "running")
	}
}

// ResumeDesiredWorkers restarts every worker whose intent is 'running'
// (backfilling a NULL intent from enabled). app "" = every app.
func (s *Service) ResumeDesiredWorkers(ctx context.Context, app string) int {
	var names []string
	if app != "" {
		names = []string{app}
	} else {
		list, err := s.apps.List(ctx, nil)
		if err != nil {
			return 0
		}
		for _, a := range list {
			names = append(names, a.Name)
		}
	}
	started := 0
	for _, name := range names {
		rows, err := s.repo.List(ctx, name)
		if err != nil {
			continue
		}
		for _, row := range rows {
			meta := s.registry.GetMeta(row.PluginID)
			if meta == nil || !meta.NeedsWorker || meta.Worker == nil {
				continue
			}
			desired := ""
			if row.WorkerDesired != nil {
				desired = *row.WorkerDesired
			} else {
				desired = "stopped"
				if row.Enabled {
					desired = "running"
				}
				_ = s.repo.SetWorkerDesired(ctx, name, row.PluginID, desired)
			}
			if desired != "running" || !row.Enabled || s.workers.IsRunning(name, row.PluginID) {
				continue
			}
			cfg, err := ValidateConfig(meta, row.Config, true)
			if err != nil {
				continue
			}
			if _, err := s.startWorker(ctx, meta, name, cfg); err == nil {
				started++
			}
		}
	}
	return started
}

type errorMeta struct {
	Error string `json:"error"`
}

// Boot is onApplicationBootstrap: resume desired workers.
func (s *Service) Boot(ctx context.Context) {
	n := s.ResumeDesiredWorkers(ctx, "")
	s.write("info", "plugins", fmt.Sprintf("worker boot-resume: started %d", n), struct{}{}, nil)
}
