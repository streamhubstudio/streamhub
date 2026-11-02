package streamhealth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authz"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// PluginID is the stream-health plugin/app id.
const PluginID = "stream-health"

// InstallConfig returns the plugin install's config (nil when uninstalled).
type InstallConfig func(ctx context.Context, app string) *y.Map

// Service is StreamHealthService.
type Service struct {
	store   *Store
	appDir  func(app string) string
	install InstallConfig
	log     *slog.Logger
	now     func() time.Time
}

// New builds the service. install may be nil (defaults only).
func New(store *Store, appDir func(string) string, install InstallConfig, log *slog.Logger, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	if log == nil {
		log = slog.Default()
	}
	return &Service{store, appDir, install, log, now}
}

// OnEvent is the callbacks-funnel tap: records every health.* dispatch.
// Best-effort — never panics into the funnel.
func (s *Service) OnEvent(app, event string, payload any) {
	if !strings.HasPrefix(event, "health.") {
		return
	}
	defer func() { _ = recover() }()
	data := toMap(payload)
	room, _ := data.Get("room").(string)
	_ = s.store.Record(context.Background(), app, s.appDir(app), room, event, data)
}

// Watching reports whether the app has stream-health installed (so the
// LiveKit plane only lists participants for apps that use the answer).
func (s *Service) Watching(ctx context.Context, app string) (ok bool) {
	if s.install == nil {
		return false
	}
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return s.install(ctx, app) != nil
}

// RecordSource stores what a room's publishers carry (the LiveKit plane
// calls it after every track publish/unpublish and participant leave): the
// worker then reports `audioSource: none` instead of a permanent
// audio_silent/audio_missing for a video-only source. room is the HLS dir
// name (the slugged LiveKit room). Best-effort, like OnEvent.
func (s *Service) RecordSource(ctx context.Context, app, room string, audio, video bool) {
	if app == "" || room == "" || !s.Watching(ctx, app) {
		return
	}
	if err := s.store.PutSource(ctx, app, s.appDir(app), room, audio, video); err != nil {
		s.log.Debug("stream-health: source not recorded", "app", app, "room", room, "err", err)
	}
}

// toMap converts a dispatch payload (struct, map or *Map) into a JS object.
func toMap(payload any) *y.Map {
	if m, ok := payload.(*y.Map); ok && m != nil {
		return m
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return y.NewMap()
	}
	if v, err := y.ParseJSON(b); err == nil {
		if m, ok := v.(*y.Map); ok {
			return m
		}
	}
	return y.NewMap()
}

// HealthOverviewRoom is one tile row.
type HealthOverviewRoom struct {
	Room        string  `json:"room"`
	LastEvent   *string `json:"lastEvent"`
	LastTs      *string `json:"lastTs"`
	HasOverride bool    `json:"hasOverride"`
}

// Overview is the monitor-tab tiles.
type HealthOverview struct {
	Today int64                `json:"today"`
	Rooms []HealthOverviewRoom `json:"rooms"`
}

var (
	collatorMu sync.Mutex
	collator   = collate.New(language.Und)
)

// Overview: events since local midnight + rooms with recent history (24 h)
// and/or a stored override, sorted by localeCompare.
func (s *Service) Overview(ctx context.Context, app string) (*HealthOverview, error) {
	dir := s.appDir(app)
	now := s.now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	overrides, err := s.store.ListSettings(ctx, app, dir)
	if err != nil {
		return nil, err
	}
	has := map[string]bool{}
	for _, o := range overrides {
		has[o.Room] = true
	}
	seen, err := s.store.RoomsSince(ctx, app, dir, jsx.ISO(now.Add(-24*time.Hour)))
	if err != nil {
		return nil, err
	}
	rooms := []HealthOverviewRoom{}
	idx := map[string]bool{}
	for _, r := range seen {
		ev, ts := r.LastEvent, r.LastTs
		rooms = append(rooms, HealthOverviewRoom{r.Room, &ev, &ts, has[r.Room]})
		idx[r.Room] = true
	}
	for _, o := range overrides {
		if !idx[o.Room] {
			rooms = append(rooms, HealthOverviewRoom{Room: o.Room, HasOverride: true})
			idx[o.Room] = true
		}
	}
	collatorMu.Lock()
	sort.SliceStable(rooms, func(i, j int) bool { return collator.CompareString(rooms[i].Room, rooms[j].Room) < 0 })
	collatorMu.Unlock()
	today, err := s.store.CountSince(ctx, app, dir, jsx.ISO(midnight))
	if err != nil {
		return nil, err
	}
	return &HealthOverview{today, rooms}, nil
}

// Events are the recent transitions.
func (s *Service) Events(ctx context.Context, app string, limit int, room string) ([]HealthEventRow, error) {
	return s.store.RecentEvents(ctx, app, s.appDir(app), float64(limit), room)
}

// HealthSettingsView is a room's override + resolved thresholds.
type HealthSettingsView struct {
	Room      string           `json:"room"`
	Override  *y.Map           `json:"override"`
	Resolved  HealthThresholds `json:"resolved"`
	UpdatedAt *string          `json:"updatedAt"`
}

// GetSettings returns a room's settings view.
func (s *Service) GetSettings(ctx context.Context, app, room string) (*HealthSettingsView, error) {
	row, err := s.store.GetSetting(ctx, app, s.appDir(app), room)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return s.view(ctx, app, room, y.NewMap(), nil), nil
	}
	return s.view(ctx, app, room, row.Override, &row.UpdatedAt), nil
}

// PutSettings validates and replaces a room's override ({} clears it).
func (s *Service) PutSettings(ctx context.Context, app, room string, input any) (*HealthSettingsView, error) {
	override, err := SanitizeOverride(input)
	if err != nil {
		return nil, err
	}
	row, err := s.store.PutSetting(ctx, app, s.appDir(app), room, override)
	if err != nil {
		return nil, err
	}
	return s.view(ctx, app, room, row.Override, &row.UpdatedAt), nil
}

func (s *Service) view(ctx context.Context, app, room string, override *y.Map, updatedAt *string) *HealthSettingsView {
	var install *y.Map
	if s.install != nil {
		func() {
			defer func() { _ = recover() }()
			install = s.install(ctx, app)
		}()
	}
	return &HealthSettingsView{room, override, ResolveThresholds(install, override), updatedAt}
}

// ---------------------------------------------------------------------------
// Routes (StreamHealthController)
// ---------------------------------------------------------------------------

func internal(err error) error {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he
	}
	return httpx.Internal("Internal server error")
}

// jsParseInt is Number.parseInt(s, 10) (NaN → ok=false).
func jsParseInt(s string) (float64, bool) {
	s = y.Trim(s)
	i, neg := 0, false
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		neg = s[i] == '-'
		i++
	}
	j := i
	for j < len(s) && s[j] >= '0' && s[j] <= '9' {
		j++
	}
	if j == i {
		return 0, false
	}
	n, _ := strconv.ParseFloat(s[i:j], 64)
	if neg {
		n = -n
	}
	return n, true
}

// ParseSettingsBody reads the PUT settings body: {"config":{…thresholds}}.
// An empty body, `null`, `{}` and {"config":null|{}} all clear the override.
// GO-DIVERGENCE (3.4, planning/GO-DIVERGENCES.md): Node only looked at
// body.config, so an unwrapped {"silence_db":-100} (or an array / scalar
// body) answered 200 and silently stored an EMPTY override, wiping the
// previous one; now any other top-level key, or a non-object body, is a 400.
func ParseSettingsBody(raw []byte) (any, error) {
	// No DTO class: the body reaches the handler as parsed (JS order).
	var config any = y.Undefined
	if len(strings.TrimSpace(string(raw))) > 0 {
		v, err := y.ParseJSON(raw)
		if err != nil {
			return nil, httpx.BadRequest("Unexpected token in JSON body")
		}
		if v != nil {
			m, ok := v.(*y.Map)
			if !ok {
				return nil, httpx.BadRequest(`settings body must be a JSON object: {"config":{…thresholds}}`)
			}
			for _, k := range m.Keys() {
				if k != "config" {
					return nil, httpx.BadRequest(fmt.Sprintf(`unknown top-level key '%s': thresholds go inside {"config":{…}}`, k))
				}
			}
			config = m.Get("config")
		}
	}
	if y.IsNullish(config) {
		config = y.NewMap()
	}
	return config, nil
}

// Register implements api.Module.
func (s *Service) Register(a huma.API) {
	op := func(id, method, path, summary, action string) *huma.Operation {
		return authz.Require(api.Bearer(&huma.Operation{
			OperationID: id, Method: method, Path: api.Prefix + "/apps/{app}/plugins/stream-health" + path,
			Summary: summary, Tags: []string{"stream-health"},
		}), "config", action)
	}
	type appIn struct {
		App string `path:"app"`
	}
	type eventsIn struct {
		App   string `path:"app"`
		Limit string `query:"limit"`
		Room  string `query:"room"`
	}
	type roomIn struct {
		App  string `path:"app"`
		Room string `path:"room"`
	}
	type roomBodyIn struct {
		App     string `path:"app"`
		Room    string `path:"room"`
		RawBody []byte
	}

	huma.Register(a, *op("StreamHealthController_overview", http.MethodGet, "/overview",
		"Health overview: events today + rooms with recent history/overrides.", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Envelope[*HealthOverview]], error) {
			ov, err := s.Overview(ctx, in.App)
			if err != nil {
				return nil, internal(err)
			}
			return api.OK(ov), nil
		})

	huma.Register(a, *op("StreamHealthController_events", http.MethodGet, "/events",
		"Recent health.* transitions (from the per-app db).", "read"),
		func(ctx context.Context, in *eventsIn) (*api.Out[api.Envelope[[]HealthEventRow]], error) {
			raw := in.Limit
			if raw == "" {
				raw = "50"
			}
			n, ok := jsParseInt(raw)
			if !ok || n == 0 {
				n = 50
			}
			n = math.Max(1, math.Min(1000, n))
			list, err := s.Events(ctx, in.App, int(n), y.Trim(in.Room))
			if err != nil {
				return nil, internal(err)
			}
			return api.OK(list), nil
		})

	huma.Register(a, *op("StreamHealthController_getSettings", http.MethodGet, "/streams/{room}/settings",
		"Per-room threshold override + the resolved effective thresholds.", "read"),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Envelope[*HealthSettingsView]], error) {
			v, err := s.GetSettings(ctx, in.App, in.Room)
			if err != nil {
				return nil, internal(err)
			}
			return api.OK(v), nil
		})

	huma.Register(a, *op("StreamHealthController_putSettings", http.MethodPut, "/streams/{room}/settings",
		"Set a per-room threshold override (picked up live, no restart).", "write"),
		func(ctx context.Context, in *roomBodyIn) (*api.Out[api.Envelope[*HealthSettingsView]], error) {
			config, err := ParseSettingsBody(in.RawBody)
			if err != nil {
				return nil, err
			}
			view, err := s.PutSettings(ctx, in.App, in.Room, config)
			var se *SettingsError
			if errors.As(err, &se) {
				return nil, httpx.BadRequest(se.msg)
			}
			if err != nil {
				return nil, internal(err)
			}
			return api.OK(view), nil
		})
	a.OpenAPI().Paths[api.Prefix+"/apps/{app}/plugins/stream-health/streams/{room}/settings"].Put.RequestBody.Required = false
}
