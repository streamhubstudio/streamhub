package plugins

import (
	"context"
	"fmt"
	"net/http"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Exporter is PluginExportService (GET /apps/:app/plugins/:id/export).
type Exporter struct {
	svc   *Service
	paths Paths
	env   func(string) string
}

// NewExporter builds the exporter.
func NewExporter(svc *Service, paths Paths, env func(string) string) *Exporter {
	return &Exporter{svc: svc, paths: paths, env: env}
}

type exportMeta struct {
	App string `json:"app"`
}

// Export bundles an installed, exportable app: 404 unknown app/plugin, 400
// not exportable / not installed, 503 when the worker source is missing.
func (e *Exporter) Export(ctx context.Context, app, id string) (string, []byte, error) {
	rec, err := e.svc.apps.Get(ctx, app)
	if err != nil {
		return "", nil, err
	}
	if rec == nil {
		return "", nil, httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	meta := e.svc.registry.GetMeta(id)
	if meta == nil {
		return "", nil, httpx.NotFound(fmt.Sprintf("plugin '%s' not found", id))
	}
	man := ToManifest(meta)
	if !man.Exportable {
		return "", nil, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not exportable", id))
	}
	if row, err := e.svc.repo.Get(ctx, app, id); err != nil {
		return "", nil, err
	} else if row == nil {
		return "", nil, httpx.BadRequest(fmt.Sprintf("plugin '%s' is not installed in app '%s'", id, app))
	}
	src := ResolveWorkerDir(*meta.ExportDir, meta.ID, e.paths, e.env)
	if src == "" || meta.Worker == nil || meta.Worker.Spawn == nil {
		return "", nil, httpx.Nest(http.StatusServiceUnavailable, fmt.Sprintf(
			"worker source for '%s' not found — set STREAMHUB_WORKER_SRC_ROOT or run from a repo checkout", id))
	}
	entries, err := ComposeBundle(meta, id, src, e.paths, e.env)
	if err != nil {
		return "", nil, err
	}
	body, err := PackTarGz(entries)
	if err != nil {
		return "", nil, err
	}
	name := fmt.Sprintf("streamhub-app-%s-%s.tar.gz", id, man.Version)
	e.svc.write("info", "plugin:"+id, fmt.Sprintf("exported standalone app bundle from '%s' (%s, %d bytes)", app, name, len(body)), exportMeta{app}, &rec.ID)
	return name, body, nil
}
