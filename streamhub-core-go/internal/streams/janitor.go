package streams

import (
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Port of hls-dvr-janitor.ts: reclaims disk on always-on/DVR HLS rooms by
// deleting .ts segments older than the DVR window — never one referenced by
// the LIVE (rolling) playlist. Pure/fs split so the decision is testable.

var lineSplit = regexp.MustCompile(`\r?\n`)

// ParsePlaylistSegments returns the .ts basenames an HLS playlist references
// (tags, comments, blanks and query strings ignored).
func ParsePlaylistSegments(m3u8 string) map[string]bool {
	out := map[string]bool{}
	for _, raw := range lineSplit.Split(m3u8, -1) {
		line := jsTrim(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		uri := strings.SplitN(line, "?", 2)[0]
		if strings.HasSuffix(uri, ".ts") {
			out[path.Base(uri)] = true
		}
	}
	return out
}

// SegmentStat is one on-disk segment with its mtime (ms epoch).
type SegmentStat struct {
	Name    string
	MtimeMs float64
}

// SelectExpiredSegments: older than the window AND not referenced.
func SelectExpiredSegments(segments []SegmentStat, referenced map[string]bool, windowMs, now float64) []string {
	if windowMs < 0 {
		windowMs = 0
	}
	cutoff := now - windowMs
	out := []string{}
	for _, s := range segments {
		if s.MtimeMs < cutoff && !referenced[s.Name] {
			out = append(out, s.Name)
		}
	}
	return out
}

// PruneResult is the outcome of one pruneDvrDir pass.
type PruneResult struct {
	Deleted []string
	Kept    int
}

// JanitorFS is the minimal fs surface (fakeable in tests).
type JanitorFS interface {
	Exists(path string) bool
	ReadFile(path string) ([]byte, error)
	ReadDir(dir string) ([]string, error)
	MtimeMs(path string) (float64, error)
	Remove(path string) error
}

type osFS struct{}

func (osFS) Exists(p string) bool { _, err := os.Stat(p); return err == nil }

func (osFS) ReadFile(p string) ([]byte, error) { return os.ReadFile(p) }

func (osFS) ReadDir(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

func (osFS) MtimeMs(p string) (float64, error) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, err
	}
	return float64(st.ModTime().UnixNano()) / 1e6, nil
}

func (osFS) Remove(p string) error { return os.Remove(p) }

// PruneOptions are pruneDvrDir's opts (zero values = Node defaults).
type PruneOptions struct {
	LivePlaylist string // default live.m3u8
	Now          float64
	FS           JanitorFS
}

// PruneDvrDir deletes .ts segments older than windowSeconds from dir, never
// one referenced by the live playlist. No-op when the dir or the live
// playlist is absent/unreadable; a failed unlink keeps the segment.
func PruneDvrDir(dir string, windowSeconds float64, o PruneOptions) PruneResult {
	fsys := o.FS
	if fsys == nil {
		fsys = osFS{}
	}
	now := o.Now
	if now == 0 {
		now = float64(time.Now().UnixNano()) / 1e6
	}
	live := o.LivePlaylist
	if live == "" {
		live = LivePlaylistName
	}
	empty := PruneResult{Deleted: []string{}}
	if !fsys.Exists(dir) {
		return empty
	}
	body, err := fsys.ReadFile(filepath.Join(dir, live))
	if err != nil {
		return empty
	}
	referenced := ParsePlaylistSegments(string(body))
	entries, err := fsys.ReadDir(dir)
	if err != nil {
		return empty
	}
	var segments []SegmentStat
	for _, name := range entries {
		if !strings.HasSuffix(name, ".ts") {
			continue
		}
		m, err := fsys.MtimeMs(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		segments = append(segments, SegmentStat{name, m})
	}
	if windowSeconds < 0 {
		windowSeconds = 0
	}
	deleted := []string{}
	for _, name := range SelectExpiredSegments(segments, referenced, windowSeconds*1000, now) {
		if err := fsys.Remove(filepath.Join(dir, name)); err == nil {
			deleted = append(deleted, name)
		}
	}
	return PruneResult{Deleted: deleted, Kept: len(segments) - len(deleted)}
}
