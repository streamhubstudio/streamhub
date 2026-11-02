package streamflow

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// A4: action.http / action.plugin and the AI endpoint go out through the
// egress-guarded client — the URL guard alone let a 302 to an internal
// address or a re-resolving name (DNS rebinding) through.

func TestRunnerHTTPRefusesRedirectToLoopback(t *testing.T) {
	start, hits := testutil.RedirectToLoopback(t)
	r := NewRunner(RunnerDeps{})
	res, err := r.postJSON(context.Background(), start, nil, nil, 5*time.Second, "action.http URL")
	if hits.Load() != 0 {
		t.Fatalf("the 302 reached the loopback target (%d hits)", hits.Load())
	}
	if err == nil || err.Error() != "fetch failed" {
		t.Fatalf("want fetch failed, got %+v %v", res, err)
	}
}

type nopUsage struct{}

func (nopUsage) MonthlyUSD(context.Context, string, string, string) float64 { return 0 }
func (nopUsage) AddUsage(context.Context, string, string, float64, float64, string) error {
	return nil
}

func TestAIClientRefusesRebindingToMetadata(t *testing.T) {
	var calls atomic.Int32
	// The URL guard's lookup sees a public answer; the dial's sees metadata.
	rebind := func(context.Context, string) ([]string, error) {
		if calls.Add(1) == 1 {
			return []string{"93.184.216.34"}, nil
		}
		return []string{"169.254.169.254"}, nil
	}
	c := &AIClient{Usage: nopUsage{}, Resolve: rebind, Now: time.Now}
	_, _, err := c.Chat(context.Background(), AIRequest{APIKey: "sk-test",
		AIChatOptions: AIChatOptions{BaseURL: "https://ai.example/v1", Model: "m", Prompt: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "169.254.169.254") || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("want an egress block, got %v", err)
	}
	if calls.Load() < 2 {
		t.Fatalf("the dial did not re-resolve (%d lookups)", calls.Load())
	}
}
