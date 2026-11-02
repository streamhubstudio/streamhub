package streams

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// G5 — DVR/timeshift + the AMS hlsTime/hlsListSize settings.
//
// LiveKit's SegmentedFileOutput has no window knob: it writes index.m3u8 as
// an EVENT playlist (every segment since the egress started) and, when
// asked, a short rolling live.m3u8. So the core derives the served playlist
// itself: dvr.m3u8 = the last N segments of index.m3u8 (N = hlsListSize, or
// windowMinutes·60 / hlsTime under features.dvr), rewritten on disk whenever
// index.m3u8 changes. On disk on purpose: the HLS direct-serve fronts
// (nginx/Caddy, operations/SCALING.md) serve it like any other playlist.

// WindowPlaylistName is the core-written sliding-window playlist.
const WindowPlaylistName = "dvr.m3u8"

// windowTick is how often the writer checks index.m3u8 for new segments.
const windowTick = time.Second

// HlsPlan is how one app's live HLS is packaged and served.
type HlsPlan struct {
	// SegmentSeconds is the egress segment length (hlsTime).
	SegmentSeconds int
	// Manifest is the playlist handed to players: index.m3u8 (full),
	// live.m3u8 (legacy linear.dvr) or dvr.m3u8 (window).
	Manifest string
	// LivePlaylist also asks the egress for live.m3u8 (linear.dvr).
	LivePlaylist bool
	// WindowSegments > 0: the core writes dvr.m3u8 with that many segments.
	WindowSegments int
	// DvrSeconds > 0: the rewindable window players may seek in.
	DvrSeconds float64
	// PruneSeconds > 0: the janitor deletes older segments, never one
	// referenced by Protect.
	PruneSeconds float64
	Protect      string
	// AlwaysOn: the watchdog relaunches a dead egress of an active stream.
	AlwaysOn bool
}

// PlanFor resolves the plan of an app config. Precedence: features.dvr >
// legacy features.linear.dvr (QW-4, unchanged) > features.hls.list_size.
// An app with none of the blocks gets exactly the historical plan
// (4 s segments, index.m3u8, nothing pruned or rewritten).
func PlanFor(cfg *contracts.AppConfig) HlsPlan { return PlanForSegments(cfg, segmentDurationS) }

// PlanForSegments is PlanFor over a node-wide default segment length
// (STREAMHUB_HLS_SEGMENT_S; < 1 = the historical 4 s). features.hls.
// segment_seconds still wins per app.
func PlanForSegments(cfg *contracts.AppConfig, defaultSegS int) HlsPlan {
	if defaultSegS < 1 {
		defaultSegS = segmentDurationS
	}
	p := HlsPlan{SegmentSeconds: defaultSegS, Manifest: PlaylistName}
	if cfg == nil {
		return p
	}
	f := cfg.Features
	if f.Hls != nil && f.Hls.SegmentSeconds >= 1 {
		p.SegmentSeconds = int(f.Hls.SegmentSeconds)
	}
	linear := f.Linear
	if linear != nil && linear.AlwaysOnHls {
		p.AlwaysOn = true
	}
	switch {
	case f.Dvr != nil && f.Dvr.Enabled:
		window := f.Dvr.WindowMinutes * 60
		p.Manifest = WindowPlaylistName
		p.WindowSegments = int(math.Ceil(window / float64(p.SegmentSeconds)))
		p.DvrSeconds = window
		// Slack of a few segments: a player that fetched the previous window
		// must still find its oldest segment.
		p.PruneSeconds = window + float64(3*p.SegmentSeconds)
		p.Protect = WindowPlaylistName
		// A DVR nobody records is no DVR: keep the egress up.
		p.AlwaysOn = true
	case linear != nil && linear.Dvr:
		p.Manifest = LivePlaylistName
		p.LivePlaylist = true
		p.PruneSeconds = linear.DvrWindowSeconds
		p.Protect = LivePlaylistName
	case f.Hls != nil && f.Hls.ListSize > 0:
		p.Manifest = WindowPlaylistName
		p.WindowSegments = int(f.Hls.ListSize)
	}
	return p
}

// HlsDvrInfo tells a player the stream is rewindable (omitted otherwise).
type HlsDvrInfo struct {
	WindowSeconds  float64 `json:"windowSeconds"`
	SegmentSeconds int     `json:"segmentSeconds"`
}

func (p HlsPlan) dvrInfo() *HlsDvrInfo {
	if p.DvrSeconds <= 0 {
		return nil
	}
	return &HlsDvrInfo{p.DvrSeconds, p.SegmentSeconds}
}

// WriteWindow rewrites <dir>/dvr.m3u8 from <dir>/index.m3u8 (last n
// segments), atomically (tmp + rename) so a reader never sees half a file.
// Returns whether the source has ended (#EXT-X-ENDLIST).
func WriteWindow(dir string, n int) (ended bool, err error) {
	body, err := os.ReadFile(filepath.Join(dir, PlaylistName))
	if err != nil {
		return false, err
	}
	p := ParseMediaPlaylist(string(CompleteLines(body)))
	tl := p.Timeline(func(uri string) (float64, bool) {
		st, err := os.Stat(filepath.Join(dir, filepath.Base(uri)))
		if err != nil {
			return 0, false
		}
		return float64(st.ModTime().UnixNano()) / 1e6, true
	})
	out := BuildWindowPlaylist(p, tl, n)
	tmp := filepath.Join(dir, "."+WindowPlaylistName+".tmp")
	if err := os.WriteFile(tmp, []byte(out), 0o644); err != nil {
		return p.Ended, err
	}
	return p.Ended, os.Rename(tmp, filepath.Join(dir, WindowPlaylistName))
}

type windowState struct {
	segments int
	srcMod   time.Time
	srcSize  int64
}

// WindowWriter keeps the dvr.m3u8 of every tracked HLS dir in step with its
// index.m3u8 (a stat per dir per tick; a rewrite only when the source
// changed). Rooms are tracked by Hls.Start/Status and re-tracked by the
// watchdog pass, so a core restart picks live DVR rooms back up.
type WindowWriter struct {
	mu   sync.Mutex
	dirs map[string]*windowState
	// syncMu serializes rewrites (Track from a request vs the tick).
	syncMu sync.Mutex
}

// NewWindowWriter builds an empty writer.
func NewWindowWriter() *WindowWriter { return &WindowWriter{dirs: map[string]*windowState{}} }

// Track (re)registers dir with a window of n segments and syncs it now.
func (w *WindowWriter) Track(dir string, n int) {
	w.mu.Lock()
	st, ok := w.dirs[dir]
	if !ok || st.segments != n {
		st = &windowState{segments: n}
		w.dirs[dir] = st
	}
	w.mu.Unlock()
	w.sync(dir)
}

// Untrack stops rewriting dir (the last dvr.m3u8 stays on disk).
func (w *WindowWriter) Untrack(dir string) {
	w.mu.Lock()
	delete(w.dirs, dir)
	w.mu.Unlock()
}

// Tracked reports whether dir is tracked (tests, watchdog).
func (w *WindowWriter) Tracked(dir string) (int, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	st, ok := w.dirs[dir]
	if !ok {
		return 0, false
	}
	return st.segments, true
}

// sync rewrites dir's window when index.m3u8 changed; an ended source is
// written one last time and untracked.
func (w *WindowWriter) sync(dir string) {
	w.syncMu.Lock()
	defer w.syncMu.Unlock()
	info, err := os.Stat(filepath.Join(dir, PlaylistName))
	if err != nil {
		return // egress not started yet / dir gone: retry next tick
	}
	w.mu.Lock()
	st, ok := w.dirs[dir]
	if !ok || (st.srcMod.Equal(info.ModTime()) && st.srcSize == info.Size()) {
		w.mu.Unlock()
		return
	}
	n := st.segments
	w.mu.Unlock()
	ended, err := WriteWindow(dir, n)
	if err != nil {
		return
	}
	w.mu.Lock()
	if cur, ok := w.dirs[dir]; ok && cur == st {
		st.srcMod, st.srcSize = info.ModTime(), info.Size()
		if ended {
			delete(w.dirs, dir)
		}
	}
	w.mu.Unlock()
}

// TickOnce syncs every tracked dir.
func (w *WindowWriter) TickOnce() {
	w.mu.Lock()
	dirs := make([]string, 0, len(w.dirs))
	for d := range w.dirs {
		dirs = append(dirs, d)
	}
	w.mu.Unlock()
	for _, d := range dirs {
		w.sync(d)
	}
}

// Start runs the tick until ctx is cancelled.
func (w *WindowWriter) Start(ctx context.Context) {
	t := time.NewTicker(windowTick)
	go func() {
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				w.TickOnce()
			}
		}
	}()
}
