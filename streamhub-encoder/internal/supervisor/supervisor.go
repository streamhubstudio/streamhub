// Package supervisor keeps one child process alive: start, capture its log
// lines into a ring, restart it with exponential backoff when it exits, and
// stop it cleanly (SIGINT → grace → SIGKILL of the whole process group).
//
// The Runner interface is the seam for tests: a fake runner drives the state
// machine without spawning anything.
package supervisor

import (
	"bufio"
	"io"
	"os"
	"sync"
	"time"
)

// Spec is what to run.
type Spec struct {
	Name string
	Path string
	Args []string
	Env  []string // extra KEY=VALUE on top of the parent's environment
}

// Proc is a started process.
type Proc interface {
	Pid() int
	Wait() error      // blocks until exit
	Interrupt() error // polite stop (SIGINT to the process group)
	Kill() error      // SIGKILL to the process group
}

// Runner starts processes. out receives combined stdout+stderr.
type Runner interface {
	Start(s Spec, out io.Writer) (Proc, error)
}

// State of a supervised process.
type State string

// States.
const (
	Stopped  State = "stopped"
	Running  State = "running"
	Backoff  State = "backoff" // exited, waiting to restart
	Stopping State = "stopping"
)

// Options tune the restart policy.
type Options struct {
	MinBackoff  time.Duration // first restart delay (default 1 s)
	MaxBackoff  time.Duration // cap (default 30 s)
	StableAfter time.Duration // uptime after which backoff resets (default 30 s)
	StopTimeout time.Duration // SIGINT → SIGKILL grace (default 4 s)
	LogLines    int           // ring size (default 300)
	// OnExit is called (from the supervisor goroutine) after every exit.
	OnExit func(err error, uptime time.Duration)
}

func (o *Options) defaults() {
	if o.MinBackoff == 0 {
		o.MinBackoff = time.Second
	}
	if o.MaxBackoff == 0 {
		o.MaxBackoff = 30 * time.Second
	}
	if o.StableAfter == 0 {
		o.StableAfter = 30 * time.Second
	}
	if o.StopTimeout == 0 {
		o.StopTimeout = 4 * time.Second
	}
	if o.LogLines == 0 {
		o.LogLines = 300
	}
}

// Status is a snapshot.
type Status struct {
	Name       string    `json:"name"`
	State      State     `json:"state"`
	Pid        int       `json:"pid,omitempty"`
	Restarts   int       `json:"restarts"`
	StartedAt  time.Time `json:"startedAt,omitempty"`
	LastExit   string    `json:"lastExit,omitempty"`
	LastExitAt time.Time `json:"lastExitAt,omitempty"`
	NextRetry  time.Time `json:"nextRetry,omitempty"`
	Command    []string  `json:"command"`
}

// Process supervises one Spec.
type Process struct {
	runner Runner
	opts   Options
	logs   *Ring

	mu         sync.Mutex
	spec       Spec
	state      State
	proc       Proc
	restarts   int
	startedAt  time.Time
	lastExit   string
	lastExitAt time.Time
	nextRetry  time.Time
	wantRun    bool
	kick       chan struct{} // wakes the loop (restart now / stop)
	done       chan struct{} // closed when the loop exits
}

// New creates a stopped supervisor.
func New(spec Spec, r Runner, o Options) *Process {
	o.defaults()
	return &Process{runner: r, opts: o, spec: spec, state: Stopped, logs: NewRing(o.LogLines)}
}

// Logs returns the log ring.
func (p *Process) Logs() *Ring { return p.logs }

// SetSpec replaces the command used on the next (re)start.
func (p *Process) SetSpec(s Spec) {
	p.mu.Lock()
	p.spec = s
	p.mu.Unlock()
}

// Start begins supervising (no-op if already supervising).
func (p *Process) Start() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.wantRun {
		return
	}
	p.wantRun = true
	p.kick = make(chan struct{}, 1)
	p.done = make(chan struct{})
	go p.loop(p.kick, p.done)
}

// Stop stops supervising and terminates the child. It blocks until the child
// is gone (or StopTimeout+1s elapsed after SIGKILL).
func (p *Process) Stop() {
	p.mu.Lock()
	if !p.wantRun {
		p.mu.Unlock()
		return
	}
	p.wantRun = false
	done := p.done
	p.signal()
	p.mu.Unlock()
	<-done
}

// Restart kills the current child; the loop restarts it immediately
// (counted as a restart, no backoff).
func (p *Process) Restart() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.wantRun {
		return
	}
	p.nextRetry = time.Time{}
	if p.proc != nil {
		_ = p.proc.Kill()
	}
	p.signal()
}

func (p *Process) signal() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

// Status returns a snapshot.
func (p *Process) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := Status{Name: p.spec.Name, State: p.state, Restarts: p.restarts, StartedAt: p.startedAt,
		LastExit: p.lastExit, LastExitAt: p.lastExitAt, NextRetry: p.nextRetry,
		Command: append([]string{p.spec.Path}, p.spec.Args...)}
	if p.proc != nil {
		s.Pid = p.proc.Pid()
	}
	return s
}

func (p *Process) loop(kick, done chan struct{}) {
	defer close(done)
	backoff := p.opts.MinBackoff
	first := true
	for {
		p.mu.Lock()
		if !p.wantRun {
			p.state = Stopped
			p.mu.Unlock()
			return
		}
		spec := p.spec
		p.mu.Unlock()

		w := p.logs.Writer()
		proc, err := p.runner.Start(spec, w)
		start := time.Now()
		var exitErr error
		if err != nil {
			exitErr = err
			p.logs.Add("[supervisor] start failed: " + err.Error())
		} else {
			p.mu.Lock()
			p.proc, p.state, p.startedAt, p.nextRetry = proc, Running, start, time.Time{}
			if !first {
				p.restarts++
			}
			p.mu.Unlock()
			waitCh := make(chan error, 1)
			go func() { waitCh <- proc.Wait() }()
			select {
			case exitErr = <-waitCh:
			case <-kick:
				p.mu.Lock()
				stopping := !p.wantRun
				if stopping {
					p.state = Stopping
				}
				p.mu.Unlock()
				if stopping {
					exitErr = p.terminate(proc, waitCh)
				} else {
					// Restart(): already killed; wait for it.
					exitErr = <-waitCh
					backoff = 0
				}
			}
		}
		first = false
		w.Close()
		up := time.Since(start)
		msg := "exited"
		if exitErr != nil {
			msg = exitErr.Error()
		}
		p.mu.Lock()
		p.proc = nil
		p.lastExit, p.lastExitAt = msg, time.Now()
		want := p.wantRun
		p.mu.Unlock()
		if p.opts.OnExit != nil {
			p.opts.OnExit(exitErr, up)
		}
		if !want {
			p.mu.Lock()
			p.state = Stopped
			p.mu.Unlock()
			return
		}
		if up >= p.opts.StableAfter {
			backoff = p.opts.MinBackoff
		}
		delay := backoff
		p.logs.Add("[supervisor] " + spec.Name + " " + msg + "; restarting in " + delay.String())
		p.mu.Lock()
		p.state = Backoff
		p.nextRetry = time.Now().Add(delay)
		p.mu.Unlock()
		if delay > 0 {
			t := time.NewTimer(delay)
			select {
			case <-t.C:
			case <-kick:
				t.Stop()
			}
		}
		if backoff == 0 {
			backoff = p.opts.MinBackoff
		} else {
			backoff *= 2
			if backoff > p.opts.MaxBackoff {
				backoff = p.opts.MaxBackoff
			}
		}
	}
}

func (p *Process) terminate(proc Proc, waitCh chan error) error {
	_ = proc.Interrupt()
	t := time.NewTimer(p.opts.StopTimeout)
	defer t.Stop()
	select {
	case err := <-waitCh:
		return err
	case <-t.C:
		p.logs.Add("[supervisor] graceful stop timed out; SIGKILL")
		_ = proc.Kill()
	}
	select {
	case err := <-waitCh:
		return err
	case <-time.After(time.Second):
		return os.ErrDeadlineExceeded
	}
}

// Ring is a fixed-size line buffer.
type Ring struct {
	mu    sync.Mutex
	lines []string
	next  int
	full  bool
}

// NewRing creates a ring of n lines.
func NewRing(n int) *Ring { return &Ring{lines: make([]string, n)} }

// Add appends a line (timestamped).
func (r *Ring) Add(line string) {
	line = time.Now().UTC().Format("15:04:05.000 ") + line
	r.mu.Lock()
	r.lines[r.next] = line
	r.next = (r.next + 1) % len(r.lines)
	if r.next == 0 {
		r.full = true
	}
	r.mu.Unlock()
}

// Lines returns the buffered lines, oldest first.
func (r *Ring) Lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.full {
		return append([]string(nil), r.lines[:r.next]...)
	}
	return append(append([]string(nil), r.lines[r.next:]...), r.lines[:r.next]...)
}

// Writer returns an io.WriteCloser that splits writes into lines.
func (r *Ring) Writer() io.WriteCloser {
	pr, pw := io.Pipe()
	go func() {
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			r.Add(sc.Text())
		}
		_, _ = io.Copy(io.Discard, pr)
	}()
	return pw
}
