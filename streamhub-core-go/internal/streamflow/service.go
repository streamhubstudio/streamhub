// Package streamflow is modules/streamflow: the in-core, worker-less engine
// behind the `streamflow` Studio App (an n8n-style event-workflow builder).
// It taps the callbacks funnel for triggers, runs workflow DAGs of boxes
// (actions / logic / flag-gated execution boxes), keeps per-app history in
// apps/<app>/streamflow/streamflow.db and exposes 16 routes under
// /apps/:app/plugins/streamflow.
package streamflow

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

const (
	reconcileEvery       = 60 * time.Second
	rateWindow           = 60 * time.Second
	defaultMaxRunsPerMin = 60
	historyRetentionDays = 30
)

// requireApp verifies the app exists and returns its dir (404 otherwise).
func requireApp(ctx context.Context, apps AppSource, app string) (string, error) {
	rec, err := apps.Get(ctx, app)
	if err != nil || rec == nil {
		return "", httpx.NotFound(fmt.Sprintf("app '%s' not found", app))
	}
	return apps.AppDir(app), nil
}

// Service is StreamflowService.
type Service struct {
	store  *Store
	runner *Runner
	apps   AppSource
	plugin PluginState
	logs   logsink.Writer

	mu    sync.Mutex
	rate  map[string][]time.Time
	sched *scheduler
	// Now is a seam for the rate limiter.
	Now func() time.Time
}

// NewService builds the service.
func NewService(store *Store, runner *Runner, apps AppSource, plugin PluginState, logs logsink.Writer) *Service {
	return &Service{store: store, runner: runner, apps: apps, plugin: plugin, logs: logs,
		rate: map[string][]time.Time{}, sched: newScheduler(runner), Now: time.Now}
}

// Start subscribes the trigger hook, reconciles now and every 60 s, and runs
// the schedule triggers (c.starters only — never in shadow mode).
func (s *Service) Start(ctx context.Context, subscribe func(func(app, event string, payload any)) func()) {
	if subscribe != nil {
		unsub := subscribe(func(app, event string, payload any) { s.OnEvent(ctx, app, event, payload) })
		go func() { <-ctx.Done(); unsub() }()
	}
	s.sched.start(ctx)
	go func() {
		s.Reconcile(ctx)
		t := time.NewTicker(reconcileEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.Reconcile(ctx)
			}
		}
	}()
}

func (s *Service) pluginRow(ctx context.Context, app string) (bool, *y.Map) {
	if s.plugin == nil {
		return false, y.NewMap()
	}
	inst, en, cfg := s.plugin(ctx, app)
	if cfg == nil {
		cfg = y.NewMap()
	}
	return inst && en, cfg
}

// OnEvent matches a dispatched event against the app's enabled workflows
// and enqueues a run per matching trigger box. Never panics.
func (s *Service) OnEvent(ctx context.Context, app, event string, payload any) {
	defer func() { _ = recover() }()
	if strings.HasPrefix(event, "streamflow.") { // loop guard
		return
	}
	enabled, cfg := s.pluginRow(ctx, app)
	if !enabled {
		return
	}
	dir := s.apps.AppDir(app)
	p := asObject(toValue(payload))
	wfs, err := s.store.ListEnabled(ctx, app, dir)
	if err != nil {
		return
	}
	isIoT := event == "iot.data"
	for _, wf := range wfs {
		g := normalizeGraph(wf.Graph)
		var hit any
		for _, b := range g.Boxes {
			t := boxType(b)
			if (t == "trigger.event" && matchesEventTrigger(boxConfig(b), event, p)) ||
				(t == "trigger.mqtt" && isIoT && matchesMqttTrigger(boxConfig(b), p)) {
				hit = b
				break
			}
		}
		if hit == nil {
			continue
		}
		if !s.allowRun(app, cfg) {
			if s.logs != nil {
				s.logs.Write("warn", "streamflow", fmt.Sprintf("rate limit hit for app '%s'", app), map[string]any{"app": app, "event": event})
			}
			break
		}
		_, _ = s.runner.Enqueue(ctx, app, EnqueueInput{WorkflowID: wf.ID, Trigger: Trigger{Event: event, Payload: p}, TriggerBoxID: boxID(hit)})
	}
}

// numCfg is a finite non-negative number (or numeric string), else fallback.
func numCfg(v any, fallback float64) float64 {
	n := math.NaN()
	switch x := v.(type) {
	case float64:
		n = x
	case string:
		n = y.StringToNumber(x)
	}
	if finite(n) && n >= 0 {
		return n
	}
	return fallback
}

// allowRun is the per-app sliding-window rate check.
func (s *Service) allowRun(app string, cfg *y.Map) bool {
	max := numCfg(cfg.Get("max_runs_per_min"), defaultMaxRunsPerMin)
	now := s.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	var kept []time.Time
	for _, t := range s.rate[app] {
		if now.Sub(t) < rateWindow {
			kept = append(kept, t)
		}
	}
	if float64(len(kept)) >= max {
		s.rate[app] = kept
		return false
	}
	s.rate[app] = append(kept, now)
	return true
}

// ManualRun enqueues a manual run and returns its row.
func (s *Service) ManualRun(ctx context.Context, app, id string, payload *y.Map) (*Run, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	wf, err := s.store.GetWorkflow(ctx, app, dir, id)
	if err != nil {
		return nil, err
	}
	if wf == nil {
		return nil, httpx.NotFound(fmt.Sprintf("workflow '%s' not found", id))
	}
	g := normalizeGraph(wf.Graph)
	var start any
	for _, b := range g.Boxes {
		if boxType(b) == "trigger.manual" {
			start = b
			break
		}
	}
	if start == nil {
		start = findTriggerBox(g, func(t string) bool { return strings.HasPrefix(t, "trigger.") })
	}
	if payload == nil {
		payload = y.NewMap()
	}
	startID := ""
	if start != nil {
		startID = boxID(start)
	}
	runID, err := s.runner.Enqueue(ctx, app, EnqueueInput{WorkflowID: id, Trigger: Trigger{Event: "trigger.manual", Payload: payload}, TriggerBoxID: startID})
	if err != nil {
		return nil, err
	}
	return s.store.GetRun(ctx, app, dir, runID)
}

// ListWorkflows / CreateWorkflow / GetWorkflow / UpdateWorkflow /
// DeleteWorkflow / ListRuns / GetRun are the controller CRUD (app checked).

func (s *Service) ListWorkflows(ctx context.Context, app string) ([]Workflow, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	return s.store.ListWorkflows(ctx, app, dir)
}

func (s *Service) CreateWorkflow(ctx context.Context, app, name string, enabled *bool, graph any) (*Workflow, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	return s.store.CreateWorkflow(ctx, app, dir, name, enabled, graph)
}

func (s *Service) GetWorkflow(ctx context.Context, app, id string) (*Workflow, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	wf, err := s.store.GetWorkflow(ctx, app, dir, id)
	if err != nil {
		return nil, err
	}
	if wf == nil {
		return nil, httpx.NotFound(fmt.Sprintf("workflow '%s' not found", id))
	}
	return wf, nil
}

func (s *Service) UpdateWorkflow(ctx context.Context, app, id string, p WorkflowPatch) (*Workflow, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	wf, err := s.store.GetWorkflow(ctx, app, dir, id)
	if err != nil {
		return nil, err
	}
	if wf == nil {
		return nil, httpx.NotFound(fmt.Sprintf("workflow '%s' not found", id))
	}
	return s.store.UpdateWorkflow(ctx, app, dir, id, p)
}

func (s *Service) DeleteWorkflow(ctx context.Context, app, id string) (map[string]bool, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	ok, err := s.store.DeleteWorkflow(ctx, app, dir, id)
	if err != nil {
		return nil, err
	}
	return map[string]bool{"deleted": ok}, nil
}

func (s *Service) ListRuns(ctx context.Context, app, workflowID string, limit *float64) ([]Run, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	return s.store.ListRuns(ctx, app, dir, workflowID, limit)
}

// RunDetail is {run, steps}.
type RunDetail = StreamflowRunDetail

// StreamflowRunDetail is the wire type (module-prefixed schema name).
type StreamflowRunDetail struct {
	Run   *Run   `json:"run"`
	Steps []Step `json:"steps"`
}

func (s *Service) GetRun(ctx context.Context, app, id string) (*RunDetail, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	run, err := s.store.GetRun(ctx, app, dir, id)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, httpx.NotFound(fmt.Sprintf("run '%s' not found", id))
	}
	steps, err := s.store.ListSteps(ctx, app, dir, id)
	if err != nil {
		return nil, err
	}
	return &RunDetail{Run: run, Steps: steps}, nil
}

// Boxes is the palette (execution boxes only with dangerousNodes).
func (s *Service) Boxes(ctx context.Context, app string) []json.RawMessage {
	_, cfg := s.pluginCfg(ctx, app)
	return boxCatalogue(cfg.Get("dangerousNodes") == true)
}

// pluginCfg reads the install config regardless of the enabled flag.
func (s *Service) pluginCfg(ctx context.Context, app string) (bool, *y.Map) {
	if s.plugin == nil {
		return false, y.NewMap()
	}
	inst, _, cfg := s.plugin(ctx, app)
	if cfg == nil {
		cfg = y.NewMap()
	}
	return inst, cfg
}

// ExportWorkflow is the portable JSON of one workflow.
func (s *Service) ExportWorkflow(ctx context.Context, app, id string) (*y.Map, error) {
	wf, err := s.GetWorkflow(ctx, app, id)
	if err != nil {
		return nil, err
	}
	return exportWorkflow(wf.Name, wf.Graph), nil
}

// ImportWorkflow validates portable JSON and creates a workflow (400 on a
// bad graph / unknown box type).
func (s *Service) ImportWorkflow(ctx context.Context, app string, raw any, name any) (*Workflow, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	parsedName, graph, err := importWorkflow(raw, "Imported workflow")
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	final := parsedName
	if n, ok := name.(string); ok && strings.TrimSpace(n) != "" {
		final = strings.TrimSpace(n)
	}
	return s.store.CreateWorkflow(ctx, app, dir, final, nil, graph)
}

// Reconcile prunes history and registers schedule triggers for every app
// with the plugin enabled. Best-effort.
func (s *Service) Reconcile(ctx context.Context) {
	apps, err := s.apps.List(ctx, nil)
	if err != nil {
		return
	}
	want := map[string]scheduleSpec{}
	for _, a := range apps {
		func() {
			defer func() { _ = recover() }()
			if en, _ := s.pluginRow(ctx, a.Name); !en {
				return
			}
			dir := s.apps.AppDir(a.Name)
			_, _ = s.store.PruneHistory(ctx, a.Name, dir, historyRetentionDays)
			wfs, err := s.store.ListEnabled(ctx, a.Name, dir)
			if err != nil {
				return
			}
			for _, wf := range wfs {
				for _, b := range normalizeGraph(wf.Graph).Boxes {
					if boxType(b) != "trigger.schedule" {
						continue
					}
					if spec, ok := scheduleFor(a.Name, wf.ID, b); ok {
						want[spec.jobID] = spec
					}
				}
			}
		}()
	}
	s.sched.sync(want)
}

// ---------------------------------------------------------------------------
// Schedule triggers (BullMQ repeatable → in-process)
// ---------------------------------------------------------------------------

var cronParser = cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

type scheduleSpec struct {
	jobID, app, workflowID, boxID string
	key                           string // cron pattern or every:<ms>
	sched                         cron.Schedule
}

// scheduleFor resolves a trigger.schedule box: cron wins, else everySeconds.
func scheduleFor(app, workflowID string, box any) (scheduleSpec, bool) {
	cfg := boxConfig(box)
	pattern, _ := cfg.Get("cron").(string)
	pattern = strings.TrimSpace(pattern)
	spec := scheduleSpec{jobID: "sched:" + app + ":" + workflowID + ":" + boxID(box), app: app, workflowID: workflowID, boxID: boxID(box)}
	if pattern != "" {
		sc, err := cronParser.Parse(pattern)
		if err != nil {
			return spec, false // queue.add would reject it (best-effort)
		}
		spec.key, spec.sched = pattern, sc
		return spec, true
	}
	every := numCfg(cfg.Get("everySeconds"), 0)
	if every <= 0 {
		return spec, false
	}
	d := time.Duration(every * float64(time.Second))
	spec.key, spec.sched = fmt.Sprintf("every:%d", d.Milliseconds()), everySchedule(d)
	return spec, true
}

// everySchedule is BullMQ's `repeat.every` (ms precision; cron.Every would
// round to whole seconds).
type everySchedule time.Duration

func (e everySchedule) Next(t time.Time) time.Time { return t.Add(time.Duration(e)) }

type scheduler struct {
	runner *Runner
	mu     sync.Mutex
	ctx    context.Context
	jobs   map[string]*schedJob
}

type schedJob struct {
	spec   scheduleSpec
	cancel context.CancelFunc
}

func newScheduler(r *Runner) *scheduler { return &scheduler{runner: r, jobs: map[string]*schedJob{}} }

func (s *scheduler) start(ctx context.Context) {
	s.mu.Lock()
	s.ctx = ctx
	s.mu.Unlock()
}

// sync makes the running schedules match want (adds, replaces changed
// specs, and drops schedules whose workflow/box/app is gone or disabled).
func (s *scheduler) sync(want map[string]scheduleSpec) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx == nil {
		return
	}
	for id, j := range s.jobs {
		if w, ok := want[id]; !ok || w.key != j.spec.key {
			j.cancel()
			delete(s.jobs, id)
		}
	}
	for id, spec := range want {
		if _, ok := s.jobs[id]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(s.ctx)
		s.jobs[id] = &schedJob{spec: spec, cancel: cancel}
		go s.loop(ctx, spec)
	}
}

func (s *scheduler) loop(ctx context.Context, spec scheduleSpec) {
	for {
		next := spec.sched.Next(time.Now())
		t := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
			payload := obj("firedAt", jsx.NowISO())
			_, _ = s.runner.Enqueue(ctx, spec.app, EnqueueInput{WorkflowID: spec.workflowID,
				Trigger: Trigger{Event: "trigger.schedule", Payload: payload}, TriggerBoxID: spec.boxID})
		}
	}
}
