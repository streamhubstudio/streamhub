package supervisor

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProc exits when told (crash), or on Interrupt/Kill.
type fakeProc struct {
	pid         int
	exit        chan error
	once        sync.Once
	ignoreInt   bool
	interrupted atomic.Bool
}

func (f *fakeProc) Pid() int      { return f.pid }
func (f *fakeProc) Wait() error   { return <-f.exit }
func (f *fakeProc) end(err error) { f.once.Do(func() { f.exit <- err }) }
func (f *fakeProc) Interrupt() error {
	f.interrupted.Store(true)
	if !f.ignoreInt {
		f.end(errors.New("signal: interrupt"))
	}
	return nil
}
func (f *fakeProc) Kill() error { f.end(errors.New("signal: killed")); return nil }

type fakeRunner struct {
	mu        sync.Mutex
	procs     []*fakeProc
	starts    atomic.Int32
	failStart atomic.Bool
	ignoreInt bool
	specs     []Spec
}

func (r *fakeRunner) Start(s Spec, out io.Writer) (Proc, error) {
	r.starts.Add(1)
	if r.failStart.Load() {
		return nil, errors.New("exec: not found")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p := &fakeProc{pid: 1000 + len(r.procs), exit: make(chan error, 1), ignoreInt: r.ignoreInt}
	r.procs = append(r.procs, p)
	r.specs = append(r.specs, s)
	fmt.Fprintf(out, "started %s\n", s.Name)
	return p, nil
}

func (r *fakeRunner) last() *fakeProc {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.procs) == 0 {
		return nil
	}
	return r.procs[len(r.procs)-1]
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func opts() Options {
	return Options{MinBackoff: 20 * time.Millisecond, MaxBackoff: 160 * time.Millisecond, StableAfter: time.Hour, StopTimeout: 100 * time.Millisecond}
}

func TestRestartsAfterCrashWithBackoff(t *testing.T) {
	r := &fakeRunner{}
	p := New(Spec{Name: "eng", Path: "gst"}, r, opts())
	p.Start()
	defer p.Stop()
	waitFor(t, "running", func() bool { return p.Status().State == Running })
	var gaps []time.Duration
	for i := 0; i < 4; i++ {
		before := r.starts.Load()
		crashAt := time.Now()
		r.last().end(errors.New("exit status 1"))
		waitFor(t, "restart", func() bool { return r.starts.Load() == before+1 && p.Status().State == Running })
		gaps = append(gaps, time.Since(crashAt))
	}
	if p.Status().Restarts != 4 {
		t.Fatalf("restarts = %d", p.Status().Restarts)
	}
	// exponential: 20, 40, 80, 160 ms (± scheduling)
	if gaps[3] < 120*time.Millisecond || gaps[0] > 100*time.Millisecond {
		t.Fatalf("backoff not exponential: %v", gaps)
	}
	if !strings.Contains(strings.Join(p.Logs().Lines(), "\n"), "exit status 1; restarting in") {
		t.Fatalf("supervisor log missing: %v", p.Logs().Lines())
	}
}

func TestBackoffResetsAfterStableRun(t *testing.T) {
	r := &fakeRunner{}
	o := opts()
	o.StableAfter = 50 * time.Millisecond
	p := New(Spec{Name: "eng"}, r, o)
	p.Start()
	defer p.Stop()
	for i := 0; i < 3; i++ { // grow the backoff
		waitFor(t, "running", func() bool { return p.Status().State == Running })
		r.last().end(errors.New("boom"))
		waitFor(t, "backoff", func() bool { return p.Status().State != Running || r.starts.Load() > int32(i+1) })
	}
	waitFor(t, "running", func() bool { return p.Status().State == Running })
	time.Sleep(80 * time.Millisecond) // stable
	crash := time.Now()
	before := r.starts.Load()
	r.last().end(errors.New("boom"))
	waitFor(t, "restart", func() bool { return r.starts.Load() == before+1 })
	if d := time.Since(crash); d > 60*time.Millisecond {
		t.Fatalf("backoff did not reset after a stable run: %v", d)
	}
}

func TestStopInterruptsThenKills(t *testing.T) {
	r := &fakeRunner{ignoreInt: true}
	p := New(Spec{Name: "eng"}, r, opts())
	p.Start()
	waitFor(t, "running", func() bool { return p.Status().State == Running })
	proc := r.last()
	start := time.Now()
	p.Stop()
	if !proc.interrupted.Load() {
		t.Fatal("Stop must send SIGINT first (EOS for gst-launch -e)")
	}
	if time.Since(start) < 90*time.Millisecond {
		t.Fatal("Stop must wait StopTimeout before SIGKILL")
	}
	if p.Status().State != Stopped {
		t.Fatalf("state %s", p.Status().State)
	}
	n := r.starts.Load()
	time.Sleep(60 * time.Millisecond)
	if r.starts.Load() != n {
		t.Fatal("restarted after Stop")
	}
}

func TestRestartIsImmediate(t *testing.T) {
	r := &fakeRunner{}
	o := opts()
	o.MinBackoff = time.Second // a crash would wait 1 s; Restart must not
	p := New(Spec{Name: "eng"}, r, o)
	p.Start()
	defer p.Stop()
	waitFor(t, "running", func() bool { return p.Status().State == Running })
	start := time.Now()
	p.Restart()
	waitFor(t, "second start", func() bool { return r.starts.Load() == 2 && p.Status().State == Running })
	if time.Since(start) > 500*time.Millisecond {
		t.Fatalf("Restart waited for backoff: %v", time.Since(start))
	}
}

func TestStartFailureKeepsRetrying(t *testing.T) {
	r := &fakeRunner{}
	r.failStart.Store(true)
	p := New(Spec{Name: "eng"}, r, opts())
	p.Start()
	waitFor(t, "3 attempts", func() bool { return r.starts.Load() >= 3 })
	r.failStart.Store(false)
	waitFor(t, "running", func() bool { return p.Status().State == Running })
	p.Stop()
}

func TestSetSpecAppliesOnNextStart(t *testing.T) {
	r := &fakeRunner{}
	p := New(Spec{Name: "a", Args: []string{"1"}}, r, opts())
	p.Start()
	defer p.Stop()
	waitFor(t, "running", func() bool { return p.Status().State == Running })
	p.SetSpec(Spec{Name: "a", Args: []string{"2"}})
	p.Restart()
	waitFor(t, "restart", func() bool { return r.starts.Load() == 2 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.specs[1].Args[0] != "2" {
		t.Fatalf("new spec not used: %v", r.specs[1])
	}
}

func TestRing(t *testing.T) {
	r := NewRing(3)
	for i := 0; i < 5; i++ {
		r.Add(fmt.Sprint(i))
	}
	l := r.Lines()
	if len(l) != 3 || !strings.HasSuffix(l[0], " 2") || !strings.HasSuffix(l[2], " 4") {
		t.Fatalf("ring: %v", l)
	}
}
