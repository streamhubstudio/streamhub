package visionapps

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	s := NewStore()
	t.Cleanup(s.CloseAll)
	return s, filepath.Join(t.TempDir(), "apps", app)
}

func m(t *testing.T, s string) *y.Map { t.Helper(); return js(t, s).(*y.Map) }

func put(t *testing.T, s *Store, dir, model, room, cfg string) {
	t.Helper()
	if _, err := s.PutSetting(bg, app, dir, model, room, m(t, cfg)); err != nil {
		t.Fatal(err)
	}
}

func getCfg(t *testing.T, s *Store, dir, model, room string) *y.Map {
	t.Helper()
	row, err := s.GetSetting(bg, app, dir, model, room)
	if err != nil {
		t.Fatal(err)
	}
	if row == nil {
		return nil
	}
	return row.Config
}

func TestStoreSettingsRoundTrip(t *testing.T) {
	s, dir := newStore(t)
	row, err := s.PutSetting(bg, app, dir, "occupancy", "gate", m(t, `{"zones":[{"id":"z1","tag":"store-a","detect":"personas","points":[]}]}`))
	if err != nil || row.Room != "gate" {
		t.Fatalf("%+v %v", row, err)
	}
	eqJSON(t, getCfg(t, s, dir, "occupancy", "gate"), `{"zones":[{"id":"z1","tag":"store-a","detect":"personas","points":[]}]}`)
	put(t, s, dir, "occupancy", "gate", `{"zones":[]}`)
	eqJSON(t, getCfg(t, s, dir, "occupancy", "gate"), `{"zones":[]}`)
}

func TestStoreSettingsIsolatedPerModel(t *testing.T) {
	s, dir := newStore(t)
	put(t, s, dir, "occupancy", "gate", `{"zones":[]}`)
	put(t, s, dir, "counting", "gate", `{"lines":[],"fps":3.5}`)
	eqJSON(t, getCfg(t, s, dir, "occupancy", "gate"), `{"zones":[]}`)
	eqJSON(t, getCfg(t, s, dir, "counting", "gate"), `{"lines":[],"fps":3.5}`)
	if getCfg(t, s, dir, "crowd", "gate") != nil || getCfg(t, s, dir, "occupancy", "ghost") != nil {
		t.Fatal("absent setting must be nil")
	}
}

func TestStoreOneFilePerModel(t *testing.T) {
	s, dir := newStore(t)
	put(t, s, dir, "occupancy", "gate", `{"zones":[]}`)
	put(t, s, dir, "demography", "gate", `{"intervalSec":120,"engine":"local"}`)
	for _, f := range []string{"occupancy/occupancy.db", "demography/demography.db"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStoreRecordsMappedColumns(t *testing.T) {
	s, dir := newStore(t)
	must[struct{}](t)(struct{}{}, s.RecordOccupancy(bg, app, dir, "gate", "occupancy.session_started", m(t, `{"zone":"z1","tag":"store-a","kind":"personas","nodeId":"edge-1"}`)))
	must[struct{}](t)(struct{}{}, s.RecordCount(bg, app, dir, "gate", "count.in", m(t, `{"line":"l1","tag":"door","trackId":"t5"}`)))
	must[struct{}](t)(struct{}{}, s.RecordCrowd(bg, app, dir, "gate", "crowd.threshold", m(t, `{"zone":"z1","count":12,"threshold":10}`)))
	must[struct{}](t)(struct{}{}, s.RecordDemography(bg, app, dir, "gate", "demography.face", m(t, `{"age":32,"ageRange":"25-34","gender":"f","emotion":"happy","engine":"local"}`)))

	recent := func(model string) []VisionEventRow {
		return must[[]VisionEventRow](t)(s.RecentEvents(bg, app, dir, model, 10))
	}
	occ := recent("occupancy")
	if len(occ) != 1 || occ[0].Model != "occupancy" || occ[0].Room != "gate" || occ[0].Tag == nil || *occ[0].Tag != "store-a" || occ[0].Event != "occupancy.session_started" {
		t.Fatalf("occupancy %+v", occ)
	}
	if c := recent("counting"); c[0].Event != "count.in" || c[0].Data.Get("direction") != "in" {
		t.Fatalf("counting %+v", c[0])
	}
	if c := recent("crowd"); c[0].Event != "crowd.threshold" || c[0].Data.Get("alert") != float64(1) {
		t.Fatalf("crowd %+v %s", c[0], jstr(t, c[0].Data))
	}
	if d := recent("demography"); d[0].Event != "demography.face" || d[0].Data.Get("gender") != "f" {
		t.Fatalf("demography %+v", d[0])
	}
}

func TestStoreCountSince(t *testing.T) {
	s, dir := newStore(t)
	db, _ := s.DB(bg, app, dir, "counting")
	old := jsx.ISO(time.Now().Add(-40 * 24 * time.Hour))
	if _, err := db.Exec(`INSERT INTO count_events (room, direction, ts) VALUES ('gate','in',?)`, old); err != nil {
		t.Fatal(err)
	}
	must[struct{}](t)(struct{}{}, s.RecordCount(bg, app, dir, "gate", "count.in", y.NewMap()))
	since := jsx.ISO(time.Now().Add(-24 * time.Hour))
	if n := must[int64](t)(s.CountSince(bg, app, dir, "counting", since)); n != 1 {
		t.Fatalf("countSince = %d", n)
	}
}

func TestStoreRetentionPruneOnWrite(t *testing.T) {
	s, dir := newStore(t)
	db, _ := s.DB(bg, app, dir, "crowd")
	stale := jsx.ISO(time.Now().Add(-time.Duration(RetentionDays+5) * 24 * time.Hour))
	if _, err := db.Exec(`INSERT INTO crowd_events (room, count, ts) VALUES ('gate',3,?)`, stale); err != nil {
		t.Fatal(err)
	}
	must[struct{}](t)(struct{}{}, s.RecordCrowd(bg, app, dir, "gate", "crowd.count", m(t, `{"count":5}`)))
	rows := must[[]VisionEventRow](t)(s.RecentEvents(bg, app, dir, "crowd", 10))
	if len(rows) != 1 || rows[0].Data.Get("count") != float64(5) {
		t.Fatalf("%+v", rows)
	}
}

func TestStoreRecentEventsLimitNewestFirst(t *testing.T) {
	s, dir := newStore(t)
	for i := 0; i < 5; i++ {
		must[struct{}](t)(struct{}{}, s.RecordCount(bg, app, dir, "gate", "count.in", m(t, `{"trackId":"t`+string(rune('0'+i))+`"}`)))
	}
	rows := must[[]VisionEventRow](t)(s.RecentEvents(bg, app, dir, "counting", 3))
	if len(rows) != 3 || rows[0].Data.Get("track_id") != "t4" {
		t.Fatalf("%d %s", len(rows), jstr(t, rows))
	}
}
