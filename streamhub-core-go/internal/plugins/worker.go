package plugins

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of plugin-worker.manager.ts: the worker hook. The core owns the
// process lifecycle (os/exec), keeps a 500-line ring buffer per worker,
// mirrors lines to the logs service (source `plugin:<id>`), mints a fresh
// ingest token per start and emits plugin_worker_* lifecycle events.

// LogWriter is the logs-service surface the framework writes to.
type LogWriter interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Dispatcher is the callbacks funnel (signed webhook + MQTT tap).
type Dispatcher interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

type nopLogs struct{}

func (nopLogs) Write(string, string, string, any, *int64) {}

// WorkerState is a worker's state (JSON as Node serializes it).
type WorkerState struct {
	App       string          `json:"app"`
	PluginID  string          `json:"pluginId"`
	Status    string          `json:"status"` // running | stopped | crashed | starting
	PID       *int            `json:"pid,omitempty"`
	StartedAt string          `json:"startedAt,omitempty"`
	StoppedAt string          `json:"stoppedAt,omitempty"`
	ExitCode  json.RawMessage `json:"exitCode,omitempty"` // number or null once exited
	Error     string          `json:"error,omitempty"`
	Placement string          `json:"placement,omitempty"`
	Node      *NodeInfo       `json:"node,omitempty"`
	RemoteID  string          `json:"remoteId,omitempty"`
}

// LogLine is one buffered worker log line.
type LogLine struct {
	TS     string `json:"ts"`
	Stream string `json:"stream"` // stdout | stderr | system
	Line   string `json:"line"`
}

const maxLogLines = 500

type workerEntry struct {
	state         WorkerState
	cmd           *exec.Cmd
	logs          []LogLine
	errorNotified bool
	ingestToken   string
	lease         *lease
}

type lease struct {
	node     NodeInfo
	remoteID string
}

// Pinner resolves an install's pinned worker version (appstore seam).
type Pinner interface {
	PinnedWorkerDir(ctx context.Context, app string, meta *Meta) (version, dir string, err error)
}

// ManagerConfig are the manager's environment-derived settings.
type ManagerConfig struct {
	DataDir       string
	LivekitURL    string
	Port          int
	PublicBaseURL string
	Env           func(string) string
	// Environ is the parent environment (os.Environ by default).
	Environ func() []string
}

// Manager is PluginWorkerManager.
type Manager struct {
	cfg      ManagerConfig
	logs     LogWriter
	callback Dispatcher
	grid     *Grid
	pinner   Pinner

	mu      sync.Mutex
	workers map[string]*workerEntry
	now     func() time.Time
}

// NewManager builds the manager. logs may be nil (no mirroring).
func NewManager(cfg ManagerConfig, logs LogWriter) *Manager {
	if logs == nil {
		logs = nopLogs{}
	}
	if cfg.Env == nil {
		cfg.Env = os.Getenv
	}
	if cfg.Environ == nil {
		cfg.Environ = os.Environ
	}
	return &Manager{cfg: cfg, logs: logs, workers: map[string]*workerEntry{}, now: time.Now}
}

// SetCallbacks / SetGrid / SetPinner bind the optional seams.
func (m *Manager) SetCallbacks(d Dispatcher) { m.callback = d }
func (m *Manager) SetGrid(g *Grid)           { m.grid = g }
func (m *Manager) SetPinner(p Pinner)        { m.pinner = p }

func (m *Manager) notify(app, event string, payload any) {
	if m.callback != nil {
		go func() { _ = m.callback.Dispatch(context.Background(), app, event, payload) }()
	}
}

func workerKey(app, pluginID string) string { return app + "::" + pluginID }

func (m *Manager) isoNow() string { return jsx.ISO(m.now()) }

// Shutdown kills every worker (onModuleDestroy).
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.workers {
		if e.lease != nil && m.grid != nil {
			l := *e.lease
			go m.grid.StopRemote(context.Background(), l.node, l.remoteID)
		}
		if e.cmd != nil && e.cmd.Process != nil {
			_ = e.cmd.Process.Signal(syscall.SIGTERM)
		}
	}
	m.workers = map[string]*workerEntry{}
}

// Status is the worker state (a synthetic 'stopped' when never started).
func (m *Manager) Status(app, pluginID string) WorkerState {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.workers[workerKey(app, pluginID)]; ok {
		return e.state
	}
	return WorkerState{App: app, PluginID: pluginID, Status: "stopped"}
}

func running(s string) bool { return s == "running" || s == "starting" }

// IsRunning reports running or starting.
func (m *Manager) IsRunning(app, pluginID string) bool {
	return running(m.Status(app, pluginID).Status)
}

// Logs returns the newest buffered lines.
func (m *Manager) Logs(app, pluginID string, limit int) []LogLine {
	return m.LogsByKey(workerKey(app, pluginID), limit)
}

// IngestToken is the running worker's ingest token ("" when stopped).
func (m *Manager) IngestToken(app, pluginID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.workers[workerKey(app, pluginID)]
	if !ok || !running(e.state.Status) {
		return ""
	}
	return e.ingestToken
}

// uuid is crypto.randomUUID.
func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Start starts an installed plugin's worker (idempotent while running).
func (m *Manager) Start(ctx context.Context, meta *Meta, app, appDir string, config *y.Map, appID *int64, appTimezone string) (WorkerState, error) {
	if !meta.NeedsWorker || meta.Worker == nil || meta.Worker.Spawn == nil {
		return WorkerState{}, fmt.Errorf("plugin '%s' has no worker", meta.ID)
	}
	key := workerKey(app, meta.ID)
	m.mu.Lock()
	e, ok := m.workers[key]
	if ok && running(e.state.Status) {
		st := e.state
		m.mu.Unlock()
		return st, nil
	}
	if !ok {
		e = &workerEntry{}
	}
	e.errorNotified = false
	e.lease = nil
	e.ingestToken = uuid()
	e.state = WorkerState{App: app, PluginID: meta.ID, Status: "starting", StartedAt: m.isoNow(), Placement: "local"}
	m.workers[key] = e
	m.mu.Unlock()

	if meta.Worker.Placement == "grid" {
		if m.grid != nil {
			if pick := m.grid.SelectNode(ctx, meta.Worker.Grid); pick != nil {
				m.dispatchRemote(e, meta, app, appDir, config, appID, pick.NodeInfo, appTimezone)
				return m.snapshot(e), nil
			}
		}
		m.system(e, meta.ID, app, appID, "grid placement requested but no eligible grid node registered — falling back to local spawn")
	}
	m.spawnLocal(ctx, e, meta, app, appDir, config, appID, appTimezone)
	return m.snapshot(e), nil
}

func (m *Manager) snapshot(e *workerEntry) WorkerState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return e.state
}

// FrameworkEnv is the env every local worker gets before its own spec env.
func FrameworkEnv(port int, app, pluginID, token string) []EnvVar {
	base := fmt.Sprintf("http://127.0.0.1:%d/api/v1/apps/%s/plugins/%s", port, jsx.EncodeURIComponent(app), jsx.EncodeURIComponent(pluginID))
	return []EnvVar{
		{"STREAMHUB_APP", app},
		{"STREAMHUB_PLUGIN_ID", pluginID},
		{"STREAMHUB_INGEST_URL", base + "/live"},
		{"STREAMHUB_EVENTS_URL", base + "/events"},
		{"STREAMHUB_INGEST_TOKEN", token},
	}
}

func (m *Manager) spawnLocal(ctx context.Context, e *workerEntry, meta *Meta, app, appDir string, config *y.Map, appID *int64, appTimezone string) {
	wctx := WorkerContext{App: app, Config: config, AppDir: appDir, DataDir: m.cfg.DataDir, LivekitURL: m.cfg.LivekitURL, AppTimezone: appTimezone}
	spec := m.applyPin(ctx, meta.Worker.Spawn(wctx), meta, app, e, appID)
	m.mu.Lock()
	e.state.Placement, e.state.Node, e.state.RemoteID = "local", nil, ""
	token := e.ingestToken
	m.mu.Unlock()
	env := mergeEnv(m.parentEnv(), FrameworkEnv(m.cfg.Port, app, meta.ID, token), spec.Env)
	cwd := spec.Cwd
	if cwd == "" {
		cwd = appDir
	}
	m.launch(e, app, meta.ID, appID, spec, env, cwd)
}

// applyPin rewrites a local spec to run from a pinned bundle (or keeps it).
func (m *Manager) applyPin(ctx context.Context, spec WorkerSpec, meta *Meta, app string, e *workerEntry, appID *int64) WorkerSpec {
	if m.pinner == nil || meta.ExportDir == nil || *meta.ExportDir == "" {
		return spec
	}
	version, toDir, err := m.pinner.PinnedWorkerDir(ctx, app, meta)
	if version == "" {
		return spec
	}
	if err != nil {
		m.system(e, meta.ID, app, appID, fmt.Sprintf("pinned version '%s' unusable (%s) — falling back to the built-in", version, err))
		return spec
	}
	fromDir := spec.Cwd
	if fromDir == "" {
		fromDir = m.pinnerWorkerDir(meta)
	}
	pinned := spec
	if fromDir != "" {
		pinned = RedirectWorkerDir(spec, fromDir, toDir)
	} else {
		pinned.Cwd = toDir
	}
	m.system(e, meta.ID, app, appID, fmt.Sprintf("running pinned version '%s' (%s)", version, toDir))
	return pinned
}

func (m *Manager) pinnerWorkerDir(meta *Meta) string {
	if r, ok := m.pinner.(interface{ WorkerSourceDir(*Meta) string }); ok {
		return r.WorkerSourceDir(meta)
	}
	return ""
}

// mergeEnv is `{ ...process.env, ...framework, ...spec.env }`.
// workerEnvAllow is what a worker inherits from the core's environment: the
// OS/runtime plumbing an interpreter, CUDA or an HTTP client needs, never the
// core's own configuration (JWT_SECRET, SMTP_PASS, LIVEKIT_API_SECRET,
// STREAMHUB_API_TOKEN, S3 keys…). Everything a worker needs from the core
// arrives explicitly through its spawn spec. Node spread all of process.env.
var workerEnvAllow = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true,
	"LANG": true, "LANGUAGE": true, "TZ": true, "TMPDIR": true, "TEMP": true, "TMP": true,
	"SSL_CERT_FILE": true, "SSL_CERT_DIR": true, "REQUESTS_CA_BUNDLE": true, "CURL_CA_BUNDLE": true,
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true,
	"http_proxy": true, "https_proxy": true, "no_proxy": true,
	"LD_LIBRARY_PATH": true, "VIRTUAL_ENV": true,
	"CUDA_HOME": true, "CUDA_VISIBLE_DEVICES": true,
	"NVIDIA_VISIBLE_DEVICES": true, "NVIDIA_DRIVER_CAPABILITIES": true,
	"OMP_NUM_THREADS": true, "MKL_NUM_THREADS": true, "OPENBLAS_NUM_THREADS": true,
	"HF_HOME": true, "HF_HUB_OFFLINE": true, "TORCH_HOME": true, "YOLO_CONFIG_DIR": true,
	"XDG_CACHE_HOME": true, "XDG_CONFIG_HOME": true, "XDG_DATA_HOME": true,
	// vision runtime: operator-set AI endpoint (the key comes from the app config)
	"VISION_AI_BASE_URL": true,
	// stream-health worker: operator overrides of the media binaries
	"HEALTH_FFPROBE": true, "HEALTH_FFMPEG": true,
}

// WorkerEnvAllowEnv names extra parent variables (comma-separated) an
// operator lets workers inherit.
const WorkerEnvAllowEnv = "STREAMHUB_WORKER_ENV_ALLOW"

// workerParentEnv filters the core's environment down to workerEnvAllow,
// LC_* locale variables and the operator's extra names.
func workerParentEnv(environ []string, extra string) []string {
	more := map[string]bool{}
	for _, k := range strings.Split(extra, ",") {
		if k = strings.TrimSpace(k); k != "" {
			more[k] = true
		}
	}
	out := make([]string, 0, 32)
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if ok && (workerEnvAllow[k] || more[k] || strings.HasPrefix(k, "LC_")) {
			out = append(out, kv)
		}
	}
	return out
}

func (m *Manager) parentEnv() []string {
	return workerParentEnv(m.cfg.Environ(), m.cfg.Env(WorkerEnvAllowEnv))
}

func mergeEnv(parent []string, layers ...[]EnvVar) []string {
	idx := map[string]int{}
	out := make([]string, 0, len(parent)+16)
	set := func(k, v string) {
		if i, ok := idx[k]; ok {
			out[i] = k + "=" + v
			return
		}
		idx[k] = len(out)
		out = append(out, k+"="+v)
	}
	for _, kv := range parent {
		if k, v, ok := strings.Cut(kv, "="); ok {
			set(k, v)
		}
	}
	for _, layer := range layers {
		for _, e := range layer {
			set(e.Key, e.Value)
		}
	}
	return out
}

func (m *Manager) dispatchRemote(e *workerEntry, meta *Meta, app, appDir string, config *y.Map, appID *int64, node NodeInfo, appTimezone string) {
	origin := m.cfg.PublicBaseURL
	wctx := WorkerContext{App: app, Config: config, AppDir: appDir, DataDir: m.cfg.DataDir, LivekitURL: m.cfg.LivekitURL, Node: &node, OriginURL: origin, AppTimezone: appTimezone}
	spec := meta.Worker.Spawn(wctx)
	m.mu.Lock()
	token := e.ingestToken
	m.mu.Unlock()
	env := []EnvVar{{"STREAMHUB_APP", app}, {"STREAMHUB_PLUGIN_ID", meta.ID}}
	if origin != "" {
		base := strings.TrimRight(origin, "/") + "/api/v1/apps/" + jsx.EncodeURIComponent(app) + "/plugins/" + jsx.EncodeURIComponent(meta.ID)
		env = append(env, EnvVar{"STREAMHUB_INGEST_URL", base + "/live"}, EnvVar{"STREAMHUB_EVENTS_URL", base + "/events"}, EnvVar{"STREAMHUB_INGEST_TOKEN", token})
	} else {
		m.system(e, meta.ID, app, appID, "grid placement: PUBLIC_BASE_URL is unset — a remote worker cannot reach the origin ingest channel (live result feed-back disabled)")
	}
	req := GridSpawnRequest{PluginID: meta.ID, AppName: app, Command: spec.Command, Args: orEmpty(spec.Args), Env: envObject(append(env, spec.Env...)), IngestToken: token}
	m.system(e, meta.ID, app, appID, fmt.Sprintf("grid placement: dispatching worker to node '%s'…", node.Name))
	key := workerKey(app, meta.ID)
	go func() {
		res := m.grid.Dispatch(context.Background(), node, req)
		m.mu.Lock()
		current := m.workers[key] == e
		m.mu.Unlock()
		if !current {
			return
		}
		if res.Dispatched && res.RemoteID != "" {
			m.mu.Lock()
			e.lease = &lease{node: node, remoteID: res.RemoteID}
			n := node
			e.state.Status, e.state.Placement, e.state.Node, e.state.RemoteID = "running", "grid", &n, res.RemoteID
			m.mu.Unlock()
			m.system(e, meta.ID, app, appID, fmt.Sprintf("grid dispatch OK → node '%s' worker '%s'", node.Name, res.RemoteID))
			m.notify(app, "plugin_worker_started", gridStarted{meta.ID, node.ID, res.RemoteID})
			return
		}
		reason := res.Reason
		if reason == "" {
			reason = "unknown"
		}
		m.system(e, meta.ID, app, appID, fmt.Sprintf("grid dispatch to '%s' failed (%s) — falling back to local spawn", node.Name, reason))
		m.spawnLocal(context.Background(), e, meta, app, appDir, config, appID, appTimezone)
	}()
}

type gridStarted struct {
	Plugin   string `json:"plugin"`
	Node     string `json:"node"`
	RemoteID string `json:"remoteId"`
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// envObject renders ordered env pairs as a JSON object (later keys win).
func envObject(env []EnvVar) *y.Map {
	m := y.NewMap()
	for _, e := range env {
		m.Set(e.Key, e.Value)
	}
	return m
}

// StartSpec runs a resolved spec under an opaque key (grid agent).
func (m *Manager) StartSpec(key, app, pluginID string, spec WorkerSpec) WorkerState {
	m.mu.Lock()
	e, ok := m.workers[key]
	if ok && running(e.state.Status) {
		st := e.state
		m.mu.Unlock()
		return st
	}
	if !ok {
		e = &workerEntry{}
	}
	e.errorNotified = false
	e.state = WorkerState{App: app, PluginID: pluginID, Status: "starting", StartedAt: m.isoNow(), Placement: "grid"}
	m.workers[key] = e
	m.mu.Unlock()
	m.launch(e, app, pluginID, nil, spec, mergeEnv(m.parentEnv(), spec.Env), spec.Cwd)
	return m.snapshot(e)
}

// StatusByKey is the state by opaque key.
func (m *Manager) StatusByKey(key string) (WorkerState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.workers[key]
	if !ok {
		return WorkerState{}, false
	}
	return e.state, true
}

// StopByKey stops by opaque key.
func (m *Manager) StopByKey(key string) WorkerState {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.workers[key]
	if !ok {
		return WorkerState{Status: "stopped"}
	}
	if e.cmd != nil && e.cmd.Process != nil {
		_ = e.cmd.Process.Signal(syscall.SIGTERM)
		e.state.Status, e.state.StoppedAt = "stopped", m.isoNow()
	}
	return e.state
}

// LogsByKey returns the newest buffered lines by key.
func (m *Manager) LogsByKey(key string, limit int) []LogLine {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.workers[key]
	if !ok {
		return []LogLine{}
	}
	n := max(1, limit)
	if n > len(e.logs) {
		n = len(e.logs)
	}
	return append([]LogLine{}, e.logs[len(e.logs)-n:]...)
}

type workerMeta struct {
	App    string `json:"app"`
	Stream string `json:"stream"`
}

type startedPayload struct {
	Plugin string `json:"plugin"`
	PID    *int   `json:"pid"`
}

type errorPayload struct {
	Plugin string `json:"plugin"`
	Error  string `json:"error"`
}

type exitPayload struct {
	Plugin   string  `json:"plugin"`
	ExitCode *int    `json:"exitCode"`
	Signal   *string `json:"signal"`
}

// spawnErrorMessage renders a start failure the way Node's spawn error reads
// (`spawn <cmd> ENOENT`).
func spawnErrorMessage(command string, err error) string {
	var errno syscall.Errno
	var pathErr *fs.PathError
	switch {
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		return "spawn " + command + " ENOENT"
	case errors.As(err, &pathErr) && errors.As(pathErr.Err, &errno), errors.As(err, &errno):
		if name := errnoName(errno); name != "" {
			return "spawn " + command + " " + name
		}
	}
	return err.Error()
}

func errnoName(e syscall.Errno) string {
	switch e {
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.ENOENT:
		return "ENOENT"
	}
	return ""
}

// launch spawns + supervises a resolved spec (shared by every path).
func (m *Manager) launch(e *workerEntry, app, pluginID string, appID *int64, spec WorkerSpec, env []string, cwd string) {
	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Env, cmd.Dir = env, cwd
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	argLine := strings.Join(spec.Args, " ")
	if err := cmd.Start(); err != nil {
		// Node reports `running` then emits 'error' on the next tick.
		msg := spawnErrorMessage(spec.Command, err)
		m.system(e, pluginID, app, appID, fmt.Sprintf("worker started: %s %s (pid undefined)", spec.Command, argLine))
		m.notify(app, "plugin_worker_started", startedPayload{pluginID, nil})
		m.mu.Lock()
		e.state.Status, e.state.Error, e.state.StoppedAt = "crashed", msg, m.isoNow()
		notifyErr := !e.errorNotified
		e.errorNotified = true
		m.mu.Unlock()
		m.system(e, pluginID, app, appID, "worker error: "+msg)
		if notifyErr {
			m.notify(app, "plugin_worker_error", errorPayload{pluginID, msg})
		}
		return
	}
	pid := cmd.Process.Pid
	m.mu.Lock()
	e.cmd = cmd
	e.state.PID, e.state.Status = &pid, "running"
	m.mu.Unlock()

	var wg sync.WaitGroup
	for stream, r := range map[string]io.Reader{"stdout": stdout, "stderr": stderr} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.pump(e, pluginID, app, appID, stream, r)
		}()
	}
	m.system(e, pluginID, app, appID, fmt.Sprintf("worker started: %s %s (pid %d)", spec.Command, argLine, pid))
	m.notify(app, "plugin_worker_started", startedPayload{pluginID, &pid})

	go func() {
		wg.Wait()
		_ = cmd.Wait()
		code, signal := exitInfo(cmd.ProcessState)
		m.mu.Lock()
		if e.cmd == cmd {
			e.cmd = nil
		}
		if code != nil {
			e.state.ExitCode = json.RawMessage(strconv.Itoa(*code))
		} else {
			e.state.ExitCode = json.RawMessage("null")
		}
		e.state.StoppedAt = m.isoNow()
		crashed := code != nil && *code != 0 && signal == nil
		if crashed {
			e.state.Status = "crashed"
		} else {
			e.state.Status = "stopped"
		}
		notifyErr := crashed && !e.errorNotified
		if notifyErr {
			e.errorNotified = true
		}
		m.mu.Unlock()
		codeStr, sigStr := "null", "none"
		if code != nil {
			codeStr = strconv.Itoa(*code)
		}
		if signal != nil {
			sigStr = *signal
		}
		m.system(e, pluginID, app, appID, fmt.Sprintf("worker exited (code=%s, signal=%s)", codeStr, sigStr))
		switch {
		case notifyErr:
			m.notify(app, "plugin_worker_error", exitPayload{pluginID, code, signal})
		case !crashed:
			m.notify(app, "plugin_worker_stopped", exitPayload{pluginID, code, signal})
		}
	}()
}

// exitInfo is Node's (code, signal) pair for an exited process.
func exitInfo(ps *os.ProcessState) (*int, *string) {
	if ps == nil {
		return nil, nil
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		name := signalName(ws.Signal())
		return nil, &name
	}
	code := ps.ExitCode()
	return &code, nil
}

func signalName(s syscall.Signal) string {
	switch s {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGSEGV:
		return "SIGSEGV"
	case syscall.SIGABRT:
		return "SIGABRT"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGPIPE:
		return "SIGPIPE"
	}
	return "SIG" + strings.ToUpper(s.String())
}

func (m *Manager) pump(e *workerEntry, pluginID, app string, appID *int64, stream string, r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	level := "info"
	if stream == "stderr" {
		level = "warn"
	}
	for sc.Scan() {
		line := strings.TrimRight(strings.TrimSuffix(sc.Text(), "\r"), " \t\r\n\v\f")
		if line == "" {
			continue
		}
		m.push(e, LogLine{TS: m.isoNow(), Stream: stream, Line: line})
		m.logs.Write(level, "plugin:"+pluginID, line, workerMeta{app, stream}, appID)
	}
}

// Stop SIGTERMs a running worker (proxies a remote lease). No-op if idle.
func (m *Manager) Stop(app, pluginID string) WorkerState {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.workers[workerKey(app, pluginID)]
	if !ok {
		return WorkerState{App: app, PluginID: pluginID, Status: "stopped"}
	}
	if e.lease != nil && m.grid != nil {
		l := *e.lease
		go m.grid.StopRemote(context.Background(), l.node, l.remoteID)
		e.lease = nil
		e.state.Status, e.state.StoppedAt = "stopped", m.isoNow()
		return e.state
	}
	if e.cmd != nil && e.cmd.Process != nil {
		_ = e.cmd.Process.Signal(syscall.SIGTERM)
		e.state.Status, e.state.StoppedAt = "stopped", m.isoNow()
	}
	return e.state
}

func (m *Manager) system(e *workerEntry, pluginID, app string, appID *int64, line string) {
	m.push(e, LogLine{TS: m.isoNow(), Stream: "system", Line: line})
	m.logs.Write("info", "plugin:"+pluginID, line, workerMeta{app, "system"}, appID)
}

func (m *Manager) push(e *workerEntry, l LogLine) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e.logs = append(e.logs, l)
	if len(e.logs) > maxLogLines {
		e.logs = append([]LogLine{}, e.logs[len(e.logs)-maxLogLines:]...)
	}
}
