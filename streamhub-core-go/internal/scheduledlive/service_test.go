package scheduledlive

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

const (
	app  = "live"
	now  = int64(1_800_000_000_000)
	hour = int64(3_600_000)
)

type sent struct {
	room, payload string
	opts          livekit.SendDataOptions
}

type fakeLK struct {
	mu        sync.Mutex
	sent      []sent
	failSend  bool
	failRooms bool
}

func (f *fakeLK) ListRooms(context.Context, []string) ([]livekit.RoomInfo, error) {
	if f.failRooms {
		return nil, errors.New("livekit down")
	}
	return []livekit.RoomInfo{{Name: "live"}, {Name: "live-show"}, {Name: "other-x"}}, nil
}

func (f *fakeLK) SendData(_ context.Context, room, payload string, o livekit.SendDataOptions) error {
	if f.failSend {
		return errors.New("livekit down")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, sent{room, payload, o})
	return nil
}

func (f *fakeLK) rooms() []string {
	out := []string{}
	for _, s := range f.sent {
		out = append(out, s.room)
	}
	sort.Strings(out)
	return out
}

type fakeApps struct {
	contracts.AppsService
	prefix, tz string
	fail       bool
}

func (f *fakeApps) GetConfig(context.Context, string) (*contracts.AppConfig, error) {
	if f.fail {
		return nil, httpx.NotFound("app not found")
	}
	return &contracts.AppConfig{RoomPrefix: f.prefix, Timezone: f.tz}, nil
}

func newSvc(t *testing.T, lk LiveKit) *Service {
	store, _, _ := testutil.Store(t)
	var get func() LiveKit
	if lk != nil {
		get = func() LiveKit { return lk }
	}
	s := NewService(NewRepository(store), get, func() contracts.AppsService { return &fakeApps{prefix: "live"} }, testutil.Log())
	s.now = func() time.Time { return time.UnixMilli(now) }
	s.push = func(f func()) { f() }
	return s
}

func sp(s string) *string { return &s }
func bp(b bool) *bool     { return &b }
func fp(f float64) *float64 {
	return &f
}

func status(err error) int {
	var he *httpx.Error
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

func TestMigrationCreatedTable(t *testing.T) {
	store, _, _ := testutil.Store(t)
	h, err := store.App(context.Background(), app)
	if err != nil {
		t.Fatal(err)
	}
	var name string
	if err := h.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_events'").Scan(&name); err != nil || name != "scheduled_events" {
		t.Fatalf("table missing: %v", err)
	}
}

func TestCreateAndList(t *testing.T) {
	ctx := context.Background()
	s := newSvc(t, nil)
	e, err := s.Create(ctx, app, CreateInput{StartAt: float64(now + hour), Room: sp(" show "), Title: sp("  Premiere "), Timezone: sp("America/Argentina/Buenos_Aires")}, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if *e.Room != "show" || *e.Title != "Premiere" || e.Message != nil || !e.Enabled || e.StartAt != now+hour || e.Timezone != "America/Argentina/Buenos_Aires" {
		t.Fatalf("view %+v", e)
	}
	b, _ := json.Marshal(e)
	var keys map[string]any
	_ = json.Unmarshal(b, &keys)
	for _, k := range []string{"id", "room", "title", "startAt", "timezone", "message", "enabled", "createdAt", "updatedAt"} {
		if _, ok := keys[k]; !ok {
			t.Fatalf("missing %s in %s", k, b)
		}
	}
	list, _ := s.List(ctx, app)
	if len(list) != 1 || list[0].ID != e.ID {
		t.Fatalf("list %+v", list)
	}
}

func TestTimezoneDefaults(t *testing.T) {
	ctx := context.Background()
	s := newSvc(t, nil)
	cases := []struct {
		name string
		tz   *string
		def  string
		want string
	}{
		{"omitted → UTC", nil, "UTC", "UTC"},
		{"omitted → app default", nil, "Asia/Tokyo", "Asia/Tokyo"},
		{"blank → app default", sp("   "), "Asia/Tokyo", "Asia/Tokyo"},
		{"blank default → UTC", nil, "  ", "UTC"},
		{"explicit wins", sp("Europe/Madrid"), "Asia/Tokyo", "Europe/Madrid"},
	}
	for _, c := range cases {
		e, err := s.Create(ctx, app, CreateInput{StartAt: float64(now), Timezone: c.tz}, c.def)
		if err != nil || e.Timezone != c.want {
			t.Errorf("%s: got %v %v", c.name, e, err)
		}
	}
	// update clearing the timezone also falls back to the default.
	e, _ := s.Create(ctx, app, CreateInput{StartAt: float64(now), Timezone: sp("Europe/Madrid")}, "UTC")
	u, err := s.Update(ctx, app, e.ID, PatchInput{HasTimezone: true, Timezone: sp("")}, "Asia/Tokyo")
	if err != nil || u.Timezone != "Asia/Tokyo" {
		t.Fatalf("update tz %v %v", u, err)
	}
}

func TestValidation(t *testing.T) {
	ctx := context.Background()
	s := newSvc(t, nil)
	long := func(n int) *string {
		b := make([]byte, n)
		for i := range b {
			b[i] = 'x'
		}
		return sp(string(b))
	}
	cases := []struct {
		name string
		in   CreateInput
		msg  string
	}{
		{"zero", CreateInput{StartAt: 0}, "startAt must be a positive integer (unix epoch ms, UTC)"},
		{"negative", CreateInput{StartAt: -1}, "startAt must be a positive integer (unix epoch ms, UTC)"},
		{"float", CreateInput{StartAt: 1.5}, "startAt must be a positive integer (unix epoch ms, UTC)"},
		{"tz", CreateInput{StartAt: 1, Timezone: long(65)}, "timezone must be <= 64 chars"},
		{"room", CreateInput{StartAt: 1, Room: long(201)}, "room must be <= 200 chars"},
		{"title", CreateInput{StartAt: 1, Title: long(201)}, "title must be <= 200 chars"},
		{"message", CreateInput{StartAt: 1, Message: long(501)}, "message must be <= 500 chars"},
	}
	for _, c := range cases {
		_, err := s.Create(ctx, app, c.in, "UTC")
		if status(err) != http.StatusBadRequest || err.Error() != c.msg {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

func TestListOrderAndPublic(t *testing.T) {
	ctx := context.Background()
	s := newSvc(t, nil)
	mk := func(start int64, room *string, enabled bool) int64 {
		e, err := s.Create(ctx, app, CreateInput{StartAt: float64(start), Room: room, Enabled: bp(enabled)}, "UTC")
		if err != nil {
			t.Fatal(err)
		}
		return e.ID
	}
	late := mk(now+3*hour, sp("show"), true)
	early := mk(now+hour, nil, true)
	mk(now+2*hour, sp("show"), false)         // disabled
	past := mk(now-48*hour, sp("show"), true) // older than the 24h lookback
	recent := mk(now-hour, sp("other"), true) // within the lookback

	list, _ := s.List(ctx, app)
	if list[0].ID != past || list[len(list)-1].ID != late {
		t.Fatalf("not soonest-first: %+v", list)
	}
	ids := func(v []ScheduledEventView) []int64 {
		out := []int64{}
		for _, e := range v {
			out = append(out, e.ID)
		}
		return out
	}
	eq := func(a, b []int64) bool {
		if len(a) != len(b) {
			return false
		}
		for i := range a {
			if a[i] != b[i] {
				return false
			}
		}
		return true
	}
	cases := []struct {
		name  string
		room  string
		since *float64
		want  []int64
	}{
		{"default lookback", "", nil, []int64{recent, early, late}},
		{"explicit since", "", fp(float64(now)), []int64{early, late}},
		{"room match or global", "show", fp(0), []int64{past, early, late}},
		{"blank room = all", "   ", fp(float64(now)), []int64{early, late}},
		{"NaN since → lookback", "", fp(nan()), []int64{recent, early, late}},
	}
	for _, c := range cases {
		got, err := s.ListPublic(ctx, app, c.room, c.since)
		if err != nil || !eq(ids(got), c.want) {
			t.Errorf("%s: got %v want %v (%v)", c.name, ids(got), c.want, err)
		}
	}
}

func nan() float64 { z := 0.0; return z / z }

func TestUpdateAndRemove(t *testing.T) {
	ctx := context.Background()
	s := newSvc(t, nil)
	e, _ := s.Create(ctx, app, CreateInput{StartAt: float64(now), Room: sp("show"), Title: sp("T")}, "UTC")
	u, err := s.Update(ctx, app, e.ID, PatchInput{Enabled: bp(false), StartAt: fp(float64(now + hour))}, "UTC")
	if err != nil || u.Enabled || u.StartAt != now+hour || *u.Title != "T" {
		t.Fatalf("update %+v %v", u, err)
	}
	u, _ = s.Update(ctx, app, e.ID, PatchInput{HasRoom: true, HasTitle: true, Title: sp("  ")}, "UTC")
	if u.Room != nil || u.Title != nil {
		t.Fatalf("clear %+v", u)
	}
	if _, err := s.Update(ctx, app, e.ID, PatchInput{StartAt: fp(0)}, "UTC"); status(err) != 400 {
		t.Fatalf("bad startAt %v", err)
	}
	if _, err := s.Update(ctx, app, 999, PatchInput{Enabled: bp(true)}, "UTC"); status(err) != 404 || err.Error() != "scheduled event '999' not found" {
		t.Fatalf("unknown %v", err)
	}
	if r, err := s.Remove(ctx, app, e.ID); err != nil || !r.Removed {
		t.Fatalf("remove %v", err)
	}
	if _, err := s.Remove(ctx, app, e.ID); status(err) != 404 {
		t.Fatalf("second remove %v", err)
	}
}

func TestPerAppIsolation(t *testing.T) {
	ctx := context.Background()
	s := newSvc(t, nil)
	_, _ = s.Create(ctx, "a", CreateInput{StartAt: float64(now)}, "UTC")
	if l, _ := s.List(ctx, "b"); len(l) != 0 {
		t.Fatalf("leak: %+v", l)
	}
}

func TestAgendaPush(t *testing.T) {
	ctx := context.Background()

	t.Run("room → namespaced room only", func(t *testing.T) {
		lk := &fakeLK{}
		s := newSvc(t, lk)
		_, _ = s.Create(ctx, app, CreateInput{StartAt: float64(now + hour), Room: sp("show")}, "UTC")
		if len(lk.sent) != 1 || lk.sent[0].room != "live-show" {
			t.Fatalf("sent %+v", lk.sent)
		}
		o := lk.sent[0].opts
		if *o.Topic != "scheduled-live" || !*o.Reliable {
			t.Fatalf("opts %+v", o)
		}
		want := `{"type":"agenda-updated","app":"live","room":"show","at":"2027-01-15T08:00:00.000Z"}`
		if lk.sent[0].payload != want {
			t.Fatalf("payload %s", lk.sent[0].payload)
		}
	})

	t.Run("no room → every live room under the prefix", func(t *testing.T) {
		lk := &fakeLK{}
		s := newSvc(t, lk)
		_, _ = s.Create(ctx, app, CreateInput{StartAt: float64(now + hour)}, "UTC")
		if got := lk.rooms(); len(got) != 2 || got[0] != "live" || got[1] != "live-show" {
			t.Fatalf("rooms %v", got)
		}
		var p map[string]any
		_ = json.Unmarshal([]byte(lk.sent[0].payload), &p)
		if p["room"] != nil || p["type"] != "agenda-updated" {
			t.Fatalf("payload %v", p)
		}
	})

	t.Run("update notifies; moving rooms notifies old and new", func(t *testing.T) {
		lk := &fakeLK{}
		s := newSvc(t, lk)
		e, _ := s.Create(ctx, app, CreateInput{StartAt: float64(now + hour), Room: sp("show")}, "UTC")
		lk.sent = nil
		_, _ = s.Update(ctx, app, e.ID, PatchInput{Enabled: bp(false)}, "UTC")
		if got := lk.rooms(); len(got) != 1 || got[0] != "live-show" {
			t.Fatalf("rooms %v", got)
		}
		lk.sent = nil
		_, _ = s.Update(ctx, app, e.ID, PatchInput{HasRoom: true, Room: sp("main")}, "UTC")
		if got := lk.rooms(); len(got) != 2 || got[0] != "live-main" || got[1] != "live-show" {
			t.Fatalf("rooms %v", got)
		}
	})

	t.Run("remove notifies the removed room", func(t *testing.T) {
		lk := &fakeLK{}
		s := newSvc(t, lk)
		e, _ := s.Create(ctx, app, CreateInput{StartAt: float64(now + hour), Room: sp("show")}, "UTC")
		lk.sent = nil
		_, _ = s.Remove(ctx, app, e.ID)
		if got := lk.rooms(); len(got) != 1 || got[0] != "live-show" {
			t.Fatalf("rooms %v", got)
		}
	})

	t.Run("push failure never fails the mutation", func(t *testing.T) {
		lk := &fakeLK{failSend: true, failRooms: true}
		s := newSvc(t, lk)
		if e, err := s.Create(ctx, app, CreateInput{StartAt: float64(now + hour), Room: sp("show")}, "UTC"); err != nil || e.ID <= 0 {
			t.Fatal(err)
		}
		if _, err := s.Create(ctx, app, CreateInput{StartAt: float64(now + hour)}, "UTC"); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("without LiveKit the service is poll-only", func(t *testing.T) {
		s := newSvc(t, nil)
		if e, err := s.Create(ctx, app, CreateInput{StartAt: float64(now + hour), Room: sp("show")}, "UTC"); err != nil || e.ID <= 0 {
			t.Fatal(err)
		}
	})
}

func TestControllerDefaultTimezone(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		apps contracts.AppsService
		want string
	}{
		{"app timezone", &fakeApps{tz: "America/Argentina/Buenos_Aires"}, "America/Argentina/Buenos_Aires"},
		{"no timezone → UTC", &fakeApps{}, "UTC"},
		{"lookup failure → UTC", &fakeApps{fail: true}, "UTC"},
		{"no apps → UTC", nil, "UTC"},
	}
	for _, c := range cases {
		m := NewModule(nil, c.apps)
		if got := m.defaultTimezone(ctx, app); got != c.want {
			t.Errorf("%s: %s", c.name, got)
		}
	}

}
