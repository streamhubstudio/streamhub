package visionapps

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/edge"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/pipeline"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/tags"
)

// Port of vision.service.ts: per-model reads, settings, config resolution
// (model defaults → tag configs → per-room override) and the pipeline
// dashboard aggregate.

// Tags is the tags repository surface the resolver reads.
type Tags interface {
	Get(ctx context.Context, app, slug string) (*tags.TagRecord, error)
}

// Assignments lists an app's edge assignments.
type Assignments interface {
	List(ctx context.Context, app string) ([]edge.Assignment, error)
}

// Gateway reports a node's live edge WS.
type Gateway interface {
	IsConnected(nodeID string) bool
}

// Deps wires the service. Assignments / Gateway / Tags are resolved lazily
// (nil-safe: zero counts / no tag layers).
type Deps struct {
	Store       *Store
	Registry    *plugins.Registry
	Installs    *plugins.Repo
	DB          *db.Service
	Global      *sql.DB
	Apps        contracts.AppsService
	Tags        func() Tags
	Assignments func() Assignments
	Gateway     func() Gateway
}

// Service is VisionAppService.
type Service struct {
	d   Deps
	now func() time.Time
}

// New builds the service.
func New(d Deps) *Service { return &Service{d: d, now: time.Now} }

func (s *Service) pluginConfig(ctx context.Context, app, model string) *y.Map {
	meta := s.d.Registry.GetMeta(model)
	if meta == nil {
		return y.NewMap()
	}
	row, _ := s.d.Installs.Get(ctx, app, model)
	if row == nil {
		return plugins.DefaultConfig(meta)
	}
	cfg, err := plugins.ValidateConfig(meta, row.Config, false)
	if err != nil {
		return plugins.DefaultConfig(meta)
	}
	return cfg
}

func (s *Service) isEnabled(ctx context.Context, app, model string) bool {
	row, _ := s.d.Installs.Get(ctx, app, model)
	return row != nil && row.Enabled
}

func modelDefaults(model string, cfg *y.Map) *y.Map {
	base := EmptyModelSettings(model)
	if f, ok := cfg.Get("fps").(float64); ok && model == "counting" {
		base.Set("fps", f)
	}
	if e, ok := cfg.Get("engine").(string); ok && model == "demography" {
		base.Set("engine", e)
	}
	return base
}

func (s *Service) roomTags(ctx context.Context, app, room string) []string {
	out := []string{}
	h, err := s.d.DB.App(ctx, app)
	if err != nil {
		return out
	}
	rows, err := h.QueryContext(ctx, `SELECT tags FROM streams WHERE room = ?`, room)
	if err != nil {
		return out
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var t sql.NullString
		if rows.Scan(&t) != nil || !t.Valid || t.String == "" {
			continue
		}
		v, err := y.ParseJSON([]byte(t.String))
		if err != nil {
			continue
		}
		list, _ := v.([]any)
		for _, e := range list {
			if s, ok := e.(string); ok && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out
}

func (s *Service) tagConfigs(ctx context.Context, app, room, model string) []any {
	out := []any{}
	if s.d.Tags == nil || s.d.Tags() == nil {
		return out
	}
	for _, slug := range s.roomTags(ctx, app, room) {
		tag, err := s.d.Tags().Get(ctx, app, slug)
		if err != nil || tag == nil || tag.ConfigJSON == nil {
			continue
		}
		if block, ok := tag.ConfigJSON.Get(model).(*y.Map); ok && block != nil {
			out = append(out, block)
		}
	}
	return out
}

// ResolveModelConfig is the effective config_json of (model, room).
func (s *Service) ResolveModelConfig(ctx context.Context, app, model, room string) *y.Map {
	cfg := s.pluginConfig(ctx, app, model)
	var override *y.Map
	if row, err := s.d.Store.GetSetting(ctx, app, s.d.Apps.AppDir(app), model, room); err == nil && row != nil {
		override = row.Config
	}
	return tags.ResolveStreamSettings(modelDefaults(model, cfg), s.tagConfigs(ctx, app, room, model), override)
}

func (s *Service) requireApp(ctx context.Context, app string) error {
	rec, err := s.d.Apps.Get(ctx, app)
	if err != nil {
		return err
	}
	if rec == nil {
		return httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	return nil
}

func requireModel(model string) error {
	if !IsModel(model) {
		return httpx.NotFound(fmt.Sprintf("unknown vision model '%s' (occupancy|counting|crowd|demography)", model))
	}
	return nil
}

func (s *Service) guard(ctx context.Context, app, model string) error {
	if err := s.requireApp(ctx, app); err != nil {
		return err
	}
	return requireModel(model)
}

// SettingsView is the settings read/write response.
type VisionSettingsView struct {
	Room      string  `json:"room"`
	Model     string  `json:"model"`
	Config    *y.Map  `json:"config"`
	Resolved  *y.Map  `json:"resolved"`
	UpdatedAt *string `json:"updatedAt"`
}

// GetSettings is a room override + its resolved config.
func (s *Service) GetSettings(ctx context.Context, app, model, room string) (*VisionSettingsView, error) {
	if err := s.guard(ctx, app, model); err != nil {
		return nil, err
	}
	row, err := s.d.Store.GetSetting(ctx, app, s.d.Apps.AppDir(app), model, room)
	if err != nil {
		return nil, err
	}
	v := &VisionSettingsView{Room: room, Model: model, Config: y.NewMap(), Resolved: s.ResolveModelConfig(ctx, app, model, room)}
	if row != nil {
		v.Config, v.UpdatedAt = row.Config, &row.UpdatedAt
	}
	return v, nil
}

// PutSettings validates + stores a room override (400 on a bad shape).
func (s *Service) PutSettings(ctx context.Context, app, model, room string, body any) (*VisionSettingsView, error) {
	if err := s.guard(ctx, app, model); err != nil {
		return nil, err
	}
	clean, err := ValidateModelSettings(model, body)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	row, err := s.d.Store.PutSetting(ctx, app, s.d.Apps.AppDir(app), model, room, clean)
	if err != nil {
		return nil, err
	}
	return &VisionSettingsView{Room: room, Model: model, Config: row.Config, Resolved: s.ResolveModelConfig(ctx, app, model, room), UpdatedAt: &row.UpdatedAt}, nil
}

// Overview is the per-model tiles.
type VisionOverview struct {
	Model         string `json:"model"`
	Enabled       bool   `json:"enabled"`
	Today         int64  `json:"today"`
	Assignments   int    `json:"assignments"`
	ActiveStreams int    `json:"activeStreams"`
	GeneratedAt   string `json:"generatedAt"`
}

func (s *Service) assignments(ctx context.Context, app string) []edge.Assignment {
	if s.d.Assignments == nil || s.d.Assignments() == nil {
		return nil
	}
	list, _ := s.d.Assignments().List(ctx, app)
	return list
}

// Overview counts today's events, live assignments and active rooms.
func (s *Service) Overview(ctx context.Context, app, model string) (*VisionOverview, error) {
	if err := s.guard(ctx, app, model); err != nil {
		return nil, err
	}
	since := jsx.ISO(s.now().Add(-24 * time.Hour))
	n := 0
	for _, a := range s.assignments(ctx, app) {
		if a.PluginID == model && a.Status != "revoked" && a.Status != "stopped" {
			n++
		}
	}
	today, err := s.d.Store.CountSince(ctx, app, s.d.Apps.AppDir(app), model, since)
	if err != nil {
		return nil, err
	}
	return &VisionOverview{Model: model, Enabled: s.isEnabled(ctx, app, model), Today: today, Assignments: n,
		ActiveStreams: len(s.activeRooms(ctx, app)), GeneratedAt: jsx.ISO(s.now())}, nil
}

// StreamView is one active room.
type VisionStreamView struct {
	Room        string   `json:"room"`
	Tags        []string `json:"tags"`
	HasSettings bool     `json:"hasSettings"`
	UpdatedAt   *string  `json:"updatedAt"`
}

// Streams lists active rooms with their tags + override flag.
func (s *Service) Streams(ctx context.Context, app, model string) ([]VisionStreamView, error) {
	if err := s.guard(ctx, app, model); err != nil {
		return nil, err
	}
	out := []VisionStreamView{}
	for _, room := range s.activeRooms(ctx, app) {
		row, err := s.d.Store.GetSetting(ctx, app, s.d.Apps.AppDir(app), model, room)
		if err != nil {
			return nil, err
		}
		v := VisionStreamView{Room: room, Tags: s.roomTags(ctx, app, room), HasSettings: row != nil}
		if row != nil {
			v.UpdatedAt = &row.UpdatedAt
		}
		out = append(out, v)
	}
	return out, nil
}

// Events lists a model's recent events.
func (s *Service) Events(ctx context.Context, app, model string, limit int) ([]VisionEventRow, error) {
	if err := s.guard(ctx, app, model); err != nil {
		return nil, err
	}
	return s.d.Store.RecentEvents(ctx, app, s.d.Apps.AppDir(app), model, limit)
}

// PipelineVision is the pipeline dashboard compute block (never fails).
func (s *Service) PipelineVision(app string) (pipeline.VisionView, error) {
	ctx := context.Background()
	v := pipeline.VisionView{EnabledModels: []string{}}
	for _, m := range Models {
		if s.isEnabled(ctx, app, m) {
			v.EnabledModels = append(v.EnabledModels, m)
		}
	}
	for _, a := range s.assignments(ctx, app) {
		if !IsModel(a.PluginID) {
			continue
		}
		switch a.Status {
		case "running":
			v.Running++
		case "pending":
			v.Pending++
		}
	}
	if rows, err := s.d.Global.QueryContext(ctx, `SELECT id FROM nodes`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			if rows.Scan(&id) != nil {
				continue
			}
			v.EdgeTotal++
			if s.d.Gateway != nil && s.d.Gateway() != nil && s.d.Gateway().IsConnected(id) {
				v.EdgeOnline++
			}
		}
	}
	return v, nil
}

func (s *Service) activeRooms(ctx context.Context, app string) []string {
	out := []string{}
	h, err := s.d.DB.App(ctx, app)
	if err != nil {
		return out
	}
	rows, err := h.QueryContext(ctx, `SELECT DISTINCT room FROM streams WHERE status = 'active' AND room IS NOT NULL AND room != '' ORDER BY room ASC`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var r string
		if rows.Scan(&r) == nil {
			out = append(out, r)
		}
	}
	return out
}
