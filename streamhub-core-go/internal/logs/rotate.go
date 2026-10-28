package logs

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// RotationOptions configure a RotatingFile (rotating-file-stream.ts).
type RotationOptions struct {
	// Dir holds the active + archived files.
	Dir string
	// BaseName without extension; the active file is <BaseName>.log.
	BaseName string
	// LegacyBaseNames are archive prefixes still swept (e.g. "skyline")
	// but never written.
	LegacyBaseNames []string
	// MaxBytes rotates when the active file would exceed it (default 10 MiB).
	MaxBytes int64
	// MaxFiles caps the archive count (default 10).
	MaxFiles int
	// MaxAgeDays prunes archives older than this (0 = off).
	MaxAgeDays int
}

// RotatingFile is an append-only line logger rotating by size AND calendar
// day (UTC). On rotation the active file is renamed to
// <base>-<ISO-ts with : and . as ->.log. Archives are pruned by count and age.
// Every operation swallows filesystem errors: logging never crashes.
type RotatingFile struct {
	dir      string
	base     string
	legacy   []string
	maxBytes int64
	maxFiles int
	maxAge   time.Duration
	now      func() time.Time

	mu   sync.Mutex
	f    *os.File
	size int64
	day  string
}

// NewRotatingFile applies the Node defaults to opts.
func NewRotatingFile(opts RotationOptions) *RotatingFile {
	r := &RotatingFile{dir: opts.Dir, base: opts.BaseName, maxBytes: opts.MaxBytes, maxFiles: opts.MaxFiles, now: time.Now}
	if r.base == "" {
		r.base = "streamhub"
	}
	for _, b := range opts.LegacyBaseNames {
		if b != "" && b != r.base {
			r.legacy = append(r.legacy, b)
		}
	}
	if r.maxBytes <= 0 {
		r.maxBytes = 10 * 1024 * 1024
	}
	if r.maxFiles <= 0 {
		r.maxFiles = 10
	}
	if opts.MaxAgeDays > 0 {
		r.maxAge = time.Duration(opts.MaxAgeDays) * 24 * time.Hour
	}
	return r
}

// Write appends one line (the caller includes the newline). Never fails.
func (r *RotatingFile) Write(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		r.open()
	}
	n := int64(len(line))
	if r.day != r.today() || (r.size > 0 && r.size+n > r.maxBytes) {
		r.rotate()
	}
	if r.f == nil {
		return
	}
	if _, err := r.f.WriteString(line); err == nil {
		r.size += n
	}
}

// Sweep prunes archives beyond the count cap or older than MaxAgeDays.
func (r *RotatingFile) Sweep() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.prune()
}

// Close closes the active file.
func (r *RotatingFile) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil {
		_ = r.f.Close()
		r.f = nil
	}
}

func (r *RotatingFile) activePath() string { return filepath.Join(r.dir, r.base+".log") }

func (r *RotatingFile) today() string { return r.now().UTC().Format("2006-01-02") }

func (r *RotatingFile) open() {
	if err := os.MkdirAll(r.dir, 0o775); err != nil {
		return
	}
	f, err := os.OpenFile(r.activePath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	r.size = 0
	if st, err := f.Stat(); err == nil {
		r.size = st.Size()
	}
	r.f = f
	r.day = r.today()
}

func (r *RotatingFile) rotate() {
	if r.f != nil {
		_ = r.f.Close()
		r.f = nil
	}
	active := r.activePath()
	if st, err := os.Stat(active); err == nil && st.Size() > 0 {
		ts := strings.NewReplacer(":", "-", ".", "-").Replace(jsx.ISO(r.now()))
		_ = os.Rename(active, filepath.Join(r.dir, r.base+"-"+ts+".log"))
	}
	r.prune()
	r.open()
}

func (r *RotatingFile) isArchive(f string) bool {
	if !strings.HasSuffix(f, ".log") {
		return false
	}
	for _, b := range append([]string{r.base}, r.legacy...) {
		if strings.HasPrefix(f, b+"-") {
			return true
		}
	}
	return false
}

func (r *RotatingFile) prune() {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return
	}
	type archive struct {
		name string
		t    time.Time
	}
	var archives []archive
	for _, e := range entries {
		if !r.isArchive(e.Name()) {
			continue
		}
		var t time.Time
		if st, err := os.Stat(filepath.Join(r.dir, e.Name())); err == nil {
			t = st.ModTime()
		}
		archives = append(archives, archive{e.Name(), t})
	}
	sort.SliceStable(archives, func(i, j int) bool { return archives[i].t.After(archives[j].t) })

	doomed := map[string]bool{}
	if len(archives) > r.maxFiles {
		for _, a := range archives[r.maxFiles:] {
			doomed[a.name] = true
		}
	}
	if r.maxAge > 0 {
		now := r.now()
		for _, a := range archives {
			if !a.t.IsZero() && now.Sub(a.t) > r.maxAge {
				doomed[a.name] = true
			}
		}
	}
	for name := range doomed {
		_ = os.Remove(filepath.Join(r.dir, name))
	}
}
