package notifications

import (
	"context"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// A4: the Discord/Telegram poster (per-app webhook from config.yaml) goes
// out through the egress-guarded client: no 302 to an internal address.
func TestHTTPPosterRefusesRedirectToLoopback(t *testing.T) {
	start, hits := testutil.RedirectToLoopback(t)
	err := HTTPPoster{}.PostJSON(context.Background(), start, map[string]any{"content": "x"})
	if hits.Load() != 0 {
		t.Fatalf("the 302 reached the loopback target (%d hits)", hits.Load())
	}
	if err == nil {
		t.Fatal("want an error")
	}
}
