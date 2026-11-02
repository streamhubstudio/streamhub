package streamflow

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// G6 — the action.clip box: defaults (trigger room, trigger.ts, 10 s each
// side), templated config, the link back to the run, the loop guard and the
// catalogue entries (box + clip.* event family).
func TestClipExecutor(t *testing.T) {
	f := newFakeDeps()
	var got []ClipInput
	f.deps.Clip = func(_ context.Context, in ClipInput) (*ClipOutput, error) {
		got = append(got, in)
		if in.Room == "boom" {
			return nil, errors.New("clips are disabled for app 'live' (features.clips.enabled)")
		}
		vod, url := int64(7), "https://s3/clip.mp4"
		return &ClipOutput{ClipID: "clp_1", Status: "ready", From: "a", To: "b", VodID: &vod, URL: &url}, nil
	}

	bc := bctx(t, `{"room":"gate","plate":"AB123CD","ts":1793282400.25}`)
	bc.WorkflowID, bc.RunID = "wf1", "run1"
	out, port, err := runBox(t, "action.clip", `{}`, bc, f)
	if err != nil || port != "out" || str(out) != `{"clipId":"clp_1","status":"ready","from":"a","to":"b","vodId":7,"url":"https://s3/clip.mp4"}` {
		t.Fatalf("%v %s %v", str(out), port, err)
	}
	in := got[0]
	if in.App != "live" || in.Room != "gate" || in.EventTs != 1793282400.25 || in.Before != 10 || in.After != 10 || in.Wait ||
		in.Event != "plate.detected" || in.Payload.Get("plate") != "AB123CD" || in.WorkflowID != "wf1" || in.RunID != "run1" {
		t.Fatalf("%+v", in)
	}

	// Templated config overrides; a bad number falls back to the default.
	if _, _, err := runBox(t, "action.clip", `{"room":"{{trigger.plate}}","eventTs":"2026-10-29T14:00:00Z","before":3,"after":"x","wait":true}`, bc, f); err != nil {
		t.Fatal(err)
	}
	if in := got[1]; in.Room != "AB123CD" || in.EventTs != "2026-10-29T14:00:00Z" || in.Before != 3 || in.After != 10 || !in.Wait {
		t.Fatalf("%+v", in)
	}

	// No trigger.ts → now.
	if _, _, err := runBox(t, "action.clip", `{}`, bctx(t, `{"room":"gate"}`), f); err != nil {
		t.Fatal(err)
	}
	if ts, ok := got[2].EventTs.(float64); !ok || ts != f.deps.Now() {
		t.Fatalf("eventTs %v", got[2].EventTs)
	}

	if _, _, err := runBox(t, "action.clip", `{}`, bctx(t, `{}`), f); err == nil || err.Error() != "action.clip: no room (config.room / trigger.room)" {
		t.Fatal(err)
	}
	if _, _, err := runBox(t, "action.clip", `{"room":"boom"}`, bc, f); err == nil || !strings.Contains(err.Error(), "features.clips.enabled") {
		t.Fatal(err)
	}
	loop := bctx(t, `{"room":"gate"}`)
	loop.Trigger.Event = "clip.ready"
	if _, _, err := runBox(t, "action.clip", `{}`, loop, f); err == nil || !strings.Contains(err.Error(), "loop guard") {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("the loop guard must not reach the seam (%d calls)", len(got))
	}

	// Without the clips service the box fails cleanly.
	r := &Runner{}
	if _, err := r.buildDeps("live").Clip(bg, ClipInput{}); err == nil || err.Error() != "clips service not available" {
		t.Fatal(err)
	}
}

func TestClipCatalogue(t *testing.T) {
	if !knownTypes["action.clip"] {
		t.Fatal("action.clip missing from the palette")
	}
	var fams []struct {
		Family string `json:"family"`
		Events []struct {
			Event string `json:"event"`
		} `json:"events"`
	}
	if err := json.Unmarshal(eventCatalogue(), &fams); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, f := range fams {
		for _, e := range f.Events {
			seen[e.Event] = true
		}
	}
	for _, ev := range []string{"clip.ready", "clip.failed", "clip.*"} {
		if !seen[ev] {
			t.Errorf("event catalogue misses %s", ev)
		}
	}
}
