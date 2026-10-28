package edge

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// Catalog is the narrow slice of the plugins module the edge plane needs:
// plugin metas (edge capability + worker.spawn), per-app installs and the
// appstore's pinned bundles.
type Catalog interface {
	// Meta is the registry meta, or nil for an unknown plugin.
	Meta(pluginID string) *plugins.Meta
	// Install is the app's install row, or nil.
	Install(ctx context.Context, app, pluginID string) *plugins.Installed
	// Installs lists the app's installs.
	Installs(ctx context.Context, app string) []*plugins.Installed
	// VersionSha256 is a stored bundle's hash ("" when gone / no appstore).
	VersionSha256(pluginID, version string) string
}

// PluginsCatalog adapts the plugins module (any field may be nil).
type PluginsCatalog struct {
	Registry *plugins.Registry
	Repo     *plugins.Repo
	Appstore *plugins.Appstore
}

// Meta implements Catalog.
func (p PluginsCatalog) Meta(id string) *plugins.Meta {
	if p.Registry == nil {
		return nil
	}
	return p.Registry.GetMeta(id)
}

// Install implements Catalog.
func (p PluginsCatalog) Install(ctx context.Context, app, id string) *plugins.Installed {
	if p.Repo == nil {
		return nil
	}
	row, err := p.Repo.Get(ctx, app, id)
	if err != nil {
		return nil
	}
	return row
}

// Installs implements Catalog.
func (p PluginsCatalog) Installs(ctx context.Context, app string) []*plugins.Installed {
	if p.Repo == nil {
		return nil
	}
	rows, _ := p.Repo.List(ctx, app)
	return rows
}

// VersionSha256 implements Catalog.
func (p PluginsCatalog) VersionSha256(id, version string) string {
	if p.Appstore == nil {
		return ""
	}
	return p.Appstore.VersionSha256(id, version)
}

// AppDirs resolves apps/<name>/ (AppsService.appDir).
type AppDirs interface{ AppDir(name string) string }

// GenericResolver is GenericSpawnResolver: every edge-capable plugin
// resolves through its own worker.spawn against a REMOTE context, plus the
// framework STREAMHUB_* edge env and a stable cluster-derived ingest token.
type GenericResolver struct {
	cfg     *config.Config
	catalog func() Catalog // late-bound (the plugins plane)
	apps    AppDirs        // optional
	// ephemeral prefixes the random ingest token without a cluster secret.
	ephemeral string
}

// NewGenericResolver builds the resolver; catalog may return nil.
func NewGenericResolver(cfg *config.Config, catalog func() Catalog, apps AppDirs) *GenericResolver {
	return &GenericResolver{cfg: cfg, catalog: catalog, apps: apps, ephemeral: uuid.NewString()[:8]}
}

// Resolve implements SpawnResolver.
func (r *GenericResolver) Resolve(app, pluginID string, cfg *y.Map) SpawnSpec {
	cat := r.catalog()
	if cat == nil {
		return EmptySpec()
	}
	meta := cat.Meta(pluginID)
	if meta == nil || meta.Worker == nil || meta.Worker.Spawn == nil {
		return EmptySpec()
	}
	appDir := ""
	if r.apps != nil {
		func() {
			defer func() { _ = recover() }()
			appDir = r.apps.AppDir(app)
		}()
	}
	spec := meta.Worker.Spawn(plugins.WorkerContext{
		App: app, Config: cfg, AppDir: appDir, DataDir: r.cfg.DataDir,
		LivekitURL: r.cfg.LivekitURL, OriginURL: r.cfg.PublicBaseURL,
	})

	room := assignmentRoom(cfg)
	env := y.NewMap()
	env.Set("STREAMHUB_APP", app)
	env.Set("STREAMHUB_PLUGIN_ID", pluginID)
	env.Set("STREAMHUB_INGEST_TOKEN", r.ingestToken(app, pluginID, room))
	if base := strings.TrimRight(r.cfg.PublicBaseURL, "/"); base != "" {
		pluginBase := base + "/api/v1/apps/" + jsx.EncodeURIComponent(app) + "/plugins/" + jsx.EncodeURIComponent(pluginID)
		env.Set("STREAMHUB_INGEST_URL", pluginBase+"/live")
		env.Set("STREAMHUB_EVENTS_URL", pluginBase+"/events")
	}
	for _, e := range spec.Env { // the plugin's own env wins
		env.Set(e.Key, e.Value)
	}
	args := spec.Args
	if args == nil {
		args = []string{}
	}
	return SpawnSpec{Command: spec.Command, Args: args, Env: env}
}

// ResolveBundle implements SpawnResolver: the pinned appstore bundle of the
// app's install, or nil.
func (r *GenericResolver) ResolveBundle(app, pluginID string) *BundleRef {
	cat := r.catalog()
	if cat == nil {
		return nil
	}
	row := cat.Install(context.Background(), app, pluginID)
	if row == nil || row.WorkerVersion == nil || *row.WorkerVersion == "" {
		return nil
	}
	version := *row.WorkerVersion
	sha := cat.VersionSha256(pluginID, version)
	if sha == "" {
		return nil
	}
	base := strings.TrimRight(r.cfg.PublicBaseURL, "/")
	return &BundleRef{PluginID: pluginID, Version: version, Sha256: sha,
		URL: base + "/api/v1/plugins/" + jsx.EncodeURIComponent(pluginID) + "/versions/" + jsx.EncodeURIComponent(version) + "/bundle"}
}

// assignmentRoom is the room an assignment's worker reports for (Resolve's
// config.room ?? config.streamId).
func assignmentRoom(cfg *y.Map) string {
	if cfg == nil {
		return ""
	}
	if v := cfg.Get("room"); !y.IsNullish(v) {
		return y.ToString(v)
	}
	if v := cfg.Get("streamId"); !y.IsNullish(v) {
		return y.ToString(v)
	}
	return ""
}

// IngestVerifier validates the scoped ingest token an edge worker posts its
// live data / events with (see plugins.Service.SetEdgeIngest).
type IngestVerifier struct {
	Resolver *GenericResolver
	Repo     *Repo
}

// Valid reports whether token is HMAC(cluster token, app:plugin:room) of
// one of the app's offered/running assignments of pluginID. Without a
// cluster token the edge tokens are random and never verifiable.
func (v IngestVerifier) Valid(ctx context.Context, app, pluginID, token string) bool {
	if v.Resolver == nil || v.Repo == nil || v.Resolver.cfg.ClusterToken == "" || token == "" {
		return false
	}
	list, err := v.Repo.List(ctx, app)
	if err != nil {
		return false
	}
	for _, a := range list {
		if a.PluginID != pluginID || (a.Status != StatusOffered && a.Status != StatusRunning) {
			continue
		}
		want := v.Resolver.ingestToken(app, pluginID, assignmentRoom(a.Config))
		if hmac.Equal([]byte(want), []byte(token)) {
			return true
		}
	}
	return false
}

// ingestToken is HMAC-SHA256(cluster token, "app:plugin:room") hex — stable
// across re-offers; random per process without a cluster token.
func (r *GenericResolver) ingestToken(app, pluginID, room string) string {
	secret := r.cfg.ClusterToken
	if secret == "" {
		return r.ephemeral + ":" + uuid.NewString()
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(app + ":" + pluginID + ":" + room))
	return hex.EncodeToString(m.Sum(nil))
}
