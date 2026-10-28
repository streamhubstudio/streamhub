package samples

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// fakeApps is an in-memory contracts.AppsService (name → room prefix).
type fakeApps struct {
	contracts.AppsService
	root  string
	rooms map[string]string
}

func (f *fakeApps) Get(_ context.Context, name string) (*contracts.AppRecord, error) {
	if _, ok := f.rooms[name]; !ok {
		return nil, nil
	}
	return &contracts.AppRecord{Name: name}, nil
}

func (f *fakeApps) List(context.Context, *auth.Principal) ([]contracts.AppRecord, error) {
	var out []contracts.AppRecord
	for n := range f.rooms {
		out = append(out, contracts.AppRecord{Name: n})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *fakeApps) GetConfig(_ context.Context, name string) (*contracts.AppConfig, error) {
	if _, ok := f.rooms[name]; !ok {
		return nil, httpx.NotFound("app '" + name + "' not found")
	}
	return &contracts.AppConfig{Name: name, RoomPrefix: f.rooms[name]}, nil
}

func (f *fakeApps) AppDir(name string) string { return filepath.Join(f.root, "apps", name) }

func newSvc(t *testing.T, env map[string]string) (*Service, *fakeApps) {
	t.Helper()
	apps := &fakeApps{root: t.TempDir(), rooms: map[string]string{"alpha": "", "beta": "", "shop": "shop-room"}}
	return New(Deps{Apps: apps, Env: func(k string) string { return env[k] }, Log: testutil.Log()}), apps
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func onDisk(t *testing.T, a *fakeApps, app, file string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(a.AppDir(app), "samples", file))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestGenerate(t *testing.T) {
	ctx := context.Background()
	s, a := newSvc(t, nil)
	written, err := s.GenerateFiles(ctx, "alpha")
	if err != nil || strings.Join(written, ",") != strings.Join(SampleFiles, ",") {
		t.Fatalf("written=%v err=%v", written, err)
	}
	html := onDisk(t, a, "alpha", "webrtc-publish.html")
	if !strings.Contains(html, "const APP = CFG.app || 'alpha';") || strings.Contains(html, "{{APP}}") || strings.Contains(html, "{{ROOM}}") {
		t.Error("placeholders not resolved to the app")
	}
	if _, err := s.GenerateFiles(ctx, "ghost"); status(err) != http.StatusNotFound || err.Error() != `app "ghost" not found` {
		t.Errorf("ghost: %v", err)
	}
	// G4 verticals: room prefix resolves {{ROOM}}; every page is wired and complete.
	if _, err := s.GenerateFiles(ctx, "shop"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(onDisk(t, a, "shop", "cctv-grid.html"), `value="shop-room"`) {
		t.Error("{{ROOM}} must resolve to the room prefix")
	}
	for _, f := range SampleFiles {
		h := onDisk(t, a, "shop", f)
		for _, k := range []string{"APP", "ROOM", "WS_URL", "API_URL", "ADAPTOR_URL", "HLS_URL"} {
			if strings.Contains(h, "{{"+k+"}}") {
				t.Errorf("%s leaves {{%s}}", f, k)
			}
		}
		if !strings.HasPrefix(h, "<!doctype html>") || !strings.Contains(h, "</html>") {
			t.Errorf("%s not a document", f)
		}
	}
	checks := map[string][]string{
		"cctv-grid.html":     {"playToken(", "TrackSubscribed", "split(',')"},
		"live-shopping.html": {"DataReceived", "publishData", "topic:'reaction'", `id="buy"`, "playToken(", "ephemeral()"},
		"telemedicine.html":  {"ephemeral()", "enableCameraAndMicrophone", "/apps/shop/tokens"},
		"radio-player.html":  {"radioListenToken(", "t.kind==='audio'"},
		"conference.html":    {"enableCameraAndMicrophone", "setScreenShareEnabled", "tileFor(", "ParticipantDisconnected"},
	}
	for f, subs := range checks {
		h := onDisk(t, a, "shop", f)
		for _, sub := range subs {
			if !strings.Contains(h, sub) {
				t.Errorf("%s lacks %q", f, sub)
			}
		}
	}
	if strings.Contains(onDisk(t, a, "shop", "radio-player.html"), "enableCameraAndMicrophone") {
		t.Error("radio-player must be audio-only")
	}
}

func TestListReadWrite(t *testing.T) {
	ctx := context.Background()
	s, a := newSvc(t, nil)
	if _, err := s.List(ctx, "ghost"); status(err) != http.StatusNotFound {
		t.Errorf("list ghost: %v", err)
	}
	// No samples dir yet → empty list.
	if l, err := s.List(ctx, "alpha"); err != nil || len(l) != 0 {
		t.Fatalf("empty list: %v %v", l, err)
	}
	dir := filepath.Join(a.AppDir("alpha"), "samples")
	_ = os.MkdirAll(dir, 0o755)
	for _, legacy := range []string{"publish.html", "play.html", "embed.html", "notes.txt"} {
		_ = os.WriteFile(filepath.Join(dir, legacy), []byte("x"), 0o644)
	}
	if _, err := s.GenerateFiles(ctx, "alpha"); err != nil {
		t.Fatal(err)
	}
	if err := s.Write(ctx, "alpha", "custom.html", "<html>custom</html>"); err != nil {
		t.Fatal(err)
	}
	infos, _ := s.List(ctx, "alpha")
	names := make([]string, len(infos))
	byName := map[string]SampleFileInfo{}
	for i, in := range infos {
		names[i] = in.Name
		byName[in.Name] = in
	}
	if !sort.StringsAreSorted(names) || len(names) != len(SampleFiles)+4 {
		t.Errorf("names %v", names)
	}
	for _, f := range SampleFiles {
		in := byName[f]
		if !in.Generated || in.SizeBytes <= 0 || in.EmbedURL != "https://streamhub.digitalhub.com.ar/samples/alpha/"+f {
			t.Errorf("%s info %+v", f, in)
		}
	}
	for _, f := range []string{"custom.html", "publish.html", "play.html", "embed.html"} {
		if byName[f].Generated {
			t.Errorf("%s must be generated=false", f)
		}
	}

	if c, err := s.Read(ctx, "alpha", "hls-player.html"); err != nil || c != onDisk(t, a, "alpha", "hls-player.html") {
		t.Error("read verbatim")
	}
	_ = s.Write(ctx, "alpha", "webrtc-publish.html", "<h1>edited</h1>")
	if c, _ := s.Read(ctx, "alpha", "webrtc-publish.html"); c != "<h1>edited</h1>" {
		t.Error("write/read round-trip")
	}
	_, err := s.Read(ctx, "alpha", "does-not-exist.html")
	if status(err) != http.StatusNotFound || err.Error() != `sample "does-not-exist.html" not found for app "alpha"` {
		t.Errorf("unknown file: %v", err)
	}
	for _, f := range []string{"../../etc/passwd", "sub/nested.html", "notes.txt", "..%2f..%2fx.html", ""} {
		if _, err := s.Read(ctx, "alpha", f); status(err) != http.StatusBadRequest {
			t.Errorf("read %q: %v", f, err)
		}
	}
	for _, f := range []string{"../escape.html", "sub/nested.html", "payload.js"} {
		if err := s.Write(ctx, "alpha", f, "x"); status(err) != http.StatusBadRequest ||
			err.Error() != "invalid sample filename (expected a safe *.html name)" {
			t.Errorf("write %q: %v", f, err)
		}
	}
	if err := s.Write(ctx, "alpha", "..x.html", "x"); status(err) != http.StatusBadRequest || err.Error() != "invalid sample path" {
		t.Errorf("..x.html: %v", err)
	}
	// Filename is validated before the app lookup.
	if err := s.Write(ctx, "ghost", "x.js", "x"); status(err) != http.StatusBadRequest {
		t.Errorf("order: %v", err)
	}
	if err := s.Write(ctx, "ghost", "webrtc-publish.html", "x"); status(err) != http.StatusNotFound {
		t.Errorf("write ghost: %v", err)
	}
}

func TestPerAppIsolation(t *testing.T) {
	ctx := context.Background()
	s, a := newSvc(t, nil)
	_, _ = s.GenerateFiles(ctx, "alpha")
	_, _ = s.GenerateFiles(ctx, "beta")
	_ = s.Write(ctx, "alpha", "webrtc-publish.html", "<h1>ALPHA-ONLY</h1>")
	if b, _ := s.Read(ctx, "beta", "webrtc-publish.html"); strings.Contains(b, "ALPHA-ONLY") || !strings.Contains(b, "const APP = CFG.app || 'beta';") {
		t.Error("beta touched by alpha edit")
	}
	_ = s.Write(ctx, "alpha", "hls-player.html", "<h1>ALPHA-EDIT</h1>")
	_, _ = s.GenerateFiles(ctx, "beta")
	if c, _ := s.Read(ctx, "alpha", "hls-player.html"); c != "<h1>ALPHA-EDIT</h1>" {
		t.Error("regenerating beta clobbered alpha")
	}
	if !strings.Contains(onDisk(t, a, "alpha", "audio-radio.html"), "'alpha';") || !strings.Contains(onDisk(t, a, "beta", "audio-radio.html"), "'beta';") {
		t.Error("per-app copies")
	}
}

func TestBackfillIsNonDestructive(t *testing.T) {
	ctx := context.Background()
	s, a := newSvc(t, nil)
	_, _ = s.GenerateFiles(ctx, "alpha")
	_ = s.Write(ctx, "alpha", "hls-player.html", "EDIT")
	// beta: one file present (edited), the rest missing → regenerated in full.
	_ = os.MkdirAll(filepath.Join(a.AppDir("beta"), "samples"), 0o755)
	_ = os.WriteFile(filepath.Join(a.AppDir("beta"), "samples", "conference.html"), []byte("EDIT"), 0o644)
	s.Backfill(ctx)
	if onDisk(t, a, "alpha", "hls-player.html") != "EDIT" {
		t.Error("complete set must not be regenerated")
	}
	if onDisk(t, a, "beta", "conference.html") == "EDIT" || onDisk(t, a, "shop", "hls-player.html") == "" {
		t.Error("incomplete sets must be generated")
	}
}

func TestPublicBaseURL(t *testing.T) {
	cases := []struct {
		cfg  string
		env  map[string]string
		want string
	}{
		{"", nil, "https://streamhub.digitalhub.com.ar"},
		{"https://a.example//", map[string]string{"PUBLIC_BASE_URL": "https://b"}, "https://a.example"},
		{"", map[string]string{"PUBLIC_BASE_URL": "https://b/"}, "https://b"},
		{"", map[string]string{"STREAMHUB_PUBLIC_URL": "https://c/"}, "https://c"},
	}
	for _, c := range cases {
		s := New(Deps{Apps: &fakeApps{}, PublicBaseURL: c.cfg, Env: func(k string) string { return c.env[k] }})
		if got := s.publicBaseURL(); got != c.want {
			t.Errorf("%+v: %s", c, got)
		}
	}
	s := New(Deps{Apps: &fakeApps{}, Env: func(string) string { return "" }})
	if s.publicWsURL() != "wss://media.digitalhub.com.ar" {
		t.Error("ws default")
	}
}

func TestExamplesService(t *testing.T) {
	ctx := context.Background()
	s, _ := newSvc(t, nil)
	items, err := s.ListExamples(ctx, "shop")
	if err != nil || len(items) != len(SampleFiles) {
		t.Fatalf("%v %v", items, err)
	}
	for _, it := range items {
		if !strings.Contains(it.DownloadURL, "/api/v1/apps/shop/examples/"+it.ID+".zip") || len(it.RequiredConfig) != 4 {
			t.Errorf("%+v", it)
		}
	}
	if _, err := s.ListExamples(ctx, "ghost"); status(err) != http.StatusNotFound {
		t.Error("list ghost")
	}
	z, err := s.ZipOne(ctx, "shop", "webrtc-play")
	if err != nil || z.Filename != "webrtc-play.zip" {
		t.Fatal(err)
	}
	for _, sub := range []string{"config.js", "index.html", `app: "shop"`, `room: "shop-room"`} {
		if !bytes.Contains(z.Data, []byte(sub)) {
			t.Errorf("zip lacks %s", sub)
		}
	}
	if files := unzip(t, z.Data); len(files) != 3 {
		t.Errorf("zip members %v", files)
	}
	for _, tc := range []struct {
		app, id string
		code    int
		msg     string
	}{
		{"shop", "../etc", 400, `invalid example id "../etc"`},
		{"ghost", "../etc", 400, `invalid example id "../etc"`},
		{"shop", "does-not-exist", 404, `example "does-not-exist" not found`},
		{"ghost", "webrtc-play", 404, `app "ghost" not found`},
		{"ghost", "does-not-exist", 404, `app "ghost" not found`},
	} {
		if _, err := s.ZipOne(ctx, tc.app, tc.id); status(err) != tc.code || err.Error() != tc.msg {
			t.Errorf("%+v: %v", tc, err)
		}
	}
	all, err := s.ZipByName(ctx, "shop", "ALL.ZIP")
	if err == nil {
		t.Errorf("ALL.ZIP → id ALL must fail the safe-id check, got %s", all.Filename)
	}
	all, _ = s.ZipByName(ctx, "shop", "all.zip")
	if all.Filename != "streamhub-examples.zip" || !bytes.Contains(all.Data, []byte("webrtc-play/index.html")) || !bytes.Contains(all.Data, []byte("conference/config.js")) {
		t.Error("zipAll layout")
	}
	if one, _ := s.ZipByName(ctx, "shop", "hls-player.ZIP"); one == nil || one.Filename != "hls-player.zip" {
		t.Error("zipByName single (case-insensitive suffix)")
	}
}

func TestWriteSampleDto(t *testing.T) {
	for _, tc := range []struct {
		body string
		want []string
	}{
		{`{"content":"<p>x</p>"}`, nil},
		{`{}`, []string{"content must be shorter than or equal to 500000 characters", "content must be a string"}},
		{`{"content":5}`, []string{"content must be shorter than or equal to 500000 characters", "content must be a string"}},
		{`{"content":"` + strings.Repeat("a", 500001) + `"}`, []string{"content must be shorter than or equal to 500000 characters"}},
	} {
		b := validate.MustParse(tc.body)
		WriteSampleDto(b)
		if strings.Join(b.Messages(), "|") != strings.Join(tc.want, "|") {
			t.Errorf("%.40s: %v", tc.body, b.Messages())
		}
	}
}
