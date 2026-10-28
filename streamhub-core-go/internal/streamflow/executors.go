package streamflow

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of boxes/executors.ts + boxes/context.ts: one executor per box type.
// Executors read the run bag through templates and call the injected Deps
// seam — never a core service directly — so tests drive them with fakes.

// BoxNode is a resolved box (config already secret-expanded by the runner).
type BoxNode struct {
	ID     string
	Type   string
	Config *y.Map
}

// Trigger is what started a run.
type Trigger struct {
	Event   string
	Payload *y.Map
}

// BoxContext is threaded through a run. Bag is
// { event, trigger: <payload>, vars: {}, <boxId>: <output>, … }.
type BoxContext struct {
	App              string
	AppDir           string
	DangerousEnabled bool
	Trigger          Trigger
	Bag              *y.Map
}

// newBag builds a fresh run bag from a trigger.
func newBag(event string, payload *y.Map) *y.Map {
	if payload == nil {
		payload = y.NewMap()
	}
	b := y.NewMap()
	b.Set("event", event)
	b.Set("trigger", payload)
	b.Set("vars", y.NewMap())
	return b
}

// AIInput is the action.ai request (BoxDeps.ai).
type AIInput struct {
	App, AppDir, Prompt, System, ImageURL, ImageBase64 string
	JSONMode                                           bool
	MaxTokens                                          *float64
}

// AIOutput is {text, usageTokens, json?}.
type AIOutput struct {
	Text        string
	UsageTokens float64
	JSON        any // Undefined when the reply was not strict JSON
}

// HTTPResult is {ok, status, body}.
type HTTPResult struct {
	OK     bool
	Status int
	Body   any
}

// CodeInput / ShellInput / SSHInput / DBInput are the dangerous seams' inputs.
type CodeInput struct {
	Source         string
	Input          any
	Timeout        time.Duration
	MaxOutputBytes int
}

type ShellInput struct {
	Command        string
	Args           []string
	Timeout        time.Duration
	MaxOutputBytes int
}

type SSHInput struct {
	Host, User, PrivateKey, Passphrase, Command string
	Port                                        int
	Timeout                                     time.Duration
	MaxOutputBytes                              int
}

type DBInput struct {
	Engine, DSN, Query string
	Params             []any
	RowLimit           int
	Timeout            time.Duration
}

// Deps is the BoxDeps capability seam (nil dangerous funcs = unavailable).
type Deps struct {
	Snapshot    func(ctx context.Context, app, room string, participant *string) (key, url string, err error)
	S3Upload    func(ctx context.Context, app, key string, body []byte, contentType string) (k, url string, err error)
	AI          func(ctx context.Context, in AIInput) (*AIOutput, error)
	HTTPPost    func(ctx context.Context, url string, body any, headers *y.Map) (*HTTPResult, error)
	Emit        func(ctx context.Context, app, event string, payload *y.Map) error
	MQTTPublish func(ctx context.Context, app, topic string, payload any, qos int, retain bool) error
	Notify      func(ctx context.Context, app, event string, payload *y.Map, title string, channels []string) error
	PluginEvent func(ctx context.Context, app, pluginID, event string, data *y.Map, room, token, url string) (*HTTPResult, error)
	Sleep       func(ctx context.Context, d time.Duration) error
	Now         func() float64 // epoch ms

	RunCode  func(ctx context.Context, in CodeInput) *y.Map
	RunShell func(ctx context.Context, in ShellInput) *y.Map
	RunSSH   func(ctx context.Context, in SSHInput) *y.Map
	RunDB    func(ctx context.Context, in DBInput) *y.Map
}

// Executor runs one box: output (value model) + the port that fired.
type Executor func(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error)

// emitEvents is the action.emit / lifecycle allowlist.
var emitEvents = []string{"streamflow.run_started", "streamflow.run_finished", "streamflow.run_failed", "streamflow.output"}

// normalizeEmitEvent coerces a name to the allowlist (default output).
func normalizeEmitEvent(name any) string {
	n, _ := name.(string)
	n = strings.TrimSpace(n)
	for _, e := range emitEvents {
		if e == n {
			return n
		}
	}
	return "streamflow.output"
}

func obj(kv ...any) *y.Map {
	m := y.NewMap()
	for i := 0; i < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

// orUndefined is `s || undefined` for optional strings.
func orNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// triggerRoom is String(ctx.trigger.payload?.room ?? ”).
func triggerRoom(bc *BoxContext) string {
	return y.ToString(y.Coalesce(bc.Trigger.Payload.Get("room"), ""))
}

// ---------------------------------------------------------------------------
// Trigger matching (StreamflowService)
// ---------------------------------------------------------------------------

// matchesEventTrigger: does a trigger.event config match a dispatched event?
func matchesEventTrigger(cfg *y.Map, event string, payload *y.Map) bool {
	if !eventNameMatches(cfg.Get("event"), event) {
		return false
	}
	if room, _ := cfg.Get("room").(string); strings.TrimSpace(room) != "" {
		if y.ToString(y.Coalesce(payload.Get("room"), "")) != strings.TrimSpace(room) {
			return false
		}
	}
	if tags, ok := cfg.Get("tags").([]any); ok {
		var want []string
		for _, t := range tags {
			if s := y.ToString(t); s != "" {
				want = append(want, s)
			}
		}
		if len(want) > 0 {
			have := extractTags(payload)
			hit := false
			for _, w := range want {
				for _, h := range have {
					if w == h {
						hit = true
					}
				}
			}
			if !hit {
				return false
			}
		}
	}
	if pred, ok := cfg.Get("predicate").(*y.Map); ok && pred != nil {
		if rules, ok := pred.Get("rules").([]any); ok && len(rules) > 0 {
			bag := obj("event", event, "trigger", payload)
			if !evalCondition(pred, bag) {
				return false
			}
		}
	}
	return true
}

func eventNameMatches(pattern any, event string) bool {
	p, _ := pattern.(string)
	p = strings.TrimSpace(p)
	if p == "" || p == "*" || p == "all" {
		return true
	}
	if strings.HasSuffix(p, ".*") {
		return strings.HasPrefix(event, p[:len(p)-1])
	}
	return event == p
}

// matchesMqttTrigger: a trigger.mqtt topic filter against payload.topic.
func matchesMqttTrigger(cfg, payload *y.Map) bool {
	filter, _ := cfg.Get("topic").(string)
	filter = strings.TrimSpace(filter)
	topic, _ := payload.Get("topic").(string)
	if filter == "" || filter == "#" || filter == "*" {
		return true
	}
	if topic == "" {
		return false
	}
	return topicMatches(filter, topic)
}

// topicMatches is an MQTT filter match (+ one level, # / * the rest).
func topicMatches(filter, topic string) bool {
	if filter == topic {
		return true
	}
	f := strings.Split(filter, "/")
	t := strings.Split(topic, "/")
	for i, seg := range f {
		if seg == "#" || seg == "*" {
			return true
		}
		if i >= len(t) {
			return false
		}
		if seg == "+" {
			continue
		}
		if seg != t[i] {
			return false
		}
	}
	return len(f) == len(t)
}

func extractTags(payload *y.Map) []string {
	var out []string
	if tags, ok := payload.Get("tags").([]any); ok {
		for _, t := range tags {
			out = append(out, y.ToString(t))
		}
	}
	if t, ok := payload.Get("tag").(string); ok {
		out = append(out, t)
	}
	return out
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

func triggerExec(_ context.Context, _ BoxNode, bc *BoxContext, _ *Deps) (any, string, error) {
	return bc.Trigger.Payload, "out", nil
}

func snapshotExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	room := resolveString(box.Config.Get("room"), bc.Bag)
	if room == "" {
		room = triggerRoom(bc)
	}
	if room == "" {
		return nil, "", errors.New("action.snapshot: no room (config.room / trigger.room)")
	}
	participant := orNil(resolveString(box.Config.Get("participantIdentity"), bc.Bag))
	key, url, err := deps.Snapshot(ctx, bc.App, room, participant)
	if err != nil {
		return nil, "", err
	}
	return obj("key", key, "url", url), "out", nil
}

func s3Exec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	content := resolveValue(box.Config.Get("content"), bc.Bag)
	var body []byte
	if s, ok := content.(string); ok {
		if box.Config.Get("base64") == true {
			body = decodeBase64(s)
		} else {
			body = []byte(s)
		}
	} else {
		body = []byte(jsonString(y.Coalesce(content, y.NewMap())))
	}
	key := resolveString(box.Config.Get("key"), bc.Bag)
	if key == "" {
		key = fmt.Sprintf("streamflow/%s-%s", box.ID, y.JSNumberString(deps.Now()))
	}
	k, url, err := deps.S3Upload(ctx, bc.App, key, body, resolveString(box.Config.Get("contentType"), bc.Bag))
	if err != nil {
		return nil, "", err
	}
	return obj("key", k, "url", url), "out", nil
}

// decodeBase64 is Buffer.from(s, 'base64'): standard and url-safe alphabets,
// whitespace / junk skipped, padding optional.
func decodeBase64(s string) []byte {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '+', r == '/':
			b.WriteRune(r)
		case r == '-':
			b.WriteByte('+')
		case r == '_':
			b.WriteByte('/')
		case r == '=':
			goto done
		}
	}
done:
	clean := b.String()
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	out, _ := base64.RawStdEncoding.DecodeString(clean)
	return out
}

// payloadOr is `config.payload === undefined ? bag.trigger : resolve(config.payload)`.
func payloadOr(cfg *y.Map, key string, bc *BoxContext) any {
	v := cfg.Get(key)
	if y.IsUndefined(v) {
		return bc.Bag.Get("trigger")
	}
	return resolveValue(v, bc.Bag)
}

func httpExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	url := resolveString(box.Config.Get("url"), bc.Bag)
	if url == "" {
		return nil, "", errors.New("action.http: config.url is required")
	}
	body := payloadOr(box.Config, "body", bc)
	headers := asObject(resolveValue(box.Config.Get("headers"), bc.Bag))
	res, err := deps.HTTPPost(ctx, url, body, headers)
	if err != nil {
		return nil, "", err
	}
	return httpOut(res), portIf(res.OK), nil
}

func httpOut(r *HTTPResult) *y.Map {
	return obj("ok", r.OK, "status", float64(r.Status), "body", r.Body)
}

func portIf(ok bool) string {
	if ok {
		return "out"
	}
	return "error"
}

func aiExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	prompt := resolveString(box.Config.Get("prompt"), bc.Bag)
	if prompt == "" {
		return nil, "", errors.New("action.ai: config.prompt is required")
	}
	in := AIInput{
		App: bc.App, AppDir: bc.AppDir, Prompt: prompt,
		System:      resolveString(box.Config.Get("system"), bc.Bag),
		ImageURL:    resolveString(box.Config.Get("imageUrl"), bc.Bag),
		ImageBase64: resolveString(box.Config.Get("imageBase64"), bc.Bag),
		JSONMode:    box.Config.Get("jsonMode") == true,
	}
	if n, ok := box.Config.Get("maxTokens").(float64); ok {
		in.MaxTokens = &n
	}
	res, err := deps.AI(ctx, in)
	if err != nil {
		return nil, "", err
	}
	return obj("text", res.Text, "usageTokens", res.UsageTokens, "json", res.JSON), "out", nil
}

func emitExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	event := normalizeEmitEvent(box.Config.Get("event"))
	payload := asObject(payloadOr(box.Config, "payload", bc))
	if err := deps.Emit(ctx, bc.App, event, payload); err != nil {
		return nil, "", err
	}
	return obj("event", event), "out", nil
}

func mqttExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	topic := resolveString(box.Config.Get("topic"), bc.Bag)
	if topic == "" {
		return nil, "", errors.New("action.mqtt: config.topic is required")
	}
	payload := payloadOr(box.Config, "payload", bc)
	qos := 0
	if q, ok := box.Config.Get("qos").(float64); ok && (q == 1 || q == 2) {
		qos = int(q)
	}
	if err := deps.MQTTPublish(ctx, bc.App, topic, payload, qos, box.Config.Get("retain") == true); err != nil {
		return nil, "", err
	}
	return obj("topic", topic), "out", nil
}

func notifyExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	event := resolveString(box.Config.Get("event"), bc.Bag)
	if event == "" {
		event = "streamflow.output"
	}
	payload := asObject(payloadOr(box.Config, "payload", bc))
	title := resolveString(box.Config.Get("title"), bc.Bag)
	var channels []string
	if arr, ok := box.Config.Get("channels").([]any); ok {
		channels = []string{}
		for _, c := range arr {
			channels = append(channels, y.ToString(c))
		}
	}
	if err := deps.Notify(ctx, bc.App, event, payload, title, channels); err != nil {
		return nil, "", err
	}
	return obj("event", event), "out", nil
}

func pluginExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	pluginID := resolveString(box.Config.Get("plugin"), bc.Bag)
	event := resolveString(box.Config.Get("event"), bc.Bag)
	if pluginID == "" || event == "" {
		return nil, "", errors.New("action.plugin: config.plugin and config.event are required")
	}
	data := asObject(resolveValue(box.Config.Get("data"), bc.Bag))
	room := resolveString(box.Config.Get("room"), bc.Bag)
	if room == "" {
		room = triggerRoom(bc)
	}
	res, err := deps.PluginEvent(ctx, bc.App, pluginID, event, data, room,
		resolveString(box.Config.Get("token"), bc.Bag), resolveString(box.Config.Get("url"), bc.Bag))
	if err != nil {
		return nil, "", err
	}
	return obj("ok", res.OK, "status", float64(res.Status)), portIf(res.OK), nil
}

// ---------------------------------------------------------------------------
// DANGEROUS execution boxes (flag-gated: streamflow.dangerousNodes)
// ---------------------------------------------------------------------------

// dangerousTypes are refused unless the app enabled execution nodes.
var dangerousTypes = map[string]bool{"action.code": true, "action.shell": true, "action.ssh": true, "action.db": true}

const (
	codeTimeoutDefault  = 5_000
	codeTimeoutMax      = 5_000
	shellTimeoutDefault = 10_000
	sshTimeoutDefault   = 15_000
	dbTimeoutDefault    = 15_000
	maxOutputBytes      = 64 * 1024
	dbRowLimitDefault   = 100
	dbRowLimitMax       = 10_000
)

func assertDangerous(bc *BoxContext, typ string) error {
	if !bc.DangerousEnabled {
		return fmt.Errorf("%s: execution nodes are disabled (enable streamflow.dangerousNodes)", typ)
	}
	return nil
}

// bounded is boundedTimeout: a positive number (or numeric string), floored
// and capped; anything else is def.
func bounded(v any, def, max float64) float64 {
	n := math.NaN()
	switch x := v.(type) {
	case float64:
		n = x
	case string:
		n = y.StringToNumber(x)
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return def
	}
	return math.Min(math.Floor(n), max)
}

func ms(n float64) time.Duration { return time.Duration(n) * time.Millisecond }

func execOK(r *y.Map) string { return portIf(r.Get("ok") == true) }

func codeExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	if err := assertDangerous(bc, "action.code"); err != nil {
		return nil, "", err
	}
	if deps.RunCode == nil {
		return nil, "", errors.New("action.code: sandbox not available")
	}
	source := resolveString(box.Config.Get("source"), bc.Bag)
	if source == "" {
		return nil, "", errors.New("action.code: config.source is required")
	}
	r := deps.RunCode(ctx, CodeInput{Source: source, Input: bc.Bag,
		Timeout: ms(bounded(box.Config.Get("timeoutMs"), codeTimeoutDefault, codeTimeoutMax)), MaxOutputBytes: maxOutputBytes})
	return r, execOK(r), nil
}

func shellExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	if err := assertDangerous(bc, "action.shell"); err != nil {
		return nil, "", err
	}
	if deps.RunShell == nil {
		return nil, "", errors.New("action.shell: not available")
	}
	command := resolveString(box.Config.Get("command"), bc.Bag)
	if command == "" {
		return nil, "", errors.New("action.shell: config.command is required")
	}
	args := []string{}
	if arr, ok := resolveValue(box.Config.Get("args"), bc.Bag).([]any); ok {
		for _, a := range arr {
			args = append(args, y.ToString(a))
		}
	}
	r := deps.RunShell(ctx, ShellInput{Command: command, Args: args,
		Timeout: ms(bounded(box.Config.Get("timeoutMs"), shellTimeoutDefault, 60_000)), MaxOutputBytes: maxOutputBytes})
	return r, execOK(r), nil
}

func sshExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	if err := assertDangerous(bc, "action.ssh"); err != nil {
		return nil, "", err
	}
	if deps.RunSSH == nil {
		return nil, "", errors.New("action.ssh: not available")
	}
	host := resolveString(box.Config.Get("host"), bc.Bag)
	user := resolveString(box.Config.Get("user"), bc.Bag)
	command := resolveString(box.Config.Get("command"), bc.Bag)
	key := resolveString(box.Config.Get("key"), bc.Bag)
	if host == "" || user == "" || command == "" {
		return nil, "", errors.New("action.ssh: config.host, config.user and config.command are required")
	}
	if key == "" {
		return nil, "", errors.New("action.ssh: config.key (a {{secret.NAME}} ref) is required")
	}
	r := deps.RunSSH(ctx, SSHInput{Host: host, User: user, PrivateKey: key, Command: command,
		Passphrase: resolveString(box.Config.Get("passphrase"), bc.Bag),
		Port:       int(bounded(box.Config.Get("port"), 22, 65535)),
		Timeout:    ms(bounded(box.Config.Get("timeoutMs"), sshTimeoutDefault, 120_000)), MaxOutputBytes: maxOutputBytes})
	return r, execOK(r), nil
}

func dbExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	if err := assertDangerous(bc, "action.db"); err != nil {
		return nil, "", err
	}
	if deps.RunDB == nil {
		return nil, "", errors.New("action.db: not available")
	}
	engine := "postgres"
	if box.Config.Get("engine") == "mysql" {
		engine = "mysql"
	}
	dsn := resolveString(box.Config.Get("dsn"), bc.Bag)
	query, _ := box.Config.Get("query").(string)
	if dsn == "" {
		return nil, "", errors.New("action.db: config.dsn (a {{secret.NAME}} ref) is required")
	}
	if strings.TrimSpace(query) == "" {
		return nil, "", errors.New("action.db: config.query is required")
	}
	params, _ := resolveValue(box.Config.Get("params"), bc.Bag).([]any)
	if params == nil {
		params = []any{}
	}
	r := deps.RunDB(ctx, DBInput{Engine: engine, DSN: dsn, Query: query, Params: params,
		RowLimit: int(bounded(box.Config.Get("rowLimit"), dbRowLimitDefault, dbRowLimitMax)),
		Timeout:  ms(bounded(box.Config.Get("timeoutMs"), dbTimeoutDefault, 60_000))})
	return r, execOK(r), nil
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

func conditionExec(_ context.Context, box BoxNode, bc *BoxContext, _ *Deps) (any, string, error) {
	matched := evalCondition(box.Config, bc.Bag)
	port := "false"
	if matched {
		port = "true"
	}
	return obj("matched", matched), port, nil
}

func delayExec(ctx context.Context, box BoxNode, bc *BoxContext, deps *Deps) (any, string, error) {
	seconds := y.ToNumber(resolveValue(box.Config.Get("seconds"), bc.Bag))
	msCfg := y.ToNumber(resolveValue(box.Config.Get("ms"), bc.Bag))
	d := 0.0
	if finite(msCfg) && msCfg > 0 {
		d = msCfg
	}
	if d == 0 && finite(seconds) && seconds > 0 {
		d = seconds * 1000
	}
	d = math.Max(0, math.Min(d, 60_000))
	if d > 0 {
		if err := deps.Sleep(ctx, time.Duration(d*float64(time.Millisecond))); err != nil {
			return nil, "", err
		}
	}
	return obj("delayedMs", d), "out", nil
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func setvarExec(_ context.Context, box BoxNode, bc *BoxContext, _ *Deps) (any, string, error) {
	applied := y.NewMap()
	set := asObject(box.Config.Get("set"))
	for _, path := range set.Keys() {
		v := resolveValue(set.Get(path), bc.Bag)
		setPath(bc.Bag, path, v)
		applied.Set(path, v)
	}
	if arr, ok := box.Config.Get("assignments").([]any); ok {
		for _, a := range arr {
			path := strings.TrimSpace(y.ToString(y.Coalesce(field(a, "path"), "")))
			if path == "" {
				continue
			}
			v := resolveValue(field(a, "value"), bc.Bag)
			setPath(bc.Bag, path, v)
			applied.Set(path, v)
		}
	}
	return applied, "out", nil
}

func switchExec(_ context.Context, box BoxNode, bc *BoxContext, _ *Deps) (any, string, error) {
	port := evalSwitch(box.Config, bc.Bag)
	value := getPath(bc.Bag, y.ToString(y.Coalesce(box.Config.Get("field"), "")))
	return obj("port", port, "value", value), port, nil
}

// executors is the registry (EXECUTORS).
var executors = map[string]Executor{
	"trigger.event":    triggerExec,
	"trigger.schedule": triggerExec,
	"trigger.mqtt":     triggerExec,
	"trigger.manual":   triggerExec,
	"action.snapshot":  snapshotExec,
	"action.s3":        s3Exec,
	"action.http":      httpExec,
	"action.ai":        aiExec,
	"action.emit":      emitExec,
	"action.mqtt":      mqttExec,
	"action.notify":    notifyExec,
	"action.plugin":    pluginExec,
	"action.code":      codeExec,
	"action.shell":     shellExec,
	"action.ssh":       sshExec,
	"action.db":        dbExec,
	"logic.condition":  conditionExec,
	"logic.delay":      delayExec,
	"logic.setvar":     setvarExec,
	"logic.switch":     switchExec,
}
