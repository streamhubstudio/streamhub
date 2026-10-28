package samples

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

const (
	dashBase    = "https://app.example.com"
	samplesBase = "https://samples.example.com"
)

func newIsolated(t *testing.T, root, samplesURL string) *Service {
	t.Helper()
	apps := &fakeApps{root: root, rooms: map[string]string{"alpha": "", "shop": "shop-room"}}
	return New(Deps{Apps: apps, PublicBaseURL: dashBase, PublicWsURL: "wss://lk.example.com", SamplesURL: samplesURL,
		Env: func(string) string { return "" }, Log: testutil.Log()})
}

// STREAMHUB_SAMPLES_URL set: the pages call API/SDK/HLS on the samples
// origin (same-origin to where they are served) and the list hands out embed
// URLs there. Unset: everything stays on the public base URL.
func TestSamplesRenderedOnSamplesOrigin(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct{ samplesURL, want string }{
		{"", dashBase},
		{samplesBase + "/", samplesBase},
	} {
		root := t.TempDir()
		s := newIsolated(t, root, c.samplesURL)
		if _, err := s.GenerateFiles(ctx, "alpha"); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(filepath.Join(root, "apps", "alpha", "samples", "webrtc-publish.html"))
		html := string(b)
		for _, want := range []string{
			"'" + c.want + "/api/v1'",
			"'" + c.want + "/sdk/streamhub-adaptor.global.js'",
			"'" + c.want + "/hls/alpha'",
		} {
			if !strings.Contains(html, want) {
				t.Errorf("samplesURL=%q: page lacks %s", c.samplesURL, want)
			}
		}
		list, err := s.List(ctx, "alpha")
		if err != nil || len(list) == 0 {
			t.Fatalf("list: %v %v", list, err)
		}
		for _, f := range list {
			if want := c.want + "/samples/alpha/" + f.Name; f.EmbedURL != want {
				t.Errorf("embedUrl %q, want %q", f.EmbedURL, want)
			}
		}
		// Downloadable bundles target the public API, not the samples host.
		ec, err := s.ExampleContextFor(ctx, "alpha")
		if err != nil || ec.BaseURL != dashBase {
			t.Errorf("example context base = %v (%v), want %s", ec, err, dashBase)
		}
	}
}

// Turning isolation on moves untouched pages generated against the public
// base URL onto the samples origin at boot; edited pages are left alone.
func TestBackfillRebasesUntouchedSamples(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	before := newIsolated(t, root, "")
	for _, app := range []string{"alpha", "shop"} {
		if _, err := before.GenerateFiles(ctx, app); err != nil {
			t.Fatal(err)
		}
	}
	dir := filepath.Join(root, "apps", "alpha", "samples")
	edited := "<!doctype html><p>mine " + dashBase + "/api/v1</p></html>"
	if err := os.WriteFile(filepath.Join(dir, "conference.html"), []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	after := newIsolated(t, root, samplesBase)
	after.Backfill(ctx)
	for _, app := range []string{"alpha", "shop"} {
		for _, f := range SampleFiles {
			b, _ := os.ReadFile(filepath.Join(root, "apps", app, "samples", f))
			got := string(b)
			if app == "alpha" && f == "conference.html" {
				if got != edited {
					t.Errorf("edited page rewritten: %q", got)
				}
				continue
			}
			if want := RenderPlaceholders(Templates[f], after.context(ctx, app)); got != want {
				t.Errorf("%s/%s not rebased onto the samples origin", app, f)
			}
			if strings.Contains(got, dashBase+"/api/v1") {
				t.Errorf("%s/%s still calls the dashboard API", app, f)
			}
		}
	}

	// Without isolation Backfill never rewrites existing pages.
	again := newIsolated(t, root, "")
	again.Backfill(ctx)
	b, _ := os.ReadFile(filepath.Join(dir, "webrtc-play.html"))
	if !strings.Contains(string(b), samplesBase+"/api/v1") {
		t.Error("an unset STREAMHUB_SAMPLES_URL must not rewrite pages")
	}
}
