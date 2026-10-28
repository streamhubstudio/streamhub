// Package samples is the port of streamhub-core/src/modules/samples: the
// per-app sample pages under apps/<app>/samples/ (generate / list / read /
// write, boot backfill) and the downloadable example bundles (zips).
package samples

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

const (
	defaultBaseURL = "https://streamhub.digitalhub.com.ar"
	defaultWsURL   = "wss://media.digitalhub.com.ar"
)

// Deps are the Service's collaborators.
type Deps struct {
	Apps contracts.AppsService
	// PublicBaseURL / PublicWsURL are config.publicBaseUrl / publicWsUrl.
	PublicBaseURL string
	PublicWsURL   string
	// SamplesURL is config.SamplesURL (STREAMHUB_SAMPLES_URL origin): when
	// set, the pages are rendered against it (API/SDK/HLS same-origin to the
	// samples host) and the list hands out embed URLs on it.
	SamplesURL string
	// Env reads process env (PUBLIC_BASE_URL / STREAMHUB_PUBLIC_URL fallback);
	// nil = os.Getenv.
	Env func(string) string
	Log *slog.Logger
}

// Service is SamplesService + ExamplesService.
type Service struct {
	apps       contracts.AppsService
	baseURL    string
	samplesURL string
	wsURL      string
	env        func(string) string
	log        *slog.Logger
}

// New builds the samples service.
func New(d Deps) *Service {
	env := d.Env
	if env == nil {
		env = os.Getenv
	}
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	return &Service{apps: d.Apps, baseURL: d.PublicBaseURL, samplesURL: strings.TrimRight(d.SamplesURL, "/"), wsURL: d.PublicWsURL, env: env, log: log}
}

// SampleFileInfo is one entry of the list endpoint.
type SampleFileInfo struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	EmbedURL  string `json:"embedUrl"`
	Generated bool   `json:"generated"`
}

// Backfill generates the sample set for every app missing any template file
// (onModuleInit). Non-destructive and best-effort.
func (s *Service) Backfill(ctx context.Context) {
	apps, err := s.apps.List(ctx, nil)
	if err != nil {
		s.log.Warn("sample backfill skipped: " + err.Error())
		return
	}
	for _, a := range apps {
		dir := filepath.Join(s.apps.AppDir(a.Name), "samples")
		s.rebase(ctx, a.Name, dir)
		missing := false
		for _, f := range SampleFiles {
			if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
				missing = true
				break
			}
		}
		if !missing {
			continue
		}
		if _, err := s.GenerateFiles(ctx, a.Name); err != nil {
			s.log.Warn(fmt.Sprintf(`sample backfill for "%s" failed: %s`, a.Name, err.Error()))
		}
	}
}

// Generate implements apps.SampleGenerator.
func (s *Service) Generate(ctx context.Context, app string) error {
	_, err := s.GenerateFiles(ctx, app)
	return err
}

// GenerateFiles (re)generates the standard sample set and returns the names.
func (s *Service) GenerateFiles(ctx context.Context, app string) ([]string, error) {
	dir, err := s.samplesDir(ctx, app)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return nil, err
	}
	pctx := s.context(ctx, app)
	written := make([]string, 0, len(SampleFiles))
	for _, f := range SampleFiles {
		html := RenderPlaceholders(Templates[f], pctx)
		if err := os.WriteFile(filepath.Join(dir, f), []byte(html), 0o644); err != nil {
			return nil, err
		}
		written = append(written, f)
	}
	s.log.Info(fmt.Sprintf(`generated %d samples for app "%s"`, len(written), app))
	return written, nil
}

// List lists the app's *.html sample files (sorted) with embed URLs.
func (s *Service) List(ctx context.Context, app string) ([]SampleFileInfo, error) {
	dir, err := s.samplesDir(ctx, app)
	if err != nil {
		return nil, err
	}
	base := s.sampleBaseURL()
	var names []string
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".html") {
				names = append(names, e.Name())
			}
		}
	}
	sort.Slice(names, func(i, j int) bool { return utf16Less(names[i], names[j]) })
	out := make([]SampleFileInfo, 0, len(names))
	for _, name := range names {
		var size int64
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil {
			size = st.Size()
		}
		out = append(out, SampleFileInfo{
			Name: name, SizeBytes: size,
			EmbedURL:  base + "/samples/" + jsx.EncodeURIComponent(app) + "/" + jsx.EncodeURIComponent(name),
			Generated: IsSampleFile(name),
		})
	}
	return out, nil
}

// Read returns one sample file's contents.
func (s *Service) Read(ctx context.Context, app, file string) (string, error) {
	full, err := s.resolveFile(ctx, app, file, false)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", httpx.NotFound(fmt.Sprintf(`sample "%s" not found for app "%s"`, file, app))
	}
	return string(b), nil
}

// Write overwrites (or creates) one sample file of this app only.
func (s *Service) Write(ctx context.Context, app, file, content string) error {
	full, err := s.resolveFile(ctx, app, file, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return err
	}
	s.log.Info(fmt.Sprintf(`updated sample "%s" for app "%s"`, file, app))
	return nil
}

// ExampleContextFor is SamplesService.exampleContext.
func (s *Service) ExampleContextFor(ctx context.Context, app string) (*ExampleContext, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return nil, err
	}
	return &ExampleContext{App: app, Room: s.roomPrefix(ctx, app), BaseURL: s.publicBaseURL(), WsURL: s.publicWsURL()}, nil
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

var safeName = regexp.MustCompile(`^[a-zA-Z0-9._-]+\.html$`)

func (s *Service) requireApp(ctx context.Context, app string) error {
	rec, err := s.apps.Get(ctx, app)
	if err != nil {
		return err
	}
	if rec == nil {
		return httpx.NotFound(fmt.Sprintf(`app "%s" not found`, app))
	}
	return nil
}

func (s *Service) samplesDir(ctx context.Context, app string) (string, error) {
	if err := s.requireApp(ctx, app); err != nil {
		return "", err
	}
	return filepath.Join(s.apps.AppDir(app), "samples"), nil
}

// resolveFile validates the filename and confines it to the samples dir.
// SAFE_NAME has no '/', so path.basename(file) === file reduces to the regex.
func (s *Service) resolveFile(ctx context.Context, app, file string, forWrite bool) (string, error) {
	if !safeName.MatchString(file) {
		return "", httpx.BadRequest("invalid sample filename (expected a safe *.html name)")
	}
	dir, err := s.samplesDir(ctx, app)
	if err != nil {
		return "", err
	}
	full := filepath.Join(dir, file)
	// path.relative(dir, full) is the name itself: '..x.html' trips the guard.
	if strings.HasPrefix(file, "..") {
		return "", httpx.BadRequest("invalid sample path")
	}
	if !forWrite {
		if _, err := os.Stat(full); err != nil {
			return "", httpx.NotFound(fmt.Sprintf(`sample "%s" not found for app "%s"`, file, app))
		}
	}
	return full, nil
}

func (s *Service) roomPrefix(ctx context.Context, app string) string {
	if cfg, err := s.apps.GetConfig(ctx, app); err == nil && cfg != nil && cfg.RoomPrefix != "" {
		return cfg.RoomPrefix
	}
	return app
}

func (s *Service) context(ctx context.Context, app string) map[string]string {
	return s.contextAt(ctx, app, s.sampleBaseURL())
}

func (s *Service) contextAt(ctx context.Context, app, base string) map[string]string {
	return map[string]string{
		"APP": app, "ROOM": s.roomPrefix(ctx, app), "WS_URL": s.publicWsURL(),
		"API_URL": base + "/api/v1", "ADAPTOR_URL": base + "/sdk/streamhub-adaptor.global.js",
		"HLS_URL": base + "/hls/" + app,
	}
}

func (s *Service) publicWsURL() string {
	if s.wsURL != "" {
		return s.wsURL
	}
	return defaultWsURL
}

// sampleBaseURL is the origin the sample pages live on (and call
// same-origin): the samples origin when isolated, else the public base URL.
func (s *Service) sampleBaseURL() string {
	if s.samplesURL != "" {
		return s.samplesURL
	}
	return s.publicBaseURL()
}

// rebase moves the untouched standard pages of one app onto the samples
// origin: a page whose content is exactly the template rendered against the
// public base URL (generated before STREAMHUB_SAMPLES_URL was set) would
// otherwise call the dashboard origin's API cross-origin, which only the
// public token routes allow. Edited pages are left alone (regenerate them
// from the dashboard). Best-effort; no-op unless isolated.
func (s *Service) rebase(ctx context.Context, app, dir string) {
	if s.samplesURL == "" || s.samplesURL == s.publicBaseURL() {
		return
	}
	old, cur := s.contextAt(ctx, app, s.publicBaseURL()), s.contextAt(ctx, app, s.samplesURL)
	n := 0
	for _, f := range SampleFiles {
		p := filepath.Join(dir, f)
		b, err := os.ReadFile(p)
		if err != nil || string(b) != RenderPlaceholders(Templates[f], old) {
			continue
		}
		if os.WriteFile(p, []byte(RenderPlaceholders(Templates[f], cur)), 0o644) == nil {
			n++
		}
	}
	if n > 0 {
		s.log.Info(fmt.Sprintf(`moved %d untouched samples of app "%s" to %s`, n, app, s.samplesURL))
	}
}

func (s *Service) publicBaseURL() string {
	v := s.baseURL
	if v == "" {
		v = s.env("PUBLIC_BASE_URL")
	}
	if v == "" {
		v = s.env("STREAMHUB_PUBLIC_URL")
	}
	if v == "" {
		v = defaultBaseURL
	}
	return strings.TrimRight(v, "/")
}

// utf16Less is JS Array#sort's default (UTF-16 code unit) order.
func utf16Less(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
