package visionapps

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

type recAppLog struct {
	mu   sync.Mutex
	recs []string
}

func (r *recAppLog) Record(app string, rec any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recs = append(r.recs, app+" "+jstrNoT(rec))
}

func newSink(t *testing.T) (*Sink, *Store, *recAppLog, *fakeApps) {
	t.Helper()
	s := NewStore()
	t.Cleanup(s.CloseAll)
	apps := &fakeApps{dir: t.TempDir()}
	al := &recAppLog{}
	return NewSink(s, al, apps), s, al, apps
}

func TestSinkRoutesEachFamily(t *testing.T) {
	sink, s, al, apps := newSink(t)
	sink.Record(app, "occupancy.session_started", m(t, `{"room":"gate","tag":"t"}`))
	sink.Record(app, "count.in", m(t, `{"room":"gate"}`))
	sink.Record(app, "crowd.threshold", m(t, `{"room":"gate","count":9}`))
	sink.Record(app, "demography.face", m(t, `{"room":"gate","age":30}`))
	dir := apps.AppDir(app)
	for _, model := range Models {
		rows := must[[]VisionEventRow](t)(s.RecentEvents(bg, app, dir, model, 10))
		if len(rows) != 1 || rows[0].Room != "gate" {
			t.Fatalf("%s: %+v", model, rows)
		}
	}
	if len(al.recs) != 4 {
		t.Fatalf("app log lines = %d", len(al.recs))
	}
	if al.recs[1] != `live {"source":"vision","event":"count.in","room":"gate"}` {
		t.Fatalf("app log line %q", al.recs[1])
	}
}

func TestSinkIgnoresNonVisionEvent(t *testing.T) {
	sink, _, al, apps := newSink(t)
	sink.Record(app, "vod_ready", m(t, `{"room":"gate"}`))
	if len(al.recs) != 0 {
		t.Fatal("non-vision event must not be logged")
	}
	if _, err := os.Stat(filepath.Join(apps.AppDir(app), "counting")); err == nil {
		t.Fatal("non-vision event must not open a model db")
	}
}

func TestSinkNeverPanicsOnStoreFailure(t *testing.T) {
	sink, s, _, apps := newSink(t)
	blocker := filepath.Join(apps.dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.FileFor = func(string, string) string { return filepath.Join(blocker, "x", "db.db") }
	sink.Record(app, "count.out", m(t, `{"room":"gate"}`))
	sink.Record(app, "count.out", nil)
}
