package streams

import (
	"fmt"
	"net/http"
	"sync"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// Snapshot concurrency caps (security 3.3.4, M5). Every on-demand snapshot is
// an ffmpeg process that can live up to 20 s plus the S3 upload, so an
// unbounded POST loop is a cheap CPU/process DoS of the whole host.
const (
	SnapshotMaxGlobal = 4
	SnapshotMaxPerApp = 2
)

// snapLimiter is a non-blocking counting semaphore, global + per app. A full
// slot answers 429 at once instead of queueing: a waiting request still holds
// its connection and goroutine (the pile-up just moves from ffmpeg to the
// HTTP server), and a snapshot is a point-in-time frame — a late one is no
// better than a retried one. Callers back off and retry.
type snapLimiter struct {
	mu     sync.Mutex
	global int
	perApp map[string]int
	maxG   int
	maxApp int
}

func newSnapLimiter(maxGlobal, maxPerApp int) *snapLimiter {
	return &snapLimiter{perApp: map[string]int{}, maxG: maxGlobal, maxApp: maxPerApp}
}

// acquire takes one slot for app, or returns the 429. The release func must
// be called exactly once.
func (l *snapLimiter) acquire(app string) (func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.perApp[app] >= l.maxApp {
		return nil, snapshotBusy(fmt.Sprintf("too many concurrent snapshots for app '%s' (max %d), retry later", app, l.maxApp))
	}
	if l.global >= l.maxG {
		return nil, snapshotBusy(fmt.Sprintf("too many concurrent snapshots (max %d), retry later", l.maxG))
	}
	l.global++
	l.perApp[app]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.global--
			if l.perApp[app]--; l.perApp[app] <= 0 {
				delete(l.perApp, app)
			}
		})
	}, nil
}

func snapshotBusy(msg string) *httpx.Error { return httpx.Nest(http.StatusTooManyRequests, msg) }
