package plugins

import (
	"math"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// Port of plugin-livedata.service.ts: in-memory, latest-only, size-capped
// worker → player payloads per (app, plugin, room).

const (
	// MaxLivePayloadBytes caps one payload (UTF-16 length of its JSON).
	MaxLivePayloadBytes = 64 * 1024
	// MaxLiveKeys caps the distinct (app, plugin, room) keys.
	MaxLiveKeys = 256
)

// LiveDataView is what a reader gets.
type LiveDataView struct {
	TS      *int64 `json:"ts"`
	AgeMs   *int64 `json:"ageMs"`
	Payload any    `json:"payload"`
}

type liveEntry struct {
	ts      int64
	payload any
}

// LiveData is the store.
type LiveData struct {
	mu      sync.Mutex
	entries map[string]liveEntry
	order   []string // insertion order (Map iteration for eviction ties)
	Now     func() int64
}

// NewLiveData builds the store.
func NewLiveData() *LiveData {
	return &LiveData{entries: map[string]liveEntry{}, Now: func() int64 { return time.Now().UnixMilli() }}
}

func liveKey(app, pluginID, room string) string { return app + "::" + pluginID + "::" + room }

// Push stores the latest payload; false when it is over the size cap.
func (l *LiveData) Push(app, pluginID, room string, payload any) bool {
	s, err := stringifyJS(payload)
	if err != nil || jsx.UTF16Len(s) > MaxLivePayloadBytes {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	k := liveKey(app, pluginID, room)
	if _, ok := l.entries[k]; !ok {
		if len(l.entries) >= MaxLiveKeys {
			l.evictOldest()
		}
		l.order = append(l.order, k)
	}
	l.entries[k] = liveEntry{ts: l.Now(), payload: payload}
	return true
}

// Latest returns the newest payload (nil when none was pushed).
func (l *LiveData) Latest(app, pluginID, room string) *LiveDataView {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[liveKey(app, pluginID, room)]
	if !ok {
		return nil
	}
	ts, age := e.ts, max(0, l.Now()-e.ts)
	return &LiveDataView{TS: &ts, AgeMs: &age, Payload: e.payload}
}

// Clear drops every room feed of one (app, plugin).
func (l *LiveData) Clear(app, pluginID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	prefix := app + "::" + pluginID + "::"
	kept := l.order[:0]
	for _, k := range l.order {
		if strings.HasPrefix(k, prefix) {
			delete(l.entries, k)
			continue
		}
		kept = append(kept, k)
	}
	l.order = kept
}

func (l *LiveData) evictOldest() {
	oldest, at, ts := -1, "", int64(math.MaxInt64)
	for i, k := range l.order {
		if e := l.entries[k]; e.ts < ts {
			oldest, at, ts = i, k, e.ts
		}
	}
	if oldest >= 0 {
		delete(l.entries, at)
		l.order = append(l.order[:oldest], l.order[oldest+1:]...)
	}
}
