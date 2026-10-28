package wsingest

import "testing"

func recv(v *Viewer) [][]byte {
	var out [][]byte
	for {
		select {
		case f := <-v.C:
			out = append(out, f)
		default:
			return out
		}
	}
}

func TestFrameHub(t *testing.T) {
	t.Run("keeps only the last frame per (app, room)", func(t *testing.T) {
		h := NewFrameHub()
		h.Publish("a", "r", []byte("1"), 1)
		h.Publish("a", "r", []byte("2"), 2)
		h.Publish("a", "other", []byte("x"), 3)
		if f, ts := h.LastFrame("a", "r"); string(f) != "2" || ts != 2 {
			t.Fatal(string(f), ts)
		}
	})
	t.Run("new subscriber immediately gets the last frame", func(t *testing.T) {
		h := NewFrameHub()
		h.Publish("a", "r", []byte("1"), 1)
		v := NewViewer("ws")
		h.Subscribe("a", "r", v)
		if got := recv(v); len(got) != 1 || string(got[0]) != "1" {
			t.Fatal(got)
		}
	})
	t.Run("subscribing before any frame delivers nothing", func(t *testing.T) {
		h := NewFrameHub()
		v := NewViewer("ws")
		h.Subscribe("a", "r", v)
		if len(recv(v)) != 0 {
			t.Fatal("unexpected frame")
		}
		if n := h.Publish("a", "r", []byte("1"), 1); n != 1 || len(recv(v)) != 1 {
			t.Fatal("publish not delivered")
		}
	})
	t.Run("slow viewer drops oldest, never blocks the others", func(t *testing.T) {
		h := NewFrameHub()
		fast, slow := NewViewer("ws"), NewViewer("http")
		h.Subscribe("a", "r", fast)
		h.Subscribe("a", "r", slow)
		for i := 0; i < 5; i++ {
			h.Publish("a", "r", []byte{byte('0' + i)}, int64(i))
			recv(fast) // the fast viewer keeps up
		}
		got := recv(slow)
		if len(got) != ViewerQueueDepth || string(got[len(got)-1]) != "4" {
			t.Fatalf("slow viewer got %q", got)
		}
		if slow.Dropped() != 5-ViewerQueueDepth || fast.Dropped() != 0 {
			t.Fatal(slow.Dropped(), fast.Dropped())
		}
	})
	t.Run("slot lifecycle", func(t *testing.T) {
		h := NewFrameHub()
		v := NewViewer("ws")
		h.SetPublisher("a", "r", true)
		h.Subscribe("a", "r", v)
		h.SetPublisher("a", "r", false)
		if h.Size() != 1 || h.HasPublisher("a", "r") {
			t.Fatal("slot with a viewer must survive")
		}
		h.Unsubscribe("a", "r", v)
		if h.Size() != 0 {
			t.Fatal("empty slot not deleted")
		}
		if _, ok := <-v.C; ok {
			t.Fatal("queue not closed on unsubscribe")
		}
		// Unknown viewer / room: no-op, and a closed viewer gets no frames.
		h.Unsubscribe("x", "y", NewViewer("ws"))
		h.Unsubscribe("a", "r", v)
	})
	t.Run("counts and info", func(t *testing.T) {
		h := NewFrameHub()
		h.Subscribe("a", "r", NewViewer("ws"))
		h.Subscribe("a", "r", NewViewer("http"))
		h.SetPublisher("a", "r", true)
		h.Publish("a", "r", []byte("f"), 9)
		info := h.Info("a", "r")
		if h.ViewerCount("a", "r") != 2 || info == nil || !info.HasFrame || !info.Publisher || info.Viewers != 2 || info.Frames != 1 || info.LastTs != 9 {
			t.Fatalf("%+v", info)
		}
		if h.Info("a", "none") != nil || h.ViewerCount("a", "none") != 0 {
			t.Fatal("unknown slot")
		}
	})
}
