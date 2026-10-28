// Package wsingest is the port of src/modules/ws-ingest: direct WebSocket
// MJPEG ingest for ESP32-CAM class devices (streamhub-docs/integrations/
// ESP32-WS-INGEST.md). Cameras publish JPEG frames on /ingest/ws, viewers
// watch on /live/ws or /live/<app>/<room>/{mjpeg,frame.jpg}; provisioning REST
// lives under /apps/:app/ws-ingest.
//
// Node runs everything on one event loop; here each connection has its own
// goroutine. The fan-out (FrameHub) never blocks the camera: every viewer has
// a bounded drop-oldest queue drained by its own writer goroutine, so a slow
// viewer only loses frames itself.
package wsingest

import (
	"sync"
	"sync/atomic"
)

// ViewerQueueDepth is the per-viewer frame queue (drop-oldest beyond it).
const ViewerQueueDepth = 2

// Viewer is one fan-out subscriber (WS socket or HTTP multipart response).
// Frames arrive on C; the transport goroutine drains it. C is closed when the
// viewer is unsubscribed.
type Viewer struct {
	Kind string // ws | http
	C    chan []byte
	// dropped counts frames discarded because the viewer was behind.
	dropped atomic.Int64
	closed  bool // guarded by the hub mutex
}

// NewViewer builds a viewer with the default queue depth.
func NewViewer(kind string) *Viewer {
	return &Viewer{Kind: kind, C: make(chan []byte, ViewerQueueDepth)}
}

// Dropped is the number of frames this viewer missed.
func (v *Viewer) Dropped() int64 { return v.dropped.Load() }

// offer enqueues without blocking: a full queue drops its OLDEST frame (the
// viewer always converges on the newest picture). Called under the hub lock.
func (v *Viewer) offer(frame []byte) bool {
	if v.closed {
		return false
	}
	select {
	case v.C <- frame:
		return true
	default:
	}
	select {
	case <-v.C:
		v.dropped.Add(1)
	default:
	}
	select {
	case v.C <- frame:
		return true
	default:
		v.dropped.Add(1)
		return false
	}
}

type slot struct {
	lastFrame []byte
	lastTs    int64
	publisher bool
	viewers   map[*Viewer]struct{}
	frames    int64
}

// SlotInfo is the introspection view of one (app, room).
type SlotInfo struct {
	LastTs    int64
	HasFrame  bool
	Publisher bool
	Viewers   int
	Frames    int64
}

// HubKey is the canonical slot key.
func HubKey(app, room string) string { return app + "/" + room }

// FrameHub is the in-memory last-frame store + fan-out. Per slot it keeps
// ONLY the last frame; a new subscriber gets it immediately; the slot is
// deleted when it has no viewers AND no publisher.
type FrameHub struct {
	mu    sync.Mutex
	slots map[string]*slot
}

// NewFrameHub builds an empty hub.
func NewFrameHub() *FrameHub { return &FrameHub{slots: map[string]*slot{}} }

func (h *FrameHub) ensure(key string) *slot {
	s := h.slots[key]
	if s == nil {
		s = &slot{viewers: map[*Viewer]struct{}{}}
		h.slots[key] = s
	}
	return s
}

func (h *FrameHub) gc(key string, s *slot) {
	if len(s.viewers) == 0 && !s.publisher {
		delete(h.slots, key)
	}
}

// Publish stores the last frame (the slice is retained, not copied) and fans
// it out; returns how many viewers accepted it without dropping.
func (h *FrameHub) Publish(app, room string, frame []byte, nowMs int64) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.ensure(HubKey(app, room))
	s.lastFrame = frame
	s.lastTs = nowMs
	s.frames++
	delivered := 0
	for v := range s.viewers {
		before := v.dropped.Load()
		if v.offer(frame) && v.dropped.Load() == before {
			delivered++
		}
	}
	return delivered
}

// Subscribe adds a viewer; it immediately receives the last frame.
func (h *FrameHub) Subscribe(app, room string, v *Viewer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.ensure(HubKey(app, room))
	s.viewers[v] = struct{}{}
	if s.lastFrame != nil {
		v.offer(s.lastFrame)
	}
}

// Unsubscribe removes a viewer (closing its queue); empty slots are deleted.
// Unknown viewers/rooms are a no-op.
func (h *FrameHub) Unsubscribe(app, room string, v *Viewer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !v.closed {
		v.closed = true
		close(v.C)
	}
	key := HubKey(app, room)
	s := h.slots[key]
	if s == nil {
		return
	}
	delete(s.viewers, v)
	h.gc(key, s)
}

// SetPublisher marks the publisher present/absent (drives slot lifetime).
func (h *FrameHub) SetPublisher(app, room string, present bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := HubKey(app, room)
	if present {
		h.ensure(key).publisher = true
		return
	}
	if s := h.slots[key]; s != nil {
		s.publisher = false
		h.gc(key, s)
	}
}

// LastFrame returns the last frame of a room (nil when none).
func (h *FrameHub) LastFrame(app, room string) ([]byte, int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.slots[HubKey(app, room)]; s != nil && s.lastFrame != nil {
		return s.lastFrame, s.lastTs
	}
	return nil, 0
}

// HasPublisher reports whether a live publisher is attached to the room.
func (h *FrameHub) HasPublisher(app, room string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.slots[HubKey(app, room)]
	return s != nil && s.publisher
}

// ViewerCount is the number of viewers of a room.
func (h *FrameHub) ViewerCount(app, room string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.slots[HubKey(app, room)]; s != nil {
		return len(s.viewers)
	}
	return 0
}

// Info is the slot introspection (nil when the slot does not exist).
func (h *FrameHub) Info(app, room string) *SlotInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.slots[HubKey(app, room)]
	if s == nil {
		return nil
	}
	return &SlotInfo{s.lastTs, s.lastFrame != nil, s.publisher, len(s.viewers), s.frames}
}

// Size is the number of live slots.
func (h *FrameHub) Size() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.slots)
}
