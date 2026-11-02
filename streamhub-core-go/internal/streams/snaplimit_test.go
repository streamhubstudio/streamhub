package streams

import (
	"context"
	"net/http"
	"testing"
)

// Security 3.3.4 (M5): on-demand snapshots are capped per app (2) and
// globally (4); a full slot is an immediate 429, and slots free on return.
func TestSnapshotConcurrencyCap(t *testing.T) {
	h := newHarness(t, nil)
	h.svc.s3, h.svc.opt.Callbacks = nil, nil // the fakes are not goroutine-safe
	started, unblock := make(chan struct{}, 8), make(chan struct{})
	h.svc.capture = func(_ context.Context, _, out string) error {
		started <- struct{}{}
		<-unblock
		return writeFile(out, "jpeg")
	}
	errs := make(chan error, SnapshotMaxPerApp)
	for i := 0; i < SnapshotMaxPerApp; i++ {
		go func() {
			_, err := h.svc.Snapshot(bg, SnapshotInput{AppName: testApp, RoomName: "lobby"})
			errs <- err
		}()
		<-started
	}
	third := make(chan error, 1)
	go func() {
		_, err := h.svc.Snapshot(bg, SnapshotInput{AppName: testApp, RoomName: "lobby"})
		third <- err
	}()
	select {
	case err := <-third:
		close(unblock)
		wantStatus(t, err, http.StatusTooManyRequests, "too many concurrent snapshots for app 'live' (max 2), retry later")
	case <-started:
		close(unblock)
		t.Fatal("a 3rd concurrent snapshot of the same app reached ffmpeg")
	}
	for i := 0; i < SnapshotMaxPerApp; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	h.svc.capture = func(_ context.Context, _, out string) error { return writeFile(out, "jpeg") }
	if _, err := h.svc.Snapshot(bg, SnapshotInput{AppName: testApp, RoomName: "lobby"}); err != nil {
		t.Fatalf("slot not released: %v", err)
	}
}

func TestSnapLimiterGlobalCap(t *testing.T) {
	l := newSnapLimiter(SnapshotMaxGlobal, SnapshotMaxPerApp)
	var releases []func()
	for _, app := range []string{"a", "a", "b", "c"} {
		rel, err := l.acquire(app)
		if err != nil {
			t.Fatal(app, err)
		}
		releases = append(releases, rel)
	}
	_, err := l.acquire("d")
	wantStatus(t, err, http.StatusTooManyRequests, "too many concurrent snapshots (max 4), retry later")
	releases[0]()
	releases[0]() // idempotent: a double release must not free a second slot
	if _, err := l.acquire("d"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.acquire("e"); err == nil {
		t.Fatal("double release freed two slots")
	}
}
