package streams

import (
	"reflect"
	"sort"
	"testing"
)

func (h *harness) insertStatus(streamID, room, status string) {
	h.t.Helper()
	h.insertActive(streamID, "webrtc", room, "", 0)
	if status != "active" {
		_, _ = h.adb.Exec("UPDATE streams SET status = ? WHERE stream_id = ?", status, streamID)
	}
}

func (h *harness) rawDisabled(streamID string) string {
	var s string
	if err := h.adb.QueryRow("SELECT disabled_plugins FROM streams WHERE stream_id = ?", streamID).Scan(&s); err != nil {
		h.t.Fatal(err)
	}
	return s
}

func sorted(a []string) []string { b := append([]string(nil), a...); sort.Strings(b); return b }

func TestPluginOverrides(t *testing.T) {
	t.Run("migration default [] and nothing disabled", func(t *testing.T) {
		h := newHarness(t, nil)
		p := NewPluginOverrides(h.store)
		h.insertStatus("room-a/cam1", "room-a", "active")
		if h.rawDisabled("room-a/cam1") != "[]" {
			t.Fatal(h.rawDisabled("room-a/cam1"))
		}
		st, err := p.GetForStream(bg, testApp, "room-a/cam1")
		if err != nil || len(st.Disabled) != 0 || st.Disabled == nil {
			t.Fatalf("%+v %v", st, err)
		}
		if len(p.DisabledForStream(bg, testApp, "room-a/cam1")) != 0 || len(p.DisabledForRoom(bg, testApp, "room-a")) != 0 {
			t.Fatal("default must be empty")
		}
	})
	t.Run("set/get normalizes and persists", func(t *testing.T) {
		h := newHarness(t, nil)
		p := NewPluginOverrides(h.store)
		h.insertStatus("room-a/cam1", "room-a", "active")
		out, err := p.SetForStream(bg, testApp, "room-a/cam1", []any{"watermark", "watermark", "  timestamp  ", "", 42.0})
		want := []string{"watermark", "timestamp"}
		if err != nil || out.StreamID != "room-a/cam1" || !reflect.DeepEqual(out.Disabled, want) {
			t.Fatalf("%+v %v", out, err)
		}
		if h.rawDisabled("room-a/cam1") != `["watermark","timestamp"]` {
			t.Fatal(h.rawDisabled("room-a/cam1"))
		}
		got, _ := p.GetForStream(bg, testApp, "room-a/cam1")
		if !reflect.DeepEqual(got.Disabled, want) {
			t.Fatal(got.Disabled)
		}
	})
	t.Run("siblings unaffected; room union ignores ended", func(t *testing.T) {
		h := newHarness(t, nil)
		p := NewPluginOverrides(h.store)
		h.insertStatus("room-a/cam1", "room-a", "active")
		h.insertStatus("room-a/cam2", "room-a", "active")
		h.insertStatus("room-a/old", "room-a", "ended")
		h.insertStatus("room-b/cam3", "room-b", "active")
		_, _ = p.SetForStream(bg, testApp, "room-a/cam1", []any{"watermark"})
		_, _ = p.SetForStream(bg, testApp, "room-a/cam2", []any{"timestamp"})
		_, _ = p.SetForStream(bg, testApp, "room-a/old", []any{"yolo"})
		if got := p.DisabledForStream(bg, testApp, "room-b/cam3"); len(got) != 0 {
			t.Fatal(got)
		}
		if got := sorted(p.DisabledForRoom(bg, testApp, "room-a")); !reflect.DeepEqual(got, []string{"timestamp", "watermark"}) {
			t.Fatal(got)
		}
		if got := p.ResolveDisabled(bg, testApp, StreamScope{Stream: "room-a/cam1", Room: "room-a"}); !reflect.DeepEqual(got, []string{"watermark"}) {
			t.Fatal(got)
		}
		if got := sorted(p.ResolveDisabled(bg, testApp, StreamScope{Room: " room-a "})); len(got) != 2 {
			t.Fatal(got)
		}
		if got := p.ResolveDisabled(bg, testApp, StreamScope{}); len(got) != 0 {
			t.Fatal(got)
		}
	})
	t.Run("unknown → [] for resolution, 404 for get/set", func(t *testing.T) {
		h := newHarness(t, nil)
		p := NewPluginOverrides(h.store)
		if len(p.DisabledForStream(bg, testApp, "nope/x")) != 0 || len(p.DisabledForRoom(bg, testApp, "ghost")) != 0 {
			t.Fatal("expected empty")
		}
		_, err := p.GetForStream(bg, testApp, "nope/x")
		wantStatus(t, err, 404, "stream 'nope/x' not found")
		_, err = p.SetForStream(bg, testApp, "nope/x", []any{"watermark"})
		wantStatus(t, err, 404, "stream 'nope/x' not found")
	})
}
