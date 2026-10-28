package passthrough

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// fakeProc is a spawned child the test drives (output + exit).
type fakeProc struct {
	pid        int
	bin        string
	args       []string
	onOut      func(string, []byte)
	onExit     ExitFunc
	terminated bool
}

func (p *fakeProc) Pid() int   { return p.pid }
func (p *fakeProc) Terminate() { p.terminated = true }

func (p *fakeProc) exit(code int) { c := code; p.onExit(&c, "", nil) }

type fakeSpawner struct {
	mu    sync.Mutex
	procs []*fakeProc
	err   error
}

func (f *fakeSpawner) spawn(bin string, args []string, onOut func(string, []byte), onExit ExitFunc) (Proc, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	p := &fakeProc{pid: 100 + len(f.procs), bin: bin, args: args, onOut: onOut, onExit: onExit}
	f.procs = append(f.procs, p)
	return p, nil
}

func (f *fakeSpawner) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.procs)
}

func (f *fakeSpawner) last() *fakeProc {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.procs[len(f.procs)-1]
}

type logEntry struct {
	level, source, msg string
	meta               map[string]any
	appID              *int64
}

type fakeLogs struct {
	mu      sync.Mutex
	entries []logEntry
}

func (l *fakeLogs) Write(level, source, msg string, meta any, appID *int64) {
	m, _ := meta.(map[string]any)
	l.mu.Lock()
	l.entries = append(l.entries, logEntry{level, source, msg, m, appID})
	l.mu.Unlock()
}

type remuxFixture struct {
	mgr    *RemuxManager
	sp     *fakeSpawner
	logs   *fakeLogs
	timers []func()
	delays []time.Duration
	spec   RemuxSpec
}

func newRemux(t *testing.T) *remuxFixture {
	f := &remuxFixture{sp: &fakeSpawner{}, logs: &fakeLogs{}}
	f.mgr = NewRemuxManager("", f.sp.spawn, func() Logs { return f.logs }, testutil.Log())
	f.mgr.afterFunc = func(d time.Duration, fn func()) *time.Timer {
		f.delays = append(f.delays, d)
		f.timers = append(f.timers, fn)
		return time.NewTimer(time.Hour)
	}
	appID := int64(7)
	f.spec = RemuxSpec{App: "live", Room: "live-ch1", StreamKey: "ptk_secret", Port: 1937,
		HlsDir: filepath.Join(t.TempDir(), "apps", "live", "hls", "live-ch1"), AppID: &appID}
	t.Cleanup(f.mgr.Close)
	return f
}

func (f *remuxFixture) fire() {
	pending := f.timers
	f.timers = nil
	for _, fn := range pending {
		fn()
	}
}

func TestRemuxStartSpawnsAndCreatesDir(t *testing.T) {
	f := newRemux(t)
	if _, ok := f.mgr.Status("pti_1"); ok {
		t.Fatal("never-started remux has a status")
	}
	st := f.mgr.Start("pti_1", f.spec)
	if st.Status != StatusLive || st.Pid != 100 || st.StartedAt == "" {
		t.Fatalf("state = %+v", st)
	}
	p := f.sp.last()
	args := strings.Join(p.args, " ")
	if p.bin != "ffmpeg" || !strings.Contains(args, "-listen 1") || !strings.Contains(args, "-c copy") ||
		!strings.Contains(args, "rtmp://0.0.0.0:1937/live/ptk_secret") {
		t.Fatalf("spawn %s %s", p.bin, args)
	}
	if fi, err := os.Stat(f.spec.HlsDir); err != nil || !fi.IsDir() {
		t.Fatal("HLS dir not created")
	}
	if !f.mgr.IsActive("pti_1") {
		t.Fatal("not active")
	}
	// Idempotent while live.
	f.mgr.Start("pti_1", f.spec)
	if f.sp.count() != 1 {
		t.Fatal("second spawn while live")
	}
}

func TestRemuxMirrorsOutputToLogs(t *testing.T) {
	f := newRemux(t)
	f.mgr.Start("pti_1", f.spec)
	f.sp.last().onOut("stderr", []byte("warn one\r\n\n  \nwarn two  \n"))
	f.sp.last().onOut("stdout", []byte("info line"))
	var got []logEntry
	for _, e := range f.logs.entries {
		if e.meta["stream"] != "system" {
			got = append(got, e)
		}
	}
	if len(got) != 3 || got[0].msg != "warn one" || got[1].msg != "warn two" || got[0].level != "warn" || got[2].level != "info" {
		t.Fatalf("logs = %+v", got)
	}
	if got[0].source != "remux:pti_1" || got[0].meta["app"] != "live" || got[0].meta["room"] != "live-ch1" || *got[0].appID != 7 {
		t.Fatalf("entry = %+v", got[0])
	}
	if lines := f.mgr.Logs("pti_1", 2); len(lines) != 2 || lines[1].Line != "info line" || lines[1].Stream != "stdout" {
		t.Fatalf("buffer = %+v", lines)
	}
}

func TestRemuxStopTerminatesAndCleans(t *testing.T) {
	f := newRemux(t)
	f.mgr.Start("pti_1", f.spec)
	p := f.sp.last()
	st := f.mgr.Stop("pti_1")
	if !p.terminated || st.Status != StatusOff || st.Pid != 0 || st.StoppedAt == "" {
		t.Fatalf("stop: terminated=%v state=%+v", p.terminated, st)
	}
	if _, err := os.Stat(f.spec.HlsDir); !os.IsNotExist(err) {
		t.Fatal("HLS dir not removed")
	}
	// The exit after stop is a teardown: no restart.
	p.exit(255)
	if len(f.timers) != 0 || f.sp.count() != 1 {
		t.Fatal("restart after stop")
	}
	if st, _ := f.mgr.Status("pti_1"); st.Status != StatusOff {
		t.Fatalf("status = %s", st.Status)
	}
	if st := f.mgr.Stop("unknown"); st.Status != StatusOff || st.ID != "unknown" {
		t.Fatalf("unknown stop = %+v", st)
	}
}

func TestRemuxCrashRestartsWithBackoff(t *testing.T) {
	f := newRemux(t)
	f.mgr.Start("pti_1", f.spec)
	f.sp.last().exit(1)
	st, _ := f.mgr.Status("pti_1")
	if st.Status != StatusIdle || *st.ExitCode != 1 || len(f.delays) != 1 || f.delays[0] != time.Second {
		t.Fatalf("state=%+v delays=%v", st, f.delays)
	}
	f.fire()
	if f.sp.count() != 2 {
		t.Fatal("no restart")
	}
	st, _ = f.mgr.Status("pti_1")
	if st.Restarts != 1 || st.Status != StatusLive {
		t.Fatalf("state = %+v", st)
	}
	// Linear growth, capped at 15 s.
	for i := 0; i < 9; i++ {
		f.sp.last().exit(1)
		f.fire()
	}
	if f.delays[1] != 2*time.Second || f.delays[len(f.delays)-1] != 10*time.Second {
		t.Fatalf("delays = %v", f.delays)
	}
	// Failure #11 gives up.
	f.sp.last().exit(1)
	st, _ = f.mgr.Status("pti_1")
	if st.Status != StatusError || st.Error != "gave up after 11 consecutive failures" || len(f.timers) != 0 {
		t.Fatalf("state = %+v timers=%d", st, len(f.timers))
	}
}

func TestRemuxCleanEndRearms(t *testing.T) {
	f := newRemux(t)
	f.mgr.Start("pti_1", f.spec)
	f.sp.last().exit(0)
	if len(f.delays) != 1 || f.delays[0] != rearmDelay {
		t.Fatalf("delays = %v", f.delays)
	}
	f.fire()
	if f.sp.count() != 2 {
		t.Fatal("clean end did not re-arm")
	}
}

func TestRemuxSpawnErrorIsACrash(t *testing.T) {
	f := newRemux(t)
	f.sp.err = errors.New("spawn ffmpeg ENOENT")
	st := f.mgr.Start("pti_1", f.spec)
	if st.Status != StatusIdle || st.Error != "spawn ffmpeg ENOENT" || len(f.timers) != 1 {
		t.Fatalf("state = %+v", st)
	}
}

func TestRemuxCloseTerminatesAll(t *testing.T) {
	f := newRemux(t)
	f.mgr.Start("a", f.spec)
	f.mgr.Start("b", f.spec)
	f.mgr.Close()
	for _, p := range f.sp.procs {
		if !p.terminated {
			t.Fatal("child left running")
		}
	}
	if len(f.mgr.List()) != 0 {
		t.Fatal("entries kept")
	}
}

func TestRemuxForwardChild(t *testing.T) {
	f := newRemux(t)
	fwd := RemuxSpec{Kind: "forward", App: "live", Room: "sk_lk", StreamKey: "sk_lk", ForwardKey: "sk_lk", Port: 1935, DestPort: 11935}
	f.mgr.Start("fwd_sk_lk", fwd)
	got := strings.Join(f.sp.last().args, " ")
	if got != "-hide_banner -loglevel warning -i rtmp://127.0.0.1:1935/live/sk_lk -c copy -f flv rtmp://127.0.0.1:11935/live/sk_lk" {
		t.Fatalf("args = %s", got)
	}
	f.mgr.Start("pti_1", f.spec)
	list := f.mgr.List()
	if len(list) != 1 || list[0].IngressID != "pti_1" || list[0].Desired != "live" {
		t.Fatalf("list = %+v", list)
	}
	if st := f.mgr.Stop("fwd_sk_lk"); st.Status != StatusOff {
		t.Fatal(st)
	}
	if !f.sp.procs[0].terminated {
		t.Fatal("forward not terminated")
	}
}

// A stale child's exit (replaced by a later launch) must not clobber it.
func TestRemuxStaleExitIgnored(t *testing.T) {
	f := newRemux(t)
	f.mgr.Start("pti_1", f.spec)
	old := f.sp.last()
	f.mgr.Stop("pti_1")
	f.mgr.Start("pti_1", f.spec)
	old.exit(1)
	if st, _ := f.mgr.Status("pti_1"); st.Status != StatusLive || len(f.timers) != 0 {
		t.Fatalf("state = %+v", st)
	}
}

func TestExecSpawnerRealProcess(t *testing.T) {
	done := make(chan *int, 1)
	var mu sync.Mutex
	var out strings.Builder
	p, err := ExecSpawner("/bin/sh", []string{"-c", "echo hi; echo err >&2; exit 3"}, func(_ string, b []byte) {
		mu.Lock()
		out.Write(b)
		mu.Unlock()
	}, func(code *int, _ string, err error) { done <- code })
	if err != nil {
		t.Skip("no /bin/sh:", err)
	}
	if p.Pid() <= 0 {
		t.Fatal("pid")
	}
	select {
	case code := <-done:
		if code == nil || *code != 3 {
			t.Fatalf("code = %v", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no exit")
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(out.String(), "hi") || !strings.Contains(out.String(), "err") {
		t.Fatalf("output = %q", out.String())
	}
}
