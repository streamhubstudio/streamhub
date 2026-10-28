package passthrough

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Remux statuses: live = ffmpeg running; idle = armed, between listens / a
// scheduled restart; off = stopped; error = gave up after repeated crashes.
const (
	StatusLive  = "live"
	StatusIdle  = "idle"
	StatusOff   = "off"
	StatusError = "error"
)

const (
	maxLogLines = 300
	// restartBase grows linearly per consecutive crash, capped at restartMax.
	restartBase = time.Second
	restartMax  = 15 * time.Second
	// rearmDelay is the fast re-arm after a CLEAN end-of-publish.
	rearmDelay = 250 * time.Millisecond
	// maxConsecutiveFailures before status 'error'.
	maxConsecutiveFailures = 10
)

// RemuxSpec describes one supervised ffmpeg child.
type RemuxSpec struct {
	App       string
	Room      string // namespaced room (== HLS sub-dir)
	StreamKey string
	// Port: the acceptor bind port (listen), the MediaMTX pull port (pull)
	// or the pull SOURCE port of a forward child.
	Port      int
	HlsDir    string // "" for a forward child
	Transport string
	SourceURL string
	Mode      string // listen | pull
	PullHost  string
	// Kind "forward" relays a LiveKit-plane push (FLV, no HLS) and is hidden
	// from List.
	Kind       string
	DestPort   int
	ForwardKey string
	AppID      *int64
}

// RemuxState is the public state of one remux.
type RemuxState struct {
	ID        string
	App       string
	Room      string
	Status    string
	Pid       int
	StartedAt string
	StoppedAt string
	ExitCode  *int
	Restarts  int
	Error     string
}

// LogLine is one buffered child log line.
type LogLine struct {
	Ts     string `json:"ts"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

// Proc is a running child process.
type Proc interface {
	Pid() int
	// Terminate sends SIGTERM.
	Terminate()
}

// ExitFunc reports a child exit: code nil when killed by a signal (signal
// then names it), err set on a spawn/wait failure.
type ExitFunc func(code *int, signal string, err error)

// Spawner starts bin with args, streaming stdout/stderr chunks to onOut and
// calling onExit exactly once.
type Spawner func(bin string, args []string, onOut func(stream string, b []byte), onExit ExitFunc) (Proc, error)

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

type remuxEntry struct {
	state        RemuxState
	spec         RemuxSpec
	child        Proc
	logs         []LogLine
	desired      string // live | stopped
	restartTimer *time.Timer
	failures     int
}

// RemuxManager spawns + supervises one `ffmpeg -c copy` per passthrough
// ingress (and per MediaMTX forward), with crash-restart WHILE PUBLISHING:
// a non-zero exit while desired=live re-arms with a capped backoff, an exit
// after stop is a plain teardown.
type RemuxManager struct {
	bin   string
	spawn Spawner
	logs  func() Logs
	log   *slog.Logger
	now   func() time.Time
	// afterFunc schedules restarts (time.AfterFunc; tests replace it).
	afterFunc func(time.Duration, func()) *time.Timer
	removeAll func(string) error

	mu      sync.Mutex
	entries map[string]*remuxEntry
	order   []string // insertion order (Map iteration order in Node)
}

// NewRemuxManager builds the manager; bin "" = ffmpeg, spawn nil = os/exec.
func NewRemuxManager(bin string, spawn Spawner, logs func() Logs, log *slog.Logger) *RemuxManager {
	if bin == "" {
		bin = "ffmpeg"
	}
	if spawn == nil {
		spawn = ExecSpawner
	}
	if log == nil {
		log = slog.Default()
	}
	return &RemuxManager{
		bin: bin, spawn: spawn, logs: logs, log: log, now: time.Now,
		afterFunc: time.AfterFunc, removeAll: os.RemoveAll, entries: map[string]*remuxEntry{},
	}
}

func (m *RemuxManager) iso() string {
	return m.now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// Close SIGTERMs every child and forgets all entries (OnModuleDestroy).
func (m *RemuxManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.entries {
		if e.restartTimer != nil {
			e.restartTimer.Stop()
		}
		e.desired = "stopped"
		if e.child != nil {
			e.child.Terminate()
		}
	}
	m.entries = map[string]*remuxEntry{}
	m.order = nil
}

// Start arms/starts the remux for id (idempotent while live).
func (m *RemuxManager) Start(id string, spec RemuxSpec) RemuxState {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing := m.entries[id]
	if existing != nil && (existing.state.Status == StatusLive || existing.child != nil) {
		return existing.state
	}
	e := existing
	if e == nil {
		e = &remuxEntry{desired: "stopped"}
		m.order = append(m.order, id)
	}
	restarts := 0
	if existing != nil {
		restarts = existing.state.Restarts
	}
	e.spec = spec
	e.desired = "live"
	e.failures = 0
	e.state = RemuxState{ID: id, App: spec.App, Room: spec.Room, Status: StatusIdle, Restarts: restarts, StartedAt: m.iso()}
	m.entries[id] = e
	m.launch(e)
	return e.state
}

// Stop SIGTERMs the child, clears the publishing flag (no restart) and
// removes the HLS dir. Unknown id → an 'off' state.
func (m *RemuxManager) Stop(id string) RemuxState {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil {
		return RemuxState{ID: id, Status: StatusOff}
	}
	e.desired = "stopped"
	if e.restartTimer != nil {
		e.restartTimer.Stop()
		e.restartTimer = nil
	}
	if e.child != nil {
		e.child.Terminate()
	}
	e.child = nil
	e.state.Status = StatusOff
	e.state.Pid = 0
	e.state.StoppedAt = m.iso()
	if e.spec.Kind == "forward" || e.spec.HlsDir == "" {
		m.system(e, "remux stopped")
	} else {
		if err := m.removeAll(e.spec.HlsDir); err != nil {
			m.log.Warn("could not clean " + e.spec.HlsDir + ": " + err.Error())
		}
		m.system(e, "remux stopped + HLS dir cleaned")
	}
	return e.state
}

// Status returns the state (false when never started).
func (m *RemuxManager) Status(id string) (RemuxState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.entries[id]; e != nil {
		return e.state, true
	}
	return RemuxState{}, false
}

// Armed is one passthrough remux of List.
type Armed struct {
	App, Room, IngressID, Desired string
}

// List returns the armed PASSTHROUGH remuxes (forward children excluded:
// their streams rows come from the LiveKit webhook).
func (m *RemuxManager) List() []Armed {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Armed{}
	for _, id := range m.order {
		e := m.entries[id]
		if e == nil || e.spec.Kind == "forward" {
			continue
		}
		out = append(out, Armed{e.spec.App, e.spec.Room, id, e.desired})
	}
	return out
}

// IsActive: armed (live or between listens).
func (m *RemuxManager) IsActive(id string) bool {
	st, ok := m.Status(id)
	return ok && (st.Status == StatusLive || st.Status == StatusIdle)
}

// Logs returns the newest buffered lines (newest last).
func (m *RemuxManager) Logs(id string, limit int) []LogLine {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	if e == nil {
		return []LogLine{}
	}
	if limit < 1 {
		limit = 1
	}
	from := max(0, len(e.logs)-limit)
	return append([]LogLine(nil), e.logs[from:]...)
}

// ---------------------------------------------------------------------------

// launch spawns the child for e (m.mu held).
func (m *RemuxManager) launch(e *remuxEntry) {
	spec := e.spec
	forward := spec.Kind == "forward"
	if !forward {
		if err := os.MkdirAll(spec.HlsDir, 0o777); err != nil {
			m.system(e, "could not create HLS dir: "+err.Error())
		}
	}
	var args []string
	if forward {
		key := spec.ForwardKey
		if key == "" {
			key = spec.StreamKey
		}
		dest := spec.DestPort
		if dest == 0 {
			dest = spec.Port
		}
		args = BuildForwardArgs(key, spec.Port, dest, spec.PullHost)
	} else {
		args = BuildRemuxArgs(RemuxArgs{
			App: spec.App, StreamKey: spec.StreamKey, Port: spec.Port, HlsDir: spec.HlsDir,
			Transport: spec.Transport, Mode: spec.Mode, PullHost: spec.PullHost, SourceURL: spec.SourceURL,
		})
	}
	var proc Proc
	onOut := func(stream string, b []byte) { m.append(e, stream, b) }
	onExit := func(code *int, signal string, err error) {
		m.mu.Lock()
		defer m.mu.Unlock()
		// A stale child (replaced by a later launch) no longer owns the entry.
		if e.child != nil && e.child != proc {
			return
		}
		m.onExit(e, code, signal, err)
	}
	p, err := m.spawn(m.bin, args, onOut, onExit)
	if err != nil {
		m.onExit(e, nil, "", err)
		return
	}
	proc = p
	e.child = p
	e.state.Pid = p.Pid()
	e.state.Status = StatusLive
	m.system(e, "remux started: "+m.bin+" "+strings.Join(args, " ")+" (pid "+itoa(p.Pid())+")")
}

// onExit is the crash-restart-while-publishing logic (m.mu held).
func (m *RemuxManager) onExit(e *remuxEntry, code *int, signal string, err error) {
	e.child = nil
	e.state.Pid = 0
	e.state.ExitCode = code
	e.state.StoppedAt = m.iso()

	// We asked it to stop → normal teardown, never restart.
	if e.desired == "stopped" {
		e.state.Status = StatusOff
		return
	}
	crashed := err != nil || (code != nil && *code != 0)
	if crashed {
		e.failures++
		if err != nil {
			e.state.Error = err.Error()
		} else {
			e.state.Error = ""
		}
		what := ""
		if err != nil {
			what = err.Error()
		} else {
			sig := signal
			if sig == "" {
				sig = "none"
			}
			what = "code=" + codeStr(code) + ", signal=" + sig
		}
		m.system(e, "remux crashed ("+what+") — failure #"+itoa(e.failures))
	} else {
		// A clean exit while still armed = the encoder ended its session.
		e.failures = 0
		m.system(e, "remux publish session ended (code="+codeStr(code)+") — re-arming")
	}
	if e.failures > maxConsecutiveFailures {
		e.state.Status = StatusError
		e.state.Error = "gave up after " + itoa(e.failures) + " consecutive failures"
		m.system(e, e.state.Error)
		return
	}
	delay := rearmDelay
	if crashed {
		delay = min(restartBase*time.Duration(e.failures), restartMax)
	}
	e.state.Status = StatusIdle
	var t *time.Timer
	t = m.afterFunc(delay, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if e.restartTimer != t {
			return
		}
		e.restartTimer = nil
		if e.desired != "live" {
			return
		}
		e.state.Restarts++
		m.launch(e)
	})
	e.restartTimer = t
}

func (m *RemuxManager) append(e *remuxEntry, stream string, b []byte) {
	m.mu.Lock()
	id, app, room, appID := e.state.ID, e.state.App, e.state.Room, e.spec.AppID
	var lines []string
	for _, raw := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
		line := strings.TrimRight(raw, " \t\r\n\v\f")
		if line == "" {
			continue
		}
		m.push(e, LogLine{m.iso(), stream, line})
		lines = append(lines, line)
	}
	m.mu.Unlock()
	level := "info"
	if stream == "stderr" {
		level = "warn"
	}
	for _, line := range lines {
		m.write(level, id, line, map[string]any{"app": app, "room": room, "stream": stream}, appID)
	}
}

// system records a lifecycle line (m.mu held; the logs write is async-safe).
func (m *RemuxManager) system(e *remuxEntry, line string) {
	m.push(e, LogLine{m.iso(), "system", line})
	m.write("info", e.state.ID, line, map[string]any{"app": e.state.App, "room": e.state.Room, "stream": "system"}, e.spec.AppID)
}

func (m *RemuxManager) write(level, id, line string, meta map[string]any, appID *int64) {
	if m.logs != nil {
		if l := m.logs(); l != nil {
			l.Write(level, "remux:"+id, line, meta, appID)
			return
		}
	}
	m.log.Info(line, "source", "remux:"+id, "level", level)
}

func (m *RemuxManager) push(e *remuxEntry, l LogLine) {
	e.logs = append(e.logs, l)
	if n := len(e.logs) - maxLogLines; n > 0 {
		e.logs = append([]LogLine(nil), e.logs[n:]...)
	}
}

func codeStr(c *int) string {
	if c == nil {
		return "null"
	}
	return itoa(*c)
}

// ---------------------------------------------------------------------------
// os/exec spawner
// ---------------------------------------------------------------------------

type execProc struct{ cmd *exec.Cmd }

func (p execProc) Pid() int   { return p.cmd.Process.Pid }
func (p execProc) Terminate() { _ = p.cmd.Process.Signal(syscall.SIGTERM) }

// ExecSpawner runs the child with os/exec (stdin ignored, stdout/stderr
// piped), reporting its exit like Node's 'exit'/'error' events.
func ExecSpawner(bin string, args []string, onOut func(string, []byte), onExit ExitFunc) (Proc, error) {
	cmd := exec.CommandContext(context.Background(), bin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	pump := func(name string, r io.Reader) {
		defer wg.Done()
		br := bufio.NewReader(r)
		buf := make([]byte, 32*1024)
		for {
			n, err := br.Read(buf)
			if n > 0 {
				onOut(name, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump("stdout", stdout)
	go pump("stderr", stderr)
	go func() {
		wg.Wait()
		err := cmd.Wait()
		var ee *exec.ExitError
		switch {
		case err == nil:
			c := 0
			onExit(&c, "", nil)
		case errors.As(err, &ee):
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				onExit(nil, sigName(ws.Signal()), nil)
				return
			}
			c := ee.ExitCode()
			onExit(&c, "", nil)
		default:
			onExit(nil, "", err)
		}
	}()
	return execProc{cmd}, nil
}

func sigName(s syscall.Signal) string {
	switch s {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGABRT:
		return "SIGABRT"
	}
	return s.String()
}
