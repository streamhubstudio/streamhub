package apps

import (
	_ "embed"
	"os"
	"path/filepath"
	"strings"
)

// Port of sample-pages.ts: the publish/play/embed demo pages written to
// apps/<name>/samples/ on create. The templates are the Node renderer's own
// output with sentinel values (samples/gen.js, historical — the .tmpl.html
// files are the source now); each sentinel occurs only in
// its HTML-escaped form, so substituting esc(value) reproduces Node exactly.

var (
	//go:embed samples/publish.tmpl.html
	publishTmpl string
	//go:embed samples/play.tmpl.html
	playTmpl string
	//go:embed samples/embed.tmpl.html
	embedTmpl string
)

// SamplePageContext is the input of RenderSamplePages.
type SamplePageContext struct {
	AppName       string
	RoomName      string
	PublicBaseURL string
	PublicWsURL   string
	APIBase       string
}

// SamplePages are the rendered pages.
type SamplePages struct {
	Publish string `json:"publish"`
	Play    string `json:"play"`
	Embed   string `json:"embed"`
}

var htmlEsc = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

// RenderSamplePages renders the three sample pages (pure).
func RenderSamplePages(c SamplePageContext) SamplePages {
	r := strings.NewReplacer(
		"@@A&amp;@@", htmlEsc.Replace(c.AppName),
		"@@R&amp;@@", htmlEsc.Replace(c.RoomName),
		"@@B&amp;@@", htmlEsc.Replace(trimTrailingSlashes(c.PublicBaseURL)),
		"@@W&amp;@@", htmlEsc.Replace(c.PublicWsURL),
		"@@P&amp;@@", htmlEsc.Replace(trimTrailingSlashes(c.APIBase)),
	)
	return SamplePages{Publish: r.Replace(publishTmpl), Play: r.Replace(playTmpl), Embed: r.Replace(embedTmpl)}
}

// trimTrailingSlashes is s.replace(/\/+$/, ”).
func trimTrailingSlashes(s string) string { return strings.TrimRight(s, "/") }

// publicBaseURL is PUBLIC_BASE_URL || STREAMHUB_PUBLIC_URL (trailing slashes
// trimmed), else the historical default.
func (s *Service) publicBaseURL() string {
	if v := s.env("PUBLIC_BASE_URL"); v != "" {
		return trimTrailingSlashes(v)
	}
	if v := s.env("STREAMHUB_PUBLIC_URL"); v != "" {
		return trimTrailingSlashes(v)
	}
	return "https://streamhub.digitalhub.com.ar"
}

func (s *Service) writeSamplePages(name, room string) error {
	base := s.publicBaseURL()
	ws := s.cfg.PublicWsURL
	if ws == "" {
		ws = "wss://media.digitalhub.com.ar"
	}
	// The pages call the API same-origin to wherever they are served: the
	// samples origin when isolated. The /play and /embed links they show are
	// dashboard SPA routes, so those keep the public base URL.
	apiBase := base
	if s.cfg != nil && s.cfg.SamplesURL != "" {
		apiBase = trimTrailingSlashes(s.cfg.SamplesURL)
	}
	pages := RenderSamplePages(SamplePageContext{
		AppName: name, RoomName: room, PublicBaseURL: base, PublicWsURL: ws, APIBase: apiBase + "/api/v1",
	})
	dir := filepath.Join(s.AppDir(name), "samples")
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	for file, body := range map[string]string{"publish.html": pages.Publish, "play.html": pages.Play, "embed.html": pages.Embed} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644); err != nil {
			return err
		}
	}
	return nil
}
