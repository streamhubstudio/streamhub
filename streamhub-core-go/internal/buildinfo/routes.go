package buildinfo

import (
	"context"
	"net/http"
	"sync"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
)

// Module serves the About / Build routes. Any authenticated principal may read
// them (the version is already public via GET /auth/config); no global scope.
type Module struct {
	once      sync.Once
	info      BuildInfo
	changelog CoreChangelog
}

// New returns the module; both payloads are computed once, on first use.
func New() *Module { return &Module{} }

func (m *Module) load() {
	m.once.Do(func() {
		m.info = Collect()
		m.changelog = LoadChangelog()
	})
}

func op(id, path, summary, desc string) *huma.Operation {
	return api.Bearer(&huma.Operation{OperationID: id, Method: http.MethodGet, Path: api.Prefix + path,
		Summary: summary, Description: desc, Tags: []string{"system"}, DefaultStatus: http.StatusOK})
}

// Register implements api.Module.
func (m *Module) Register(a huma.API) {
	huma.Register(a, *op("SystemController_getBuild", "/system/build",
		"Build info of the running core: version, commit, build date, Go toolchain.",
		"Enveloped `{data, error}`. `commit`/`buildDate` come from the ldflags stamp, else the Go toolchain's vcs.* settings, else empty. Any authenticated principal."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[BuildInfo]], error) {
			m.load()
			return api.OK(m.info), nil
		})

	huma.Register(a, *op("SystemController_getChangelog", "/system/changelog",
		"The product changelog (repo-root CHANGELOG.md, embedded at build time) as markdown.",
		"Enveloped `{data, error}`: `{version, source: embedded|file|none, markdown}`. Any authenticated principal."),
		func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[CoreChangelog]], error) {
			m.load()
			return api.OK(m.changelog), nil
		})
}
