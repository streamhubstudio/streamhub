package streamhealth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

var bg = context.Background()

func obj(t *testing.T, s string) *y.Map {
	t.Helper()
	v, err := y.ParseJSON([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	m, _ := v.(*y.Map)
	return m
}

func str(v any) string { s, _ := y.Stringify(v); return s }

func TestThresholds(t *testing.T) {
	if str(DefaultThresholds) != `{"sample_interval_sec":10,"silence_db":-50,"silence_duration_sec":15,"desync_ms":200,"stall_sec":20,"bitrate_drop_pct":50,"recover_samples":2}` {
		t.Fatal(str(DefaultThresholds))
	}
	for _, b := range bounds {
		if v := *b.field(&[]HealthThresholds{DefaultThresholds}[0]); v < b.min || v > b.max {
			t.Errorf("default %s out of bounds", b.key)
		}
	}
	ok := []struct{ in, want string }{
		{`{"silence_db":"-40","stall_sec":30}`, `{"silence_db":-40,"stall_sec":30}`},
		{`{"stall_sec":" 1e1 "}`, `{"stall_sec":10}`},
		{`{}`, `{}`},
	}
	for _, c := range ok {
		got, err := SanitizeOverride(obj(t, c.in))
		if err != nil || str(got) != c.want {
			t.Errorf("%s → %s %v", c.in, str(got), err)
		}
	}
	for _, in := range []any{nil, y.Undefined} {
		if got, err := SanitizeOverride(in); err != nil || got.Len() != 0 {
			t.Error("null/undefined must be no override")
		}
	}
	bad := []struct {
		in  any
		msg string
	}{
		{obj(t, `{"silence":-40}`), "unknown threshold 'silence'"},
		{obj(t, `{"stall_sec":" 1e1 ","2":1}`), "unknown threshold '2'"},
		{obj(t, `{"silence_db":"quiet"}`), "threshold 'silence_db' must be a number"},
		{obj(t, `{"silence_db":true}`), "threshold 'silence_db' must be a number"},
		{obj(t, `{"silence_db":5}`), "threshold 'silence_db' must be between -120 and 0"},
		{obj(t, `{"recover_samples":0}`), "threshold 'recover_samples' must be between 1 and 10"},
		{[]any{1.0}, "settings must be a JSON object"},
		{"x", "settings must be a JSON object"},
	}
	for _, c := range bad {
		_, err := SanitizeOverride(c.in)
		var se *SettingsError
		if !errors.As(err, &se) || se.msg != c.msg {
			t.Errorf("%v → %v, want %q", c.in, err, c.msg)
		}
	}
	r := ResolveThresholds(obj(t, `{"silence_db":-60,"stall_sec":40}`), obj(t, `{"stall_sec":10}`))
	if r.SilenceDB != -60 || r.StallSec != 10 || r.DesyncMs != 200 {
		t.Fatalf("%+v", r)
	}
	r = ResolveThresholds(obj(t, `{"silence_db":"loud","desync_ms":99999}`), nil)
	if r.SilenceDB != -50 || r.DesyncMs != 200 {
		t.Fatalf("%+v", r)
	}
	if ResolveThresholds(nil, nil) != DefaultThresholds {
		t.Fatal("no layers → defaults")
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func TestStore(t *testing.T) {
	dir := t.TempDir()
	ck := &clock{time.Now()}
	s := NewStore(ck.now)
	t.Cleanup(s.CloseAll)
	if err := s.Record(bg, "live", dir, "cam-1", "health.degraded", obj(t, `{"room":"cam-1","status":"degraded","reasons":["audio_silent","av_desync"],"desyncMs":320}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "stream-health", "stream-health.db")); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.RecentEvents(bg, "live", dir, 10, "")
	if len(rows) != 1 || rows[0].Room != "cam-1" || *rows[0].Status != "degraded" || *rows[0].Reasons != "audio_silent,av_desync" || rows[0].Data.Get("desyncMs") != 320.0 {
		t.Fatalf("%+v", rows)
	}
	for i := 1; i <= 4; i++ {
		room := "a"
		if i%2 == 0 {
			room = "b"
		}
		_ = s.Record(bg, "live", dir, room, "health.stalled", obj(t, `{"i":`+string(rune('0'+i))+`}`))
	}
	all, _ := s.RecentEvents(bg, "live", dir, 3, "")
	if len(all) != 3 || all[0].Data.Get("i") != 4.0 {
		t.Fatal(len(all))
	}
	onlyA, _ := s.RecentEvents(bg, "live", dir, 50, "a")
	if len(onlyA) != 2 || onlyA[0].Room != "a" {
		t.Fatal(onlyA)
	}
	if nan, _ := s.RecentEvents(bg, "live", dir, nanF(), ""); len(nan) != 5 {
		t.Fatal(len(nan))
	}
	rooms, _ := s.RoomsSince(bg, "live", dir, "2000-01-01T00:00:00.000Z")
	if len(rooms) != 3 || rooms[0].Room != "a" || rooms[1].Room != "b" {
		t.Fatalf("%+v", rooms)
	}
	if n, _ := s.CountSince(bg, "live", dir, "2000-01-01T00:00:00.000Z"); n != 5 {
		t.Fatal(n)
	}
	// Retention: a write 31 days later prunes the old rows.
	ck.t = ck.t.Add(31 * 24 * time.Hour)
	_ = s.Record(bg, "live", dir, "a", "health.recovered", nil)
	rows, _ = s.RecentEvents(bg, "live", dir, 50, "")
	if len(rows) != 1 || rows[0].Event != "health.recovered" || rows[0].Status != nil || rows[0].Reasons != nil {
		t.Fatalf("%+v", rows)
	}

	// Overrides round-trip, upsert wins, list sorted.
	if g, _ := s.GetSetting(bg, "live", dir, "cam-1"); g != nil {
		t.Fatal("expected none")
	}
	_, _ = s.PutSetting(bg, "live", dir, "cam-1", obj(t, `{"silence_db":-40}`))
	row, _ := s.PutSetting(bg, "live", dir, "cam-1", obj(t, `{"silence_db":-35,"stall_sec":30}`))
	_, _ = s.PutSetting(bg, "live", dir, "aaa", nil)
	if str(row.Override) != `{"silence_db":-35,"stall_sec":30}` || row.UpdatedAt == "" {
		t.Fatalf("%+v", row)
	}
	list, _ := s.ListSettings(bg, "live", dir)
	if len(list) != 2 || list[0].Room != "aaa" || list[1].Room != "cam-1" {
		t.Fatalf("%+v", list)
	}

	// Corrupt cells map to {}.
	h, _ := s.DB("live", dir)
	_, _ = h.Exec("UPDATE health_events SET data_json = 'nope'")
	_, _ = h.Exec("UPDATE stream_settings SET config_json = '[1]' WHERE room = 'aaa'")
	rows, _ = s.RecentEvents(bg, "live", dir, 1, "")
	g, _ := s.GetSetting(bg, "live", dir, "aaa")
	if rows[0].Data.Len() != 0 || g.Override.Len() != 0 {
		t.Fatal("corrupt cells must map to {}")
	}
}

func nanF() float64 { z := 0.0; return z / z }

// fixture: a service over a temp DATA_DIR with an optional install config.
func newService(t *testing.T, install string) (*Service, string) {
	dir := t.TempDir()
	st := NewStore(nil)
	t.Cleanup(st.CloseAll)
	var ic InstallConfig
	if install != "" {
		ic = func(context.Context, string) *y.Map { return obj(t, install) }
	}
	return New(st, func(app string) string { return filepath.Join(dir, "apps", app) }, ic, nil, nil), dir
}

func TestServiceTapAndViews(t *testing.T) {
	svc, _ := newService(t, `{"silence_db":-60}`)
	type payload struct {
		Plugin    string  `json:"plugin"`
		Room      string  `json:"room"`
		SilenceDb float64 `json:"silenceDb"`
	}
	svc.OnEvent("live", "health.audio_lost", payload{"stream-health", "cam-1", -72})
	svc.OnEvent("live", "vod_ready", map[string]any{"room": "cam-1"}) // ignored family
	svc.OnEvent("live", "health.weird", make(chan int))               // unmarshalable: room "" recorded, never panics
	events, _ := svc.Events(bg, "live", 10, "cam-1")
	if len(events) != 1 || events[0].Event != "health.audio_lost" || events[0].Data.Get("silenceDb") != -72.0 ||
		str(events[0].Data) != `{"plugin":"stream-health","room":"cam-1","silenceDb":-72}` {
		t.Fatalf("%+v", events)
	}

	v, _ := svc.GetSettings(bg, "live", "cam-1")
	if v.UpdatedAt != nil || v.Override.Len() != 0 || v.Resolved.SilenceDB != -60 {
		t.Fatalf("%+v", v)
	}
	v, err := svc.PutSettings(bg, "live", "cam-1", obj(t, `{"stall_sec":"30"}`))
	if err != nil || str(v.Override) != `{"stall_sec":30}` || v.Resolved.StallSec != 30 || v.Resolved.SilenceDB != -60 || v.UpdatedAt == nil {
		t.Fatalf("%+v %v", v, err)
	}
	_, _ = svc.PutSettings(bg, "live", "zz-only-override", obj(t, `{}`))
	ov, _ := svc.Overview(bg, "live")
	got, _ := json.Marshal(ov.Rooms)
	if ov.Today != 2 || string(got) != `[{"room":"","lastEvent":"health.weird","lastTs":`+jsonStr(*ov.Rooms[0].LastTs)+`,"hasOverride":false},`+
		`{"room":"cam-1","lastEvent":"health.audio_lost","lastTs":`+jsonStr(*ov.Rooms[1].LastTs)+`,"hasOverride":true},`+
		`{"room":"zz-only-override","lastEvent":null,"lastTs":null,"hasOverride":true}]` {
		t.Fatalf("%d %s", ov.Today, got)
	}
}

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestRoutes(t *testing.T) {
	svc, _ := newService(t, "")
	_, api := humatest.New(t)
	httpx.InstallHumaErrors()
	svc.Register(api)
	base := "/api/v1/apps/live/plugins/stream-health"

	put := func(body string) (int, string) {
		r := api.Put(base+"/streams/cam-1/settings", strings.NewReader(body))
		return r.Code, r.Body.String()
	}
	if code, body := put(`{"config":{"stall_sec":30,"1":2}}`); code != 400 || !strings.Contains(body, `"message":"unknown threshold '1'"`) {
		t.Fatal(code, body)
	}
	if code, body := put(`{"config":{"stall_sec":30,"silence_db":"-40"}}`); code != 200 || !strings.Contains(body, `"override":{"stall_sec":30,"silence_db":-40}`) {
		t.Fatal(code, body)
	}
	for _, b := range []string{``, `{"config":null}`, `[1,2]`, `{}`} {
		if code, body := put(b); code != 200 || !strings.Contains(body, `"override":{}`) {
			t.Fatal(b, code, body)
		}
	}
	if code, body := put(`{"config":[1]}`); code != 400 || !strings.Contains(body, "settings must be a JSON object") {
		t.Fatal(code, body)
	}
	for _, q := range []string{"", "?limit=abc", "?limit=0", "?limit=-3&room=%20", "?limit=5000&room=cam-1"} {
		if r := api.Get(base + "/events" + q); r.Code != http.StatusOK || !strings.HasPrefix(r.Body.String(), `{"data":[`) {
			t.Fatal(q, r.Code, r.Body.String())
		}
	}
	if r := api.Get(base + "/overview"); r.Code != 200 || !strings.Contains(r.Body.String(), `"error":null`) {
		t.Fatal(r.Body.String())
	}
}

func TestJSParseInt(t *testing.T) {
	for in, want := range map[string]float64{"12abc": 12, " -5": -5, "+7": 7, "1e3": 1} {
		if got, ok := jsParseInt(in); !ok || got != want {
			t.Errorf("%q → %v", in, got)
		}
	}
	for _, in := range []string{"abc", "", "-", " "} {
		if _, ok := jsParseInt(in); ok {
			t.Errorf("%q should be NaN", in)
		}
	}
}
