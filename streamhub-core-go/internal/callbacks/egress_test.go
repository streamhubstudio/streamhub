package callbacks

import (
	"context"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// A4: the webhook POST goes out through the egress-guarded client; a 302 to
// an internal address is not followed (the fire-time URL guard only saw the
// first hop).
func TestDispatchRefusesRedirectToLoopback(t *testing.T) {
	start, hits := testutil.RedirectToLoopback(t)
	logs := &fakeLogs{}
	svc := New(Deps{Apps: withCallbacks(start, "s3cret"), Logs: logs, Metrics: &fakeMetrics{}})
	svc.Sleep = func(time.Duration) {}
	_ = svc.Dispatch(context.Background(), "live", "stream.started", map[string]any{"room": "r"})
	if hits.Load() != 0 {
		t.Fatalf("the 302 reached the loopback target (%d hits)", hits.Load())
	}
	if logs.find("error", "gave up delivering") == nil {
		t.Fatalf("delivery did not fail: %+v", logs.lines)
	}
}
