package samples

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"testing"
)

// Goldens are produced by the Node core itself: templates/gen.js.

func loadJSON(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestRenderPlaceholdersMatchesNode(t *testing.T) {
	var g struct {
		Ctx   map[string]string `json:"ctx"`
		Pages map[string]string `json:"pages"`
	}
	loadJSON(t, "rendered.json", &g)
	for _, f := range SampleFiles {
		if got := RenderPlaceholders(Templates[f], g.Ctx); got != g.Pages[f] {
			t.Errorf("%s: rendered page differs from Node", f)
		}
	}
	if got := RenderPlaceholders("{{APP}} {{NOPE}} {{lower}} {{ROOM}}", g.Ctx); got != g.Pages["_unknown"] {
		t.Errorf("unknown keys: got %q want %q", got, g.Pages["_unknown"])
	}
}

func TestExampleBundlesMatchNode(t *testing.T) {
	var g struct {
		AppCtx struct {
			App, Room, BaseURL, WsURL string
		} `json:"appCtx"`
		Bundles   map[string]map[string]map[string]string `json:"bundles"`
		Catalogue []ExampleDescriptor                     `json:"catalogue"`
	}
	loadJSON(t, "bundles.json", &g)
	appCtx := &ExampleContext{App: g.AppCtx.App, Room: g.AppCtx.Room, BaseURL: g.AppCtx.BaseURL, WsURL: g.AppCtx.WsURL}
	for name, ctx := range map[string]*ExampleContext{"app": appCtx, "placeholder": nil} {
		all := BuildAllBundles(ctx)
		if len(all) != len(g.Bundles[name]) {
			t.Fatalf("%s: %d bundles, Node has %d", name, len(all), len(g.Bundles[name]))
		}
		for _, b := range all {
			want := g.Bundles[name][b.ID]
			if len(b.Files) != len(want) {
				t.Errorf("%s/%s: file count", name, b.ID)
			}
			for _, f := range b.Files {
				if f.Data != want[f.Name] {
					t.Errorf("%s/%s/%s differs from Node", name, b.ID, f.Name)
				}
			}
		}
	}
	gotCat, _ := json.Marshal(ExampleBundles)
	wantCat, _ := json.Marshal(g.Catalogue)
	if !bytes.Equal(gotCat, wantCat) {
		t.Errorf("catalogue differs:\n%s\n%s", gotCat, wantCat)
	}
}

func TestZipMatchesNode(t *testing.T) {
	var g struct {
		Vectors []struct {
			Entries []struct{ Name, Data string } `json:"entries"`
			Base64  string                        `json:"base64"`
		} `json:"vectors"`
		One, All struct {
			Filename string `json:"filename"`
			Length   int    `json:"length"`
			Sha256   string `json:"sha256"`
		}
	}
	loadJSON(t, "zips.json", &g)
	for i, v := range g.Vectors {
		var entries []ZipEntry
		for _, e := range v.Entries {
			entries = append(entries, ZipEntry{e.Name, []byte(e.Data)})
		}
		if got := base64.StdEncoding.EncodeToString(CreateZip(entries)); got != v.Base64 {
			t.Errorf("vector %d differs from Node", i)
		}
	}
	// Node's zips came from the ExamplesService with this context.
	var b struct {
		AppCtx struct{ App, Room, BaseURL, WsURL string } `json:"appCtx"`
	}
	loadJSON(t, "bundles.json", &b)
	ec := &ExampleContext{App: b.AppCtx.App, Room: b.AppCtx.Room, BaseURL: b.AppCtx.BaseURL, WsURL: b.AppCtx.WsURL}
	_, files, _ := BuildExampleBundle("webrtc-play", ec)
	var entries []ZipEntry
	for _, f := range files {
		entries = append(entries, ZipEntry{f.Name, []byte(f.Data)})
	}
	check := func(name string, data []byte, want struct {
		Filename string `json:"filename"`
		Length   int    `json:"length"`
		Sha256   string `json:"sha256"`
	}) {
		sum := sha256.Sum256(data)
		if len(data) != want.Length || hex.EncodeToString(sum[:]) != want.Sha256 {
			t.Errorf("%s zip differs from Node (len %d want %d)", name, len(data), want.Length)
		}
	}
	check("one", CreateZip(entries), g.One)
	check("all", zipAllFor(ec), g.All)
}

func unzip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range r.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

// zip.spec.ts invariants.
func TestCreateZip(t *testing.T) {
	entries := []ZipEntry{{"a.txt", []byte("hello")}, {"dir/nested/b.bin", []byte{0, 1, 2, 255}}, {"empty", nil}}
	data := CreateZip(entries)
	if !bytes.HasPrefix(data, []byte{0x50, 0x4b, 0x03, 0x04}) {
		t.Fatal("missing local header signature")
	}
	eocd := data[len(data)-22:]
	if !bytes.HasPrefix(eocd, []byte{0x50, 0x4b, 0x05, 0x06}) || eocd[8] != 3 || eocd[10] != 3 {
		t.Fatal("bad EOCD / count")
	}
	got := unzip(t, data)
	for _, e := range entries {
		if got[e.Name] != string(e.Data) {
			t.Errorf("%s round-trip mismatch", e.Name)
		}
	}
	empty := CreateZip(nil)
	if len(empty) != 22 || len(unzip(t, empty)) != 0 {
		t.Error("empty archive")
	}
}

// samples.auth-wiring.spec.ts + samples.new-templates.spec.ts template invariants.
func TestTemplateInvariants(t *testing.T) {
	pub := Templates["webrtc-publish.html"]
	idx := func(s, sub string) int { return strings.Index(s, sub) }
	if e, f := idx(pub, "const eph = ephemeral();"), idx(pub, "'/apps/' + APP + '/tokens'"); e < 0 || f < 0 || e >= f {
		t.Error("ephemeral check must precede the mint fetch")
	}
	for _, s := range []string{"qp('apitoken')", "'Authorization':'Bearer ' + bearer", "if (opts.canPublish === false)",
		"await playToken(opts.room", "anonymous publishing is disabled", "canPublish:true"} {
		if !strings.Contains(pub, s) {
			t.Errorf("publish template lacks %q", s)
		}
	}
	if b, p := idx(pub, "if (bearer) {"), idx(pub, "if (opts.canPublish === false)"); b < 0 || b >= p {
		t.Error("bearer branch must precede the public fallback")
	}
	if !regexp.MustCompile(`apitoken=sk_`).MatchString(pub) {
		t.Error("actionable apitoken hint missing")
	}
	play := Templates["webrtc-play.html"]
	if !strings.Contains(play, "canPublish:false") || strings.Contains(play, "canPublish:true") {
		t.Error("play sample must be subscribe-only")
	}
	cdn := regexp.MustCompile(`cdn\.jsdelivr\.net/npm/livekit-client(?:@([^/]+))?/`)
	for _, f := range SampleFiles {
		tpl := Templates[f]
		for _, s := range []string{"function ephemeral()", "async function playToken(", "async function getToken("} {
			if !strings.Contains(tpl, s) {
				t.Errorf("%s lacks %q", f, s)
			}
		}
		for _, m := range cdn.FindAllStringSubmatch(tpl, -1) {
			if m[1] != "2.15.7" {
				t.Errorf("%s: unpinned livekit-client %s", f, m[0])
			}
		}
	}
	for _, f := range []string{"webrtc-publish.html", "webrtc-play.html"} {
		if !strings.Contains(Templates[f], "livekit-client@2.15.7/") {
			t.Errorf("%s must ship the pinned client", f)
		}
	}
	want := []string{"webrtc-publish.html", "webrtc-play.html", "hls-player.html", "audio-radio.html", "cctv-grid.html",
		"live-shopping.html", "telemedicine.html", "radio-player.html", "conference.html"}
	if strings.Join(SampleFiles, ",") != strings.Join(want, ",") {
		t.Errorf("SAMPLE_FILES = %v", SampleFiles)
	}
}

// example-bundle.spec.ts invariants.
func TestExampleBundleInvariants(t *testing.T) {
	if len(ExampleBundles) != len(SampleFiles) {
		t.Fatal("catalogue must be 1:1 with SAMPLE_FILES")
	}
	placeholder := regexp.MustCompile(`\{\{[A-Z_]+\}\}`)
	for i, d := range ExampleBundles {
		if d.File != SampleFiles[i] || d.ID+".html" != d.File {
			t.Errorf("%s: id/file mismatch", d.ID)
		}
		for _, k := range coreKeys {
			if !strings.Contains(strings.Join(d.RequiredConfig, ","), k) {
				t.Errorf("%s lacks required %s", d.ID, k)
			}
		}
		_, files, err := BuildExampleBundle(d.ID, nil)
		if err != nil || len(files) != 3 {
			t.Fatalf("%s: %v", d.ID, err)
		}
		html, cfg, readme := files[0].Data, files[1].Data, files[2].Data
		if !strings.HasPrefix(html, "<!doctype html>") || !strings.Contains(html, "</html>") ||
			!strings.Contains(html, ConfigScriptTag) || !strings.Contains(html, "window.STREAMHUB_CONFIG") || placeholder.MatchString(html) {
			t.Errorf("%s: index.html not standalone", d.ID)
		}
		if strings.Contains(html, "livekit-client") && strings.Index(html, ConfigScriptTag) > strings.Index(html, "livekit-client") {
			t.Errorf("%s: config.js must load before livekit-client", d.ID)
		}
		for _, k := range d.RequiredConfig {
			if !strings.Contains(cfg, k+":") {
				t.Errorf("%s: config.js lacks %s", d.ID, k)
			}
		}
		if (d.AuthModel == "ephemeral" || d.AuthModel == "publisher") && !strings.Contains(cfg, "token:") {
			t.Errorf("%s: token knob missing", d.ID)
		}
		if d.AuthModel == "publisher" && !strings.Contains(cfg, "apiToken:") {
			t.Errorf("%s: apiToken knob missing", d.ID)
		}
		blob := html + "\n" + cfg
		if !strings.Contains(blob, "your-streamhub.example.com") || strings.Contains(blob, "digitalhub.com.ar") ||
			regexp.MustCompile(`sk_[A-Za-z0-9]`).MatchString(blob) || regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}`).MatchString(blob) {
			t.Errorf("%s: generic bundle leaks a host/secret", d.ID)
		}
		if strings.Contains(cfg, "token:") && !regexp.MustCompile(`token:\s*''`).MatchString(cfg) {
			t.Errorf("%s: credential must ship empty", d.ID)
		}
		if !strings.Contains(readme, "config.js") || !strings.Contains(strings.ToLower(readme), "static host") {
			t.Errorf("%s: README guidance", d.ID)
		}
	}
	acme := &ExampleContext{App: "acme", Room: "lobby", BaseURL: "https://media.acme.io", WsURL: "wss://media.acme.io"}
	_, files, _ := BuildExampleBundle("webrtc-play", acme)
	for _, s := range []string{`app: "acme"`, `room: "lobby"`, `baseUrl: "https://media.acme.io"`, `wsUrl: "wss://media.acme.io"`} {
		if !strings.Contains(files[1].Data, s) {
			t.Errorf("config.js lacks %s", s)
		}
	}
	_, files, _ = BuildExampleBundle("hls-player", acme)
	if !strings.Contains(files[0].Data, "'https://media.acme.io/hls/acme'") || placeholder.MatchString(files[0].Data) {
		t.Error("hls-player must bake the app HLS URL")
	}
	if _, _, err := BuildExampleBundle("nope", nil); err == nil || !strings.Contains(err.Error(), "unknown example") {
		t.Error("unknown id must fail")
	}
}
