// Package apps is the app registry + filesystem/config/samples lifecycle
// (modules/apps): the global `apps` pointer row, apps/<name>/{config.yaml,
// app.db, recordings/, snapshots/, samples/}, the raw config editor with
// backups and hot-reload, config presets and the masked S3/MQTT/SMTP blocks.
//
// The Node AppsService is split by responsibility: service.go (registry +
// lifecycle), disk.go (on-disk tree: defaults, merge, patch), resolve.go
// (AppConfig resolution), configio.go (config.yaml read cache / write /
// secrets), rawconfig.go (raw editor, backups, reload), presets.go,
// masked.go (S3/MQTT/SMTP), samples.go, routes.go + dto.go (HTTP).
package apps

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/quotas"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/s3"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// DefaultApp is seeded on boot (SPEC §2).
const DefaultApp = "live"

// SampleGenerator renders the wave-4 sample set of an app (samples module).
type SampleGenerator interface {
	Generate(ctx context.Context, app string) error
}

// MqttDisconnector drops an app's live MQTT client (mqtt module).
type MqttDisconnector interface {
	DisconnectApp(app string)
}

// Deps are the Service's collaborators. Samples / Mqtt are optional (the
// modules that provide them are wired later; nil = skipped, as Node does when
// ModuleRef can't resolve them).
type Deps struct {
	Config  *config.Config
	Store   *db.Service
	Global  *sql.DB
	S3      *s3.Service
	Secrets *s3.SecretsStore
	Quotas  *quotas.Service
	Audit   *audit.Service
	Samples SampleGenerator
	Mqtt    MqttDisconnector
	Log     *slog.Logger
	// Env reads ad-hoc variables (secret refs); nil = os.Getenv.
	Env func(string) string
	// Resolve is the DNS seam of the callback SSRF guard (tests inject).
	Resolve security.HostResolver
}

// Service is the apps module (implements contracts.AppsService).
type Service struct {
	cfg     *config.Config
	store   *db.Service
	global  *sql.DB
	s3      *s3.Service
	secrets *s3.SecretsStore
	quotas  *quotas.Service
	audit   *audit.Service
	samples SampleGenerator
	mqtt    MqttDisconnector
	log     *slog.Logger
	env     func(string) string
	resolve security.HostResolver

	// mu serializes config writes and registry mutations (Node runs them on
	// one thread; read-modify-write of config.yaml must not interleave).
	mu sync.Mutex

	cacheMu sync.Mutex
	cache   map[string]cachedDisk

	tenantOnce sync.Once
	hasTenant  bool
}

var _ contracts.AppsService = (*Service)(nil)

// New builds the service.
func New(d Deps) *Service {
	env := d.Env
	if env == nil {
		env = os.Getenv
	}
	resolve := d.Resolve
	if resolve == nil {
		resolve = security.DefaultHostResolver
	}
	return &Service{
		cfg: d.Config, store: d.Store, global: d.Global, s3: d.S3, secrets: d.Secrets,
		quotas: d.Quotas, audit: d.Audit, samples: d.Samples, mqtt: d.Mqtt, log: d.Log,
		env: env, resolve: resolve, cache: map[string]cachedDisk{},
	}
}

// BindSamples / BindMqtt late-bind the optional collaborators.
func (s *Service) BindSamples(g SampleGenerator) { s.samples = g }
func (s *Service) BindMqtt(m MqttDisconnector)   { s.mqtt = m }

// Init seeds the default `live` app (onModuleInit). Never fails boot.
func (s *Service) Init(ctx context.Context) {
	existing, err := s.Get(ctx, DefaultApp)
	if err == nil && existing == nil {
		_, err = s.Create(ctx, contracts.CreateAppInput{Name: DefaultApp, DisplayName: "Live"})
		if err == nil {
			s.log.Info(fmt.Sprintf(`seeded default app "%s"`, DefaultApp))
		}
	}
	if err != nil {
		s.log.Error("failed seeding default app: " + err.Error())
	}
}

// AppDir is apps/<name>/ under DATA_DIR.
func (s *Service) AppDir(name string) string {
	return filepath.Join(s.cfg.DataDir, "apps", name)
}

func notFound(name string) error { return httpx.NotFound(fmt.Sprintf(`app "%s" not found`, name)) }

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const appColumns = `id, name, display_name, livekit_room_prefix, created_at, updated_at, settings_json`

func scanApp(sc interface{ Scan(...any) error }) (*contracts.AppRecord, error) {
	var (
		r             contracts.AppRecord
		display, room sql.NullString
		created, upd  sql.NullString
		settings      sql.NullString
	)
	if err := sc.Scan(&r.ID, &r.Name, &display, &room, &created, &upd, &settings); err != nil {
		return nil, err
	}
	r.DisplayName, r.LivekitRoomPrefix = r.Name, r.Name
	if display.Valid {
		r.DisplayName = display.String
	}
	if room.Valid {
		r.LivekitRoomPrefix = room.String
	}
	r.CreatedAt, r.UpdatedAt = created.String, upd.String
	if settings.Valid {
		r.SettingsJSON = &settings.String
	}
	return &r, nil
}

func (s *Service) appsHasTenantColumn(ctx context.Context) bool {
	s.tenantOnce.Do(func() {
		s.hasTenant, _ = db.HasColumn(ctx, s.global, "apps", "tenant_id")
	})
	return s.hasTenant
}

// List: a user/app-scoped caller sees its own tenant's apps; superadmin,
// global credentials and internal callers (p == nil) see every app.
func (s *Service) List(ctx context.Context, p *auth.Principal) ([]contracts.AppRecord, error) {
	q, args := `SELECT `+appColumns+` FROM apps ORDER BY name ASC`, []any{}
	if !(p == nil || p.IsSuperadmin || p.Scope == auth.ScopeGlobal || !s.appsHasTenantColumn(ctx)) {
		tenant := p.TenantID
		if tenant == "" {
			tenant = auth.PlatformTenantID
		}
		q, args = `SELECT `+appColumns+` FROM apps WHERE tenant_id = ? ORDER BY name ASC`, []any{tenant}
	}
	rows, err := s.global.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []contracts.AppRecord{}
	for rows.Next() {
		r, err := scanApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// Get returns the registry row (nil when missing).
func (s *Service) Get(ctx context.Context, name string) (*contracts.AppRecord, error) {
	r, err := scanApp(s.global.QueryRowContext(ctx, `SELECT `+appColumns+` FROM apps WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

// mustGet is get() + the controllers' 404.
func (s *Service) mustGet(ctx context.Context, name string) (*contracts.AppRecord, error) {
	r, err := s.Get(ctx, name)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, notFound(name)
	}
	return r, nil
}

var appSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)

// Create inserts the pointer row and scaffolds the app on disk; a failure
// rolls back the row and the directory.
func (s *Service) Create(ctx context.Context, in contracts.CreateAppInput) (*contracts.AppRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	name := strings.ToLower(y.Trim(in.Name))
	if !appSlug.MatchString(name) {
		return nil, httpx.Conflict("invalid app name (lowercase slug a-z, 0-9, hyphen; 3-32 chars)")
	}
	if existing, err := s.Get(ctx, name); err != nil {
		return nil, err
	} else if existing != nil {
		return nil, httpx.Conflict(fmt.Sprintf(`app "%s" already exists`, name))
	}
	displayName := y.Trim(in.DisplayName)
	if displayName == "" {
		displayName = name
	}
	roomPrefix := y.Trim(in.RoomPrefix)
	if roomPrefix == "" {
		roomPrefix = name
	}
	roomPrefix = strings.ToLower(roomPrefix)

	dir := s.AppDir(name)
	dirCreated := false
	var rowID int64
	rec, err := func() (*contracts.AppRecord, error) {
		for _, d := range []string{"recordings", "snapshots", "samples"} {
			if err := os.MkdirAll(filepath.Join(dir, d), 0o777); err != nil {
				return nil, err
			}
		}
		dirCreated = true

		disk := defaultDisk(name, displayName, roomPrefix)
		s.applyResolvedPatch(disk, in.Config)
		if err := s.writeDisk(name, disk); err != nil {
			return nil, err
		}

		tenant := in.TenantID
		if tenant == "" {
			tenant = auth.PlatformTenantID
		}
		var res sql.Result
		var err error
		if s.appsHasTenantColumn(ctx) {
			res, err = s.global.ExecContext(ctx, `INSERT INTO apps (name, display_name, livekit_room_prefix, tenant_id)
               VALUES (?, ?, ?, ?)`, name, displayName, roomPrefix, tenant)
		} else {
			res, err = s.global.ExecContext(ctx, `INSERT INTO apps (name, display_name, livekit_room_prefix)
               VALUES (?, ?, ?)`, name, displayName, roomPrefix)
		}
		if err != nil {
			return nil, err
		}
		rowID, _ = res.LastInsertId()

		if _, err := s.store.App(ctx, name); err != nil {
			return nil, err
		}
		if err := s.writeSamplePages(name, roomPrefix); err != nil {
			return nil, err
		}
		s.generateSamples(ctx, name)

		r, err := s.Get(ctx, name)
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, httpx.Internal("app row missing after insert")
		}
		return r, nil
	}()
	if err == nil {
		s.log.Info(fmt.Sprintf(`created app "%s"`, name))
		return rec, nil
	}

	// Best-effort rollback so a partial create never leaves junk behind.
	if rowID != 0 {
		_ = s.store.CloseApp(name)
		_, _ = s.global.ExecContext(ctx, `DELETE FROM apps WHERE id = ?`, rowID)
	}
	if dirCreated {
		if rmErr := os.RemoveAll(dir); rmErr != nil {
			s.log.Error(fmt.Sprintf(`rollback of failed create("%s") incomplete: %s`, name, rmErr))
		}
	}
	s.invalidate(name)
	return nil, httpx.Internal(fmt.Sprintf(`failed creating app "%s": %s`, name, errText(err)))
}

// errText is (err as Error).message: an *httpx.Error yields its message.
func errText(err error) string { return err.Error() }

// Delete removes the registry row (cascading api_tokens); DeleteVods also
// purges apps/<name>/ (S3 objects stay — owned by the recording/s3 modules).
func (s *Service) Delete(ctx context.Context, name string, opts contracts.DeleteAppOptions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, err := s.mustGet(ctx, name)
	if err != nil {
		return err
	}
	s.disconnectMqtt(name)
	_ = s.store.CloseApp(name)
	if _, err := s.global.ExecContext(ctx, `DELETE FROM apps WHERE id = ?`, rec.ID); err != nil {
		return err
	}
	s.invalidate(name)
	if opts.DeleteVods {
		if err := os.RemoveAll(s.AppDir(name)); err != nil {
			s.log.Error(fmt.Sprintf(`delete("%s", deleteVods): fs cleanup failed: %s`, name, err))
		}
		s.log.Warn(fmt.Sprintf(`deleted app "%s" with VODs; S3 objects (if any) must be purged by the s3/recording module`, name))
	} else {
		s.log.Info(fmt.Sprintf(`deleted app "%s" (VODs preserved on disk)`, name))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// GetConfig is the resolved config.yaml (credentials resolved).
func (s *Service) GetConfig(ctx context.Context, name string) (*contracts.AppConfig, error) {
	if _, err := s.mustGet(ctx, name); err != nil {
		return nil, err
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	return s.toResolved(disk), nil
}

// UpdateConfig persists a partial config and syncs the registry row.
func (s *Service) UpdateConfig(ctx context.Context, name string, patch contracts.AppConfigPatch) (*contracts.AppConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, err := s.mustGet(ctx, name)
	if err != nil {
		return nil, err
	}
	// Save-time SSRF guard: a private/metadata callback target never lands on disk.
	if patch.Callbacks != nil && patch.Callbacks.URL != nil {
		if err := s.assertCallbackURLSafe(ctx, *patch.Callbacks.URL); err != nil {
			return nil, err
		}
	}
	disk, err := s.readDisk(name)
	if err != nil {
		return nil, err
	}
	s.applyResolvedPatch(disk, &patch)
	if err := s.writeDisk(name, disk); err != nil {
		return nil, err
	}
	if patch.DisplayName != nil || patch.RoomPrefix != nil {
		dn, err := bindable(disk.Get("display_name"))
		if err != nil {
			return nil, err
		}
		rp, err := bindable(disk.Get("room_prefix"))
		if err != nil {
			return nil, err
		}
		if _, err := s.global.ExecContext(ctx, `UPDATE apps
             SET display_name = ?, livekit_room_prefix = ?, updated_at = datetime('now')
           WHERE id = ?`, dn, rp, rec.ID); err != nil {
			return nil, err
		}
	} else if _, err := s.global.ExecContext(ctx, `UPDATE apps SET updated_at = datetime('now') WHERE id = ?`, rec.ID); err != nil {
		return nil, err
	}
	return s.toResolved(disk), nil
}

// bindable mirrors better-sqlite3's binding rules for a raw YAML value.
func bindable(v any) (any, error) {
	switch v.(type) {
	case nil, string, float64:
		return v, nil
	}
	return nil, errors.New("SQLite3 can only bind numbers, strings, bigints, buffers, and null")
}

// assertCallbackURLSafe is the save-time half of the callbacks SSRF guard:
// empty passes; deny-private unless STREAMHUB_CALLBACK_ALLOW_HOSTS admits it.
func (s *Service) assertCallbackURLSafe(ctx context.Context, url string) error {
	target := strings.TrimSpace(url)
	if target == "" {
		return nil
	}
	return security.AssertSafeEgressURL(ctx, target, security.EgressOptions{
		AllowedSchemes: security.HTTPSchemes,
		Label:          "callback URL",
		Allowlist:      security.ParseAllowlistEnv(s.env(security.CallbackAllowHostsEnv)),
		Resolve:        s.resolve,
	})
}

func (s *Service) generateSamples(ctx context.Context, name string) {
	if s.samples == nil {
		return
	}
	if err := s.samples.Generate(ctx, name); err != nil {
		s.log.Warn(fmt.Sprintf(`samples generation for "%s" skipped: %s`, name, err))
	}
}

func (s *Service) disconnectMqtt(name string) {
	if s.mqtt != nil {
		s.mqtt.DisconnectApp(name)
	}
}
