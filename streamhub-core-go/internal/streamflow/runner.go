package streamflow

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/logsink"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// Port of streamflow.runner.ts. The BullMQ queue `streamhub-streamflow`
// (concurrency 4) becomes an in-process bounded queue drained by 4 workers
// started from c.starters; enqueue records the run (queued) and hands the job
// over. One run walks the graph from its trigger box, records every step and
// dispatches streamflow.run_* through the callbacks funnel.

const (
	runTimeout   = 60 * time.Second
	httpTimeout  = 10 * time.Second
	maxSteps     = 100
	workers      = 4
	queueBacklog = 1000
)

// ---------------------------------------------------------------------------
// Collaborator seams (resolved with maybe[...] in the plane; nil = absent)
// ---------------------------------------------------------------------------

// AppSource is the apps surface streamflow reads.
type AppSource interface {
	Get(ctx context.Context, name string) (*contracts.AppRecord, error)
	List(ctx context.Context, p *auth.Principal) ([]contracts.AppRecord, error)
	GetConfig(ctx context.Context, name string) (*contracts.AppConfig, error)
	AppDir(name string) string
}

// PluginState reads the app's `streamflow` install: (installed, enabled, config).
type PluginState func(ctx context.Context, app string) (installed, enabled bool, config *y.Map)

// Dispatcher is the callbacks funnel.
type Dispatcher interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Snapshotter is StreamsService.snapshot.
type Snapshotter func(ctx context.Context, app, room string, participant *string) (key, url string, err error)

// MQTTPublisher is MqttService.publishRaw.
type MQTTPublisher func(ctx context.Context, app, topic string, payload any, qos int, retain bool)

// Notifier is NotifierService.notify.
type Notifier func(ctx context.Context, app, event string, payload *y.Map, title string, channels []string)

// S3 is the S3Service slice action.s3 uses.
type S3 interface {
	UploadBuffer(ctx context.Context, cfg contracts.S3Config, body []byte, key, contentType string) (*contracts.S3UploadResult, error)
	PresignGet(ctx context.Context, cfg contracts.S3Config, key string, expiresInSeconds float64, opts *contracts.S3PresignOptions) (string, error)
}

// RunnerDeps wire the runner.
type RunnerDeps struct {
	Store         *Store
	Apps          AppSource
	Plugin        PluginState
	Callbacks     Dispatcher // optional
	Snapshot      Snapshotter
	MQTT          MQTTPublisher
	Notify        Notifier
	S3            S3
	AI            *AIClient
	Secrets       *Secrets
	Logs          logsink.Writer
	PublicBaseURL string
	// Dangerous seams (defaults: RunCode/RunShell/RunSSH/RunDB).
	RunCode  func(ctx context.Context, in CodeInput) *y.Map
	RunShell func(ctx context.Context, in ShellInput) *y.Map
	RunSSH   func(ctx context.Context, in SSHInput) *y.Map
	RunDB    func(ctx context.Context, in DBInput) *y.Map
}

type job struct {
	app, workflowID, runID, triggerBoxID string
	trigger                              Trigger
}

// Runner is StreamflowRunner.
type Runner struct {
	d RunnerDeps
	// HTTP posts action.http / action.plugin (tests inject a fake transport).
	HTTP *http.Client
	// Resolve is the SSRF guard's DNS seam.
	Resolve security.HostResolver

	queue   chan job
	mu      sync.Mutex
	started bool
}

// NewRunner builds the runner (no workers until Start).
func NewRunner(d RunnerDeps) *Runner {
	if d.RunCode == nil {
		d.RunCode = RunCode
	}
	if d.RunShell == nil {
		d.RunShell = RunShell
	}
	if d.RunSSH == nil {
		d.RunSSH = RunSSH
	}
	if d.RunDB == nil {
		d.RunDB = RunDB
	}
	return &Runner{d: d, HTTP: &http.Client{}, Resolve: security.DefaultHostResolver, queue: make(chan job, queueBacklog)}
}

// Start launches the workers (c.starters; skipped in shadow mode).
func (r *Runner) Start(ctx context.Context) {
	r.mu.Lock()
	r.started = true
	r.mu.Unlock()
	for i := 0; i < workers; i++ {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case j := <-r.queue:
					r.Execute(context.WithoutCancel(ctx), j)
				}
			}
		}()
	}
}

// EnqueueInput is a run request.
type EnqueueInput struct {
	WorkflowID   string
	Trigger      Trigger
	TriggerBoxID string
}

// Enqueue records the run (queued) and queues it; returns the run id.
func (r *Runner) Enqueue(ctx context.Context, app string, in EnqueueInput) (string, error) {
	dir := r.d.Apps.AppDir(app)
	run, err := r.d.Store.CreateRun(ctx, app, dir, in.WorkflowID, in.Trigger.Event, "queued")
	if err != nil {
		return "", err
	}
	j := job{app: app, workflowID: in.WorkflowID, runID: run.ID, trigger: in.Trigger, triggerBoxID: in.TriggerBoxID}
	select {
	case r.queue <- j:
	default:
		msg := "enqueue failed: queue full"
		_ = r.d.Store.FinishRun(ctx, app, dir, run.ID, "failed", &msg)
	}
	return run.ID, nil
}

// Execute runs one job to completion; failures are recorded, never returned.
func (r *Runner) Execute(ctx context.Context, j job) {
	dir := r.d.Apps.AppDir(j.app)
	fail := func(msg string) { _ = r.d.Store.FinishRun(ctx, j.app, dir, j.runID, "failed", &msg) }
	wf, err := r.d.Store.GetWorkflow(ctx, j.app, dir, j.workflowID)
	if err != nil || wf == nil {
		fail("workflow not found")
		return
	}
	g := normalizeGraph(wf.Graph)
	var start any
	if j.triggerBoxID != "" {
		for _, b := range g.Boxes {
			if boxID(b) == j.triggerBoxID {
				start = b
				break
			}
		}
	}
	if start == nil {
		start = findTriggerBox(g, func(t string) bool { return strings.HasPrefix(t, "trigger.") })
	}
	if start == nil {
		fail("no trigger box in workflow")
		return
	}
	_ = r.d.Store.SetRunStatus(ctx, j.app, dir, j.runID, "running")
	r.lifecycle(ctx, j.app, "streamflow.run_started", obj("run", j.runID, "workflow", j.workflowID, "event", j.trigger.Event))

	bc := &BoxContext{
		App: j.app, AppDir: dir, DangerousEnabled: r.dangerousEnabled(ctx, j.app),
		Trigger: j.trigger, Bag: newBag(j.trigger.Event, j.trigger.Payload),
	}
	deps := r.buildDeps(j.app)
	seq := 0
	exec := func(ctx context.Context, box any) (any, string, error) {
		id, typ := boxID(box), y.ToString(field(box, "type"))
		started := time.Now()
		elapsed := func() *float64 { v := float64(time.Since(started).Milliseconds()); return &v }
		executor := executors[typ]
		if _, isStr := field(box, "type").(string); !isStr {
			executor = nil
		}
		if executor == nil {
			zero := 0.0
			_ = r.d.Store.RecordStep(ctx, j.app, dir, StepRecord{RunID: j.runID, BoxID: id, BoxType: typ, Status: "skipped",
				Input: field(box, "config"), Output: y.Undefined, Ms: &zero, Seq: seq})
			seq++
			return nil, "out", nil
		}
		original := boxConfig(box)
		cfg, used := original, []string(nil)
		if r.d.Secrets != nil {
			cfg, used = r.d.Secrets.expandConfig(ctx, j.app, dir, original)
		}
		scrub := func(v any) any { return redactSecretValues(v, used) }
		out, port, err := executor(ctx, BoxNode{ID: id, Type: typ, Config: cfg}, bc, deps)
		if err != nil {
			msg := y.ToString(scrub(err.Error()))
			_ = r.d.Store.RecordStep(ctx, j.app, dir, StepRecord{RunID: j.runID, BoxID: id, BoxType: typ, Status: "failed",
				Input: original, Output: y.Undefined, Ms: elapsed(), Error: &msg, Seq: seq})
			seq++
			return nil, "", err
		}
		bc.Bag.Set(id, out)
		_ = r.d.Store.RecordStep(ctx, j.app, dir, StepRecord{RunID: j.runID, BoxID: id, BoxType: typ, Status: "ok",
			Input: original, Output: scrub(out), Ms: elapsed(), Seq: seq})
		seq++
		return out, port, nil
	}

	rctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	err = runGraph(rctx, g, boxID(start), exec, maxSteps)
	if err == nil {
		_ = r.d.Store.FinishRun(ctx, j.app, dir, j.runID, "ok", nil)
		r.lifecycle(ctx, j.app, "streamflow.run_finished", obj("run", j.runID, "workflow", j.workflowID, "steps", float64(seq)))
		return
	}
	msg := err.Error()
	if errors.Is(rctx.Err(), context.DeadlineExceeded) {
		msg = fmt.Sprintf("run timed out after %dms", runTimeout.Milliseconds())
	}
	fail(msg)
	r.lifecycle(ctx, j.app, "streamflow.run_failed", obj("run", j.runID, "workflow", j.workflowID, "error", msg))
	r.log("warn", fmt.Sprintf("run '%s' failed: %s", j.runID, msg), map[string]any{"app": j.app})
}

func (r *Runner) pluginConfig(ctx context.Context, app string) (bool, bool, *y.Map) {
	if r.d.Plugin == nil {
		return false, false, y.NewMap()
	}
	inst, en, cfg := r.d.Plugin(ctx, app)
	if cfg == nil {
		cfg = y.NewMap()
	}
	return inst, en, cfg
}

func (r *Runner) dangerousEnabled(ctx context.Context, app string) bool {
	_, _, cfg := r.pluginConfig(ctx, app)
	return cfg.Get("dangerousNodes") == true
}

// lifecycle dispatches a streamflow.run_* event, fire-and-forget.
func (r *Runner) lifecycle(ctx context.Context, app, event string, payload *y.Map) {
	if r.d.Callbacks == nil {
		return
	}
	cb := r.d.Callbacks
	go func() {
		defer func() { _ = recover() }()
		_ = cb.Dispatch(ctx, app, event, payload)
	}()
}

func (r *Runner) log(level, msg string, meta map[string]any) {
	if r.d.Logs != nil {
		r.d.Logs.Write(level, "streamflow", msg, meta)
	}
}

// aiSettings resolves the per-app AI config from the plugin config.
func (r *Runner) aiSettings(ctx context.Context, app string) (provider, model, key string, budget float64) {
	_, _, c := r.pluginConfig(ctx, app)
	provider = "openai"
	if c.Get("ai_provider") == "deepseek" {
		provider = "deepseek"
	}
	model = "gpt-4o-mini"
	if m, ok := c.Get("ai_model").(string); ok && strings.TrimSpace(m) != "" {
		model = strings.TrimSpace(m)
	}
	key, _ = c.Get("ai_api_key").(string)
	if b, ok := c.Get("ai_budget_monthly_usd").(float64); ok && b > 0 {
		budget = b
	}
	return
}

// buildDeps adapts the core services into the executor seam.
func (r *Runner) buildDeps(app string) *Deps {
	return &Deps{
		Snapshot: func(ctx context.Context, a, room string, participant *string) (string, string, error) {
			if r.d.Snapshot == nil {
				return "", "", errors.New("streams service not available")
			}
			return r.d.Snapshot(ctx, a, room, participant)
		},
		S3Upload: func(ctx context.Context, a, key string, body []byte, contentType string) (string, string, error) {
			if r.d.S3 == nil {
				return "", "", errors.New("s3 service not available")
			}
			cfg, err := r.d.Apps.GetConfig(ctx, a)
			if err != nil {
				return "", "", err
			}
			res, err := r.d.S3.UploadBuffer(ctx, cfg.S3, body, key, contentType)
			if err != nil {
				return "", "", err
			}
			u := res.URL
			if p, err := r.d.S3.PresignGet(ctx, cfg.S3, res.Key, 3600, nil); err == nil {
				u = p
			}
			return res.Key, u, nil
		},
		AI: func(ctx context.Context, in AIInput) (*AIOutput, error) {
			if r.d.AI == nil {
				return nil, errors.New("no AI API key configured (ai_api_key / secret ref)")
			}
			provider, model, key, budget := r.aiSettings(ctx, app)
			text, tokens, err := r.d.AI.Chat(ctx, AIRequest{
				AIChatOptions: AIChatOptions{Provider: provider, Model: model, Prompt: in.Prompt, System: in.System,
					ImageURL: in.ImageURL, ImageBase64: in.ImageBase64, JSONMode: in.JSONMode, MaxTokens: in.MaxTokens},
				App: in.App, AppDir: in.AppDir, APIKey: key, APIKeyRef: "STREAMFLOW_AI_API_KEY", BudgetUSD: budget,
			})
			if err != nil {
				return nil, err
			}
			out := &AIOutput{Text: text, UsageTokens: tokens, JSON: y.Undefined}
			if in.JSONMode && text != "" {
				if v, err := y.ParseJSON([]byte(text)); err == nil {
					out.JSON = v
				}
			}
			return out, nil
		},
		HTTPPost: func(ctx context.Context, u string, body any, headers *y.Map) (*HTTPResult, error) {
			return r.postJSON(ctx, u, body, headers, httpTimeout, "action.http URL")
		},
		Emit: func(ctx context.Context, a, event string, payload *y.Map) error {
			if r.d.Callbacks == nil {
				return nil
			}
			return r.d.Callbacks.Dispatch(ctx, a, event, payload)
		},
		MQTTPublish: func(ctx context.Context, a, topic string, payload any, qos int, retain bool) error {
			if r.d.MQTT != nil {
				r.d.MQTT(ctx, a, topic, payload, qos, retain)
			}
			return nil
		},
		Notify: func(ctx context.Context, a, event string, payload *y.Map, title string, channels []string) error {
			if r.d.Notify != nil {
				r.d.Notify(ctx, a, event, payload, title, channels)
			}
			return nil
		},
		PluginEvent: func(ctx context.Context, a, pluginID, event string, data *y.Map, room, token, target string) (*HTTPResult, error) {
			base := strings.TrimSpace(target)
			if base == "" {
				base = r.d.PublicBaseURL
			}
			if base == "" {
				base = "http://127.0.0.1:3020"
			}
			full := strings.TrimRight(base, "/") + "/api/v1/apps/" + jsx.EncodeURIComponent(a) +
				"/plugins/" + jsx.EncodeURIComponent(pluginID) + "/events"
			headers := y.NewMap()
			if token != "" {
				headers.Set("x-plugin-ingest-token", token)
			}
			body := obj("event", event)
			if room != "" {
				body.Set("room", room)
			}
			body.Set("data", data)
			return r.postJSON(ctx, full, body, headers, httpTimeout, "action.plugin URL")
		},
		Sleep: func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		},
		Now:      func() float64 { return float64(time.Now().UnixMilli()) },
		RunCode:  r.d.RunCode,
		RunShell: r.d.RunShell,
		RunSSH:   r.d.RunSSH,
		RunDB:    r.d.RunDB,
	}
}

// postJSON is the SSRF-guarded JSON POST with a bounded timeout.
func (r *Runner) postJSON(ctx context.Context, target string, body any, headers *y.Map, timeout time.Duration, label string) (*HTTPResult, error) {
	if err := security.AssertSafeEgressURL(ctx, target, security.EgressOptions{
		AllowedSchemes: security.HTTPSchemes, Label: label,
		Allowlist: security.ParseAllowlistEnv(os.Getenv(security.CallbackAllowHostsEnv)), Resolve: r.Resolve,
	}); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if y.IsNullish(body) {
		body = y.NewMap()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader([]byte(jsonString(body))))
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			return nil, httpx.BadRequest(ue.Error())
		}
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	if headers != nil {
		for _, k := range headers.Keys() {
			req.Header.Set(k, y.ToString(headers.Get(k)))
		}
	}
	res, err := r.HTTP.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("This operation was aborted")
		}
		return nil, errors.New("fetch failed")
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var parsed any
	if v, err := y.ParseJSON(raw); err == nil {
		parsed = v
	}
	return &HTTPResult{OK: res.StatusCode >= 200 && res.StatusCode <= 299, Status: res.StatusCode, Body: parsed}, nil
}
