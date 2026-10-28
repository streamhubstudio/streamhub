package cameras

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/fleet"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
)

// A periodic reconcile (plus an on-demand EnsureForApp on every read)
// connects/drops one subscriber per app where the cameras app is installed +
// enabled AND the app's mqtt: broker is configured — the fleet pattern, on
// fleet's MQTT client seam (fleet.Factory: paho + SSRF guard + TLS).

const (
	reconnectBase  = time.Second
	reconnectMax   = 30 * time.Second
	connectTimeout = 10 * time.Second
	// ReconcileInterval is how often the reconcile + stale reaper runs.
	ReconcileInterval = 20 * time.Second
	// SweepInterval is how often open commands are checked for timeout.
	SweepInterval = 2 * time.Second
	// graceSec is added to `exp` before an unanswered command times out
	// (STREAMHUB.md §4.2: "timeout si no recibe accepted o done en exp + 10 s").
	graceSec = 10
	// ptzDirExpSec is the short expiry of a deadman repeat: a queued ptz/dir
	// must never run seconds later.
	ptzDirExpSec = 2
	// maxThumbBytes bounds the retained thumbnail kept per camera.
	maxThumbBytes = 256 << 10
	// maxWait bounds a POST command's waitMs.
	maxWait = 20 * time.Second
	// backfillMax is the largest seq gap that triggers an `events {n}` refill.
	backfillMax = 500
)

// Config are the resolved per-app knobs (plugin config + defaults).
type Config struct {
	BaseTopic             string
	OfflineAfterSec       float64
	CommandExpSec         float64
	LongCommandTimeoutSec float64
	HistoryPoints         float64
	EventsPerCamera       float64
	HdRevertMin           float64
	BrokerPublicURL       string
	RtmpPublicURL         string
	IniAppBrokerCreds     bool
}

// PluginRepo is the AppPluginsRepository slice cameras reads.
type PluginRepo interface {
	Get(ctx context.Context, app, pluginID string) (*plugins.Installed, error)
}

// Logs is LogsServiceContract.write.
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Audit is the audit sink for dangerous commands (audit.Service).
type Audit interface {
	RecordCtx(ctx context.Context, e audit.Event)
}

// InactiveError → 409 (not installed/enabled or no broker).
type InactiveError struct{ msg string }

func (e *InactiveError) Error() string { return e.msg }

// NotFoundError → 404.
type NotFoundError struct{ msg string }

func (e *NotFoundError) Error() string { return e.msg }

// ConflictError → 409 (unsupported by the camera's caps, duplicate alta).
type ConflictError struct{ msg string }

func (e *ConflictError) Error() string { return e.msg }

type subscriber struct {
	client      fleet.Client
	fingerprint string
	root        string
	mu          sync.Mutex
	attempts    int
	errorLogged bool
}

// Deps wires the Service.
type Deps struct {
	Apps    contracts.AppsService
	Plugins PluginRepo
	Store   *Store
	Factory fleet.Factory
	Logs    func() Logs
	Audit   func() Audit
	Now     func() time.Time
}

// Service is the cameras module.
type Service struct {
	apps    contracts.AppsService
	plugins PluginRepo
	store   *Store
	factory fleet.Factory
	logs    func() Logs
	audit   func() Audit
	now     func() time.Time

	mu       sync.Mutex
	subs     map[string]*subscriber
	waiters  map[string][]chan struct{}
	hd       map[string]*hdState // app/device
	backfill map[string]time.Time
}

type hdState struct {
	until time.Time
	timer *time.Timer
}

// New builds the service (no background work until Start).
func New(d Deps) *Service {
	s := &Service{apps: d.Apps, plugins: d.Plugins, store: d.Store, factory: d.Factory, logs: d.Logs, audit: d.Audit, now: d.Now,
		subs: map[string]*subscriber{}, waiters: map[string][]chan struct{}{}, hd: map[string]*hdState{}, backfill: map[string]time.Time{}}
	if s.store == nil {
		s.store = NewStore()
	}
	if s.factory == nil {
		s.factory = fleet.DefaultFactory
	}
	if s.now == nil {
		s.now = time.Now
	}
	s.store.now = s.now
	return s
}

// Start runs the reconcile now and every ReconcileInterval, plus the command
// timeout sweep; cancelling ctx drops every subscriber and closes the stores.
func (s *Service) Start(ctx context.Context) {
	go func() {
		s.Reconcile(ctx)
		rt := time.NewTicker(ReconcileInterval)
		st := time.NewTicker(SweepInterval)
		defer rt.Stop()
		defer st.Stop()
		for {
			select {
			case <-ctx.Done():
				s.Close()
				return
			case <-rt.C:
				s.Reconcile(ctx)
			case <-st.C:
				s.Sweep(ctx)
			}
		}
	}()
}

// Close drops every subscriber, stops the HD timers and closes the DBs.
func (s *Service) Close() {
	s.mu.Lock()
	apps := make([]string, 0, len(s.subs))
	for app := range s.subs {
		apps = append(apps, app)
	}
	for k, h := range s.hd {
		h.timer.Stop()
		delete(s.hd, k)
	}
	s.mu.Unlock()
	for _, app := range apps {
		s.drop(app)
	}
	s.store.Close()
}

func (s *Service) log(level, message string, meta any) {
	if s.logs == nil {
		return
	}
	if l := s.logs(); l != nil {
		l.Write(level, "cameras", message, meta, nil)
	}
}

type warnMeta struct {
	App   string `json:"app"`
	Error string `json:"error"`
}

func (s *Service) warn(app, message string, err error) {
	s.log("warn", message, warnMeta{app, err.Error()})
}

type deviceMeta struct {
	App    string `json:"app"`
	Device string `json:"device"`
}

// Reconcile brings subscribers in line with install state for every app.
func (s *Service) Reconcile(ctx context.Context) {
	list, err := s.apps.List(ctx, nil)
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, a := range list {
		present[a.Name] = true
		if _, _, err := s.EnsureForApp(ctx, a.Name); err != nil {
			s.warn(a.Name, "reconcile failed", err)
		}
	}
	s.mu.Lock()
	var gone []string
	for app := range s.subs {
		if !present[app] {
			gone = append(gone, app)
		}
	}
	s.mu.Unlock()
	for _, app := range gone {
		s.drop(app)
	}
}

// Sweep times out unanswered commands of every active app.
func (s *Service) Sweep(ctx context.Context) {
	s.mu.Lock()
	apps := make([]string, 0, len(s.subs))
	for app := range s.subs {
		apps = append(apps, app)
	}
	s.mu.Unlock()
	for _, app := range apps {
		s.expire(ctx, app)
	}
}

func (s *Service) expire(ctx context.Context, app string) {
	ids, err := s.store.ExpireOpen(ctx, app, s.apps.AppDir(app))
	if err != nil {
		s.warn(app, "command timeout sweep failed", err)
		return
	}
	for _, id := range ids {
		s.notify(id)
	}
}

// EnsureForApp ensures a current subscriber iff the app is enabled and the
// app has an MQTT broker; otherwise drops it. Also reaps stale cameras and
// times out commands. Returns the topic root (active=false when inactive).
func (s *Service) EnsureForApp(ctx context.Context, app string) (root string, active bool, err error) {
	row, err := s.plugins.Get(ctx, app, PluginID)
	if err != nil {
		return "", false, err
	}
	if row == nil || !row.Enabled {
		s.drop(app)
		return "", false, nil
	}
	appCfg, err := s.apps.GetConfig(ctx, app)
	if err != nil {
		s.drop(app)
		return "", false, nil
	}
	mq := appCfg.Mqtt
	if !mq.Enabled || y.Trim(mq.URL) == "" {
		s.drop(app)
		return "", false, nil
	}
	cfg := configFrom(row.Config)
	appDir := s.apps.AppDir(app)
	if flipped, err := s.store.ReapStale(ctx, app, appDir, cfg.OfflineAfterSec*1000); err != nil {
		s.warn(app, "stale reap failed", err)
	} else {
		for _, d := range flipped {
			s.log("info", fmt.Sprintf("camera '%s' went offline (stale)", d), deviceMeta{app, d})
		}
	}
	s.expire(ctx, app)
	s.ensureClient(app, mq, cfg.BaseTopic)
	return cfg.BaseTopic, true, nil
}

func qosOf(q int) byte {
	if q == 2 {
		return 2
	}
	return 1 // the contract is QoS 1 on every topic
}

type subscribedMeta struct {
	App  string `json:"app"`
	Root string `json:"root"`
}

func (s *Service) ensureClient(app string, mq contracts.MqttConfig, root string) {
	fingerprint := strings.Join([]string{mq.URL, mq.Username, mq.Password, fmt.Sprint(mq.TLS), fmt.Sprint(mq.Qos), root}, " ")
	s.mu.Lock()
	existing := s.subs[app]
	s.mu.Unlock()
	if existing != nil && existing.fingerprint == fingerprint {
		return
	}
	if existing != nil {
		s.drop(app)
	}
	client, err := s.factory(fleet.ConnectOptions{
		URL: mq.URL, Username: mq.Username, Password: mq.Password, TLS: mq.TLS,
		ClientID:        "streamhub-cameras-" + app + "-" + uuid.NewString()[:8],
		ReconnectPeriod: reconnectBase, ConnectTimeout: connectTimeout,
		// status/hello/state must apply in arrival order (an LWT offline
		// overtaking the next online would strand a camera offline)
		OrderMatters: true,
	})
	if err != nil {
		s.warn(app, "cameras mqtt client creation failed", err)
		return
	}
	sub := &subscriber{client: client, fingerprint: fingerprint, root: root}
	s.mu.Lock()
	s.subs[app] = sub
	s.mu.Unlock()

	qos := qosOf(mq.Qos)
	subscribe := func() {
		client.Subscribe(Subscriptions(root), qos, func(err error) {
			if err != nil {
				s.warn(app, "cameras subscribe failed", err)
			}
		})
	}
	client.Start(fleet.Events{
		OnConnect: func() {
			sub.mu.Lock()
			sub.attempts, sub.errorLogged = 0, false
			sub.mu.Unlock()
			client.SetReconnectPeriod(reconnectBase)
			subscribe()
			s.log("info", "subscribed to OpenCam topics", subscribedMeta{app, root})
		},
		OnMessageRetained: func(topic string, payload []byte, retained bool) {
			s.OnMessage(context.Background(), app, root, topic, payload, retained)
		},
		OnClose: func() {
			sub.mu.Lock()
			sub.attempts++
			d := time.Duration(math.Min(float64(reconnectMax), float64(reconnectBase)*math.Pow(2, math.Max(0, float64(sub.attempts-1)))))
			sub.mu.Unlock()
			client.SetReconnectPeriod(d)
		},
		OnError: func(err error) {
			sub.mu.Lock()
			logged := sub.errorLogged
			sub.errorLogged = true
			sub.mu.Unlock()
			if !logged {
				s.warn(app, "cameras broker connection error", err)
			}
		},
	})
	if client.Connected() {
		subscribe()
	}
}

func (s *Service) drop(app string) {
	s.mu.Lock()
	sub := s.subs[app]
	delete(s.subs, app)
	s.mu.Unlock()
	if sub != nil {
		sub.client.End()
	}
}

func (s *Service) config(ctx context.Context, app string) Config {
	var c *y.Map
	if row, err := s.plugins.Get(ctx, app, PluginID); err == nil && row != nil {
		c = row.Config
	}
	return configFrom(c)
}

// configFrom resolves the plugin config (positive finite numbers or the
// builtins.json defaults).
func configFrom(c *y.Map) Config {
	n := func(k string, def float64) float64 {
		if c == nil {
			return def
		}
		v, ok := num(c.Get(k))
		if !ok || v <= 0 {
			return def
		}
		return v
	}
	str := func(k string) string {
		if c == nil {
			return ""
		}
		v, _ := c.Get(k).(string)
		return y.Trim(v)
	}
	cfg := Config{
		BaseTopic:             NormalizeRoot(str("baseTopic")),
		OfflineAfterSec:       n("offlineAfterSec", 180),
		CommandExpSec:         n("commandExpSec", 30),
		LongCommandTimeoutSec: n("longCommandTimeoutSec", 900),
		HistoryPoints:         n("historyPoints", 120),
		EventsPerCamera:       n("eventsPerCamera", 2000),
		HdRevertMin:           n("hdRevertMin", 5),
		BrokerPublicURL:       str("brokerPublicUrl"),
		RtmpPublicURL:         str("rtmpPublicUrl"),
	}
	if c != nil {
		cfg.IniAppBrokerCreds = c.Get("iniUseAppBrokerCredentials") == true
	}
	return cfg
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

// OnMessage routes one inbound message into the store. Never fails.
// retained=true is a broker replay (does not count as live traffic).
func (s *Service) OnMessage(ctx context.Context, app, root, topic string, payload []byte, retained bool) {
	device, kind, rest, ok := ParseTopic(root, topic)
	if !ok {
		return
	}
	appDir := s.apps.AppDir(app)
	cfg := s.config(ctx, app)
	var err error
	touch := !retained
	switch kind {
	case KindStatus:
		touch = false
		status := parseStatus(payload)
		var prev string
		prev, err = s.store.SetStatus(ctx, app, appDir, device, status, !retained)
		if err == nil && prev != status {
			s.log("info", fmt.Sprintf("camera '%s' is %s", device, status), deviceMeta{app, device})
		}
	case KindHello:
		hello := parseObject(payload)
		if hello == nil {
			return
		}
		var linked bool
		_, linked, err = s.store.SetHello(ctx, app, appDir, device, hello)
		if err == nil && linked {
			s.log("info", fmt.Sprintf("camera '%s' linked (first hello)", device), deviceMeta{app, device})
		}
		// any hello whose boot_id differs from the one recorded when a
		// reboot-like command was sent resolves it (state/event lines may
		// already have moved cameras.boot_id forward)
		if boot, _ := hello.Get("boot_id").(string); err == nil && boot != "" {
			ids, rerr := s.store.ResolveRebooted(ctx, app, appDir, device, boot)
			if rerr != nil {
				err = rerr
			}
			for _, id := range ids {
				s.notify(id)
			}
		}
	case KindState:
		st := parseObject(payload)
		if st == nil {
			return
		}
		err = s.store.SetState(ctx, app, appDir, device, st, cfg.HistoryPoints, !retained)
	case KindEvent:
		e := ParseEvent(payload)
		if e == nil {
			return
		}
		var gap int64
		gap, _, err = s.store.AddEvent(ctx, app, appDir, device, e, cfg.EventsPerCamera)
		if err == nil && gap > 0 {
			s.requestBackfill(ctx, app, device, gap)
		}
	case KindRes:
		r := ParseResponse(rest, payload)
		if r == nil {
			return
		}
		if r.Cmd == "events" {
			s.ingestEvents(ctx, app, appDir, device, r.Result, cfg.EventsPerCamera)
		}
		if r.ID == "" {
			break
		}
		long := time.Duration(cfg.LongCommandTimeoutSec * float64(time.Second))
		var changed bool
		_, changed, err = s.store.ApplyResponse(ctx, app, appDir, r, s.now().Add(long))
		if err == nil && changed {
			s.notify(r.ID)
		}
	case KindThumb:
		touch = false
		if len(payload) > maxThumbBytes {
			return
		}
		err = s.store.SetThumb(ctx, app, appDir, device, payload)
	}
	if err == nil && touch {
		err = s.store.Touch(ctx, app, appDir, device)
	}
	if err != nil {
		s.warn(app, "failed to handle "+kind, err)
	}
}

// ingestEvents stores the events of an `events {n}` answer (deduplicated
// by (boot_id, seq)): result is an array or {events:[…]}.
func (s *Service) ingestEvents(ctx context.Context, app, appDir, device string, result any, cap float64) {
	list, ok := result.([]any)
	if !ok {
		if m, isMap := result.(*y.Map); isMap && m != nil {
			list, _ = m.Get("events").([]any)
		}
	}
	for _, item := range list {
		m, ok := item.(*y.Map)
		if !ok || m == nil {
			continue
		}
		raw, _ := y.Stringify(m)
		if e := ParseEvent([]byte(raw)); e != nil {
			if _, _, err := s.store.AddEvent(ctx, app, appDir, device, e, cap); err != nil {
				s.warn(app, "event backfill failed", err)
				return
			}
		}
	}
}

func (s *Service) requestBackfill(ctx context.Context, app, device string, gap int64) {
	if gap > backfillMax {
		gap = backfillMax
	}
	key := app + "/" + device
	s.mu.Lock()
	last := s.backfill[key]
	if !last.IsZero() && s.now().Sub(last) < 30*time.Second {
		s.mu.Unlock()
		return
	}
	s.backfill[key] = s.now()
	s.mu.Unlock()
	args := y.NewMap()
	// the gap plus a little slack: the newest events may have raced it
	args.Set("n", float64(gap+5))
	if _, err := s.SendCommand(ctx, app, device, CommandRequest{Cmd: "events", Args: args, Actor: "system:backfill"}); err != nil {
		s.warn(app, "event backfill request failed", err)
	}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// CommandRequest is one command to send.
type CommandRequest struct {
	Cmd     string
	Args    any
	ExpSec  *float64
	IfRev   *float64
	Confirm bool
	Wait    time.Duration
	Actor   string
}

func (s *Service) notify(id string) {
	s.mu.Lock()
	chans := s.waiters[id]
	delete(s.waiters, id)
	s.mu.Unlock()
	for _, c := range chans {
		close(c)
	}
}

func (s *Service) waiter(id string) chan struct{} {
	c := make(chan struct{})
	s.mu.Lock()
	s.waiters[id] = append(s.waiters[id], c)
	s.mu.Unlock()
	return c
}

func (s *Service) unwait(id string, c chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.waiters[id]
	for i, x := range list {
		if x == c {
			s.waiters[id] = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(s.waiters[id]) == 0 {
		delete(s.waiters, id)
	}
}

func settled(r *CamerasCommandRow) bool {
	switch r.Status {
	case "done", "failed", "timeout", "sent":
		return true
	case "accepted", "progress":
		return r.Long
	}
	return false
}

type commandMeta struct {
	App    string `json:"app"`
	Device string `json:"device"`
	Cmd    string `json:"cmd"`
	ID     string `json:"id"`
}

// SendCommand validates, publishes `<root>/<dev>/cmd/<cmd>` with the
// envelope {id, ts, exp, if_rev?, ...args} and records it pending (an
// ephemeral command is only published: status "sent"). With req.Wait it
// blocks until the command settles (done/failed/timeout, or accepted for a
// long command) or the wait elapses. *CommandError → 400, *NotFoundError →
// 404, *InactiveError / *ConflictError → 409.
func (s *Service) SendCommand(ctx context.Context, app, device string, req CommandRequest) (*CamerasCommandRow, error) {
	if !ValidDevice(device) {
		return nil, cmdErr("invalid device id")
	}
	if req.Actor == "" {
		if p := auth.From(ctx); p != nil {
			req.Actor = p.UserID
		}
	}
	spec, args, err := ValidateCommand(device, req.Cmd, req.Args)
	if err != nil {
		return nil, err
	}
	if spec.Dangerous && !req.Confirm {
		return nil, cmdErr(fmt.Sprintf("'%s' is a dangerous command: resend with \"confirm\": true", req.Cmd))
	}
	root, active, err := s.EnsureForApp(ctx, app)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	sub := s.subs[app]
	s.mu.Unlock()
	if !active || sub == nil {
		return nil, inactive(app)
	}
	appDir := s.apps.AppDir(app)
	cam, err := s.store.Get(ctx, app, appDir, device)
	if err != nil {
		return nil, err
	}
	if cam == nil {
		return nil, &NotFoundError{fmt.Sprintf("camera '%s' not found", device)}
	}
	if caps := capsOf(cam.Hello); caps != nil && spec.Cap != "" && !contains(caps, spec.Cap) {
		return nil, &ConflictError{fmt.Sprintf("camera '%s' does not support '%s' (no '%s' in hello.caps)", device, req.Cmd, spec.Cap)}
	}
	cfg := s.config(ctx, app)
	exp := cfg.CommandExpSec
	if req.Cmd == "ptz/dir" {
		exp = ptzDirExpSec
	}
	if req.ExpSec != nil && *req.ExpSec >= 1 {
		exp = math.Min(3600, *req.ExpSec)
	}
	expS := int64(math.Ceil(exp))

	id := uuid.NewString()
	now := s.now()
	env := y.NewMap()
	env.Set("id", id)
	env.Set("ts", now.UTC().Format(time.RFC3339))
	env.Set("exp", float64(expS))
	if spec.Config {
		if req.IfRev != nil {
			env.Set("if_rev", math.Floor(*req.IfRev))
		} else if rev := currentRev(cam); rev != nil {
			env.Set("if_rev", *rev)
		}
	}
	for _, k := range args.Keys() {
		env.Set(k, args.Get(k))
	}
	payload, _ := y.Stringify(env)
	topic := CommandTopic(root, device, req.Cmd)

	if spec.Ephemeral {
		sub.client.Publish(topic, []byte(payload), 1, false, func(err error) {
			if err != nil {
				s.warn(app, fmt.Sprintf("command publish to '%s' failed", device), err)
			}
		})
		ts := jsx.ISO(now)
		return &CamerasCommandRow{ID: id, Device: device, Cmd: req.Cmd, Args: args, Status: "sent", ExpSec: expS,
			Actor: optStr(req.Actor), Deadline: jsx.ISO(now.Add(time.Duration(expS) * time.Second)), CreatedAt: ts, UpdatedAt: ts}, nil
	}

	boot := ""
	if cam.BootID != nil {
		boot = *cam.BootID
	}
	if err := s.store.RecordCommand(ctx, app, appDir, NewCommand{
		ID: id, Device: device, Cmd: req.Cmd, Args: args, ExpSec: expS, Long: spec.Long, BootID: boot, Actor: req.Actor,
		Deadline: now.Add(time.Duration(expS+graceSec) * time.Second),
	}); err != nil {
		return nil, err
	}
	var wait chan struct{}
	if req.Wait > 0 {
		wait = s.waiter(id)
	}
	sub.client.Publish(topic, []byte(payload), 1, false, func(err error) {
		if err == nil {
			return
		}
		s.warn(app, fmt.Sprintf("command publish to '%s' failed", device), err)
		_, changed, aerr := s.store.ApplyResponse(context.Background(), app, appDir,
			&Response{ID: id, Phase: "failed", Code: "network", Error: "publish failed: " + err.Error()}, s.now())
		if aerr == nil && changed {
			s.notify(id)
		}
	})
	s.log("info", fmt.Sprintf("command '%s' → camera '%s' (%s)", req.Cmd, device, id), commandMeta{app, device, req.Cmd, id})
	if spec.Dangerous && s.audit != nil {
		if a := s.audit(); a != nil {
			a.RecordCtx(ctx, audit.Event{Action: "cameras.command", TargetType: audit.Str("camera"), TargetID: audit.Str(app + "/" + device),
				Meta: commandMeta{app, device, req.Cmd, id}})
		}
	}
	row, err := s.store.GetCommand(ctx, app, appDir, id)
	if err != nil || wait == nil {
		return row, err
	}
	d := req.Wait
	if d > maxWait {
		d = maxWait
	}
	t := time.NewTimer(d)
	defer t.Stop()
	for row != nil && !settled(row) {
		select {
		case <-wait:
			// re-arm BEFORE re-reading so a phase landing in between is not lost
			wait = s.waiter(id)
		case <-t.C:
			s.unwait(id, wait)
			return s.store.GetCommand(ctx, app, appDir, id)
		case <-ctx.Done():
			s.unwait(id, wait)
			return row, nil
		}
		if row, err = s.store.GetCommand(ctx, app, appDir, id); err != nil {
			s.unwait(id, wait)
			return nil, err
		}
	}
	s.unwait(id, wait)
	return row, nil
}

func inactive(app string) error {
	return &InactiveError{fmt.Sprintf("cameras is not active for app '%s' (install+enable the cameras app and configure mqtt)", app)}
}

func currentRev(c *CameraRow) *float64 {
	if r := digNum(c.State, "config_rev"); r != nil {
		return r
	}
	return digNum(c.Hello, "config_rev")
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// GetCommand returns one command of device (nil when absent).
func (s *Service) GetCommand(ctx context.Context, app, device, id string) (*CamerasCommandRow, error) {
	if _, _, err := s.EnsureForApp(ctx, app); err != nil {
		return nil, err
	}
	r, err := s.store.GetCommand(ctx, app, s.apps.AppDir(app), id)
	if err != nil || r == nil || r.Device != device {
		return nil, err
	}
	return r, nil
}

// SetHD switches the camera to the main stream (`stream/set {source: 0}`)
// for minutes (default hdRevertMin), then back to the sub-stream; on=false
// reverts now. The revert timer lives in memory (a core restart while HD is
// on leaves the camera on the main stream until the next toggle).
func (s *Service) SetHD(ctx context.Context, app, device string, on bool, minutes float64, actor string) (*CamerasCommandRow, *string, error) {
	key := app + "/" + device
	source := 1.0
	if on {
		source = 0
	}
	args := y.NewMap()
	args.Set("source", source)
	row, err := s.SendCommand(ctx, app, device, CommandRequest{Cmd: "stream/set", Args: args, Actor: actor})
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := s.hd[key]; h != nil {
		h.timer.Stop()
		delete(s.hd, key)
	}
	if !on {
		return row, nil, nil
	}
	if minutes <= 0 {
		minutes = s.config(ctx, app).HdRevertMin
	}
	minutes = math.Min(240, minutes)
	d := time.Duration(minutes * float64(time.Minute))
	h := &hdState{until: s.now().Add(d)}
	h.timer = time.AfterFunc(d, func() {
		s.mu.Lock()
		if s.hd[key] == h {
			delete(s.hd, key)
		}
		s.mu.Unlock()
		back := y.NewMap()
		back.Set("source", 1.0)
		if _, err := s.SendCommand(context.Background(), app, device, CommandRequest{Cmd: "stream/set", Args: back, Actor: "system:hd-revert"}); err != nil {
			s.warn(app, "HD revert failed", err)
		}
	})
	s.hd[key] = h
	until := jsx.ISO(h.until)
	return row, &until, nil
}

func (s *Service) hdUntil(app, device string) *string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := s.hd[app+"/"+device]; h != nil {
		u := jsx.ISO(h.until)
		return &u
	}
	return nil
}

// ---------------------------------------------------------------------------
// Inventory + reads
// ---------------------------------------------------------------------------

// CameraSummary flattens the state fields the grid shows.
type CameraSummary struct {
	Rssi             *float64 `json:"rssi"`
	Ssid             *string  `json:"ssid"`
	IP               *string  `json:"ip"`
	StreamRunning    *bool    `json:"streamRunning"`
	StreamSource     *float64 `json:"streamSource"`
	BitrateKbps      *float64 `json:"bitrateKbps"`
	RecordRunning    *bool    `json:"recordRunning"`
	SdPresent        *bool    `json:"sdPresent"`
	SdFreeKb         *float64 `json:"sdFreeKb"`
	SdTotalKb        *float64 `json:"sdTotalKb"`
	QueueFiles       *float64 `json:"queueFiles"`
	QueueBytes       *float64 `json:"queueBytes"`
	PtzX             *float64 `json:"ptzX"`
	PtzY             *float64 `json:"ptzY"`
	PtzMoving        *bool    `json:"ptzMoving"`
	PtzPreset        *float64 `json:"ptzPreset"`
	MemFreeKb        *float64 `json:"memFreeKb"`
	Load1            *float64 `json:"load1"`
	SafeMode         *bool    `json:"safeMode"`
	UptimeS          *float64 `json:"uptimeS"`
	LastRebootReason *string  `json:"lastRebootReason"`
	ConfigRev        *float64 `json:"configRev"`
}

// CameraView is the serializable camera.
type CameraView struct {
	Device       string        `json:"device"`
	Name         *string       `json:"name"`
	Site         *string       `json:"site"`
	Stand        *string       `json:"stand"`
	Model        *string       `json:"model"`
	Room         *string       `json:"room"`
	Tags         []string      `json:"tags"`
	Provisioned  bool          `json:"provisioned"`
	Linked       bool          `json:"linked"`
	Online       bool          `json:"online"`
	Status       string        `json:"status" enum:"online,offline,unknown"`
	StatusAt     *string       `json:"statusAt"`
	LastSeen     *string       `json:"lastSeen"`
	AgeMs        *int64        `json:"ageMs"`
	Fw           *string       `json:"fw"`
	API          *float64      `json:"api"`
	Image        *string       `json:"image"`
	Caps         []string      `json:"caps"`
	CapsKnown    bool          `json:"capsKnown"`
	BootID       *string       `json:"bootId"`
	EventsLost   int64         `json:"eventsLost"`
	ThumbAt      *string       `json:"thumbAt"`
	HdUntil      *string       `json:"hdUntil"`
	StreamURL    *string       `json:"streamUrl"`
	HasStreamKey bool          `json:"hasStreamKey"`
	MqttUser     *string       `json:"mqttUser"`
	HlsPath      *string       `json:"hlsPath"`
	Summary      CameraSummary `json:"summary"`
	Hello        *y.Map        `json:"hello"`
	State        *y.Map        `json:"state"`
	HelloAt      *string       `json:"helloAt"`
	StateAt      *string       `json:"stateAt"`
	CreatedAt    string        `json:"createdAt"`
}

// CamerasList is the GET cameras payload.
type CamerasList struct {
	Active      bool         `json:"active"`
	BaseTopic   string       `json:"baseTopic"`
	Cameras     []CameraView `json:"cameras"`
	GeneratedAt string       `json:"generatedAt"`
}

// CameraDetail is the GET cameras/{device} payload.
type CameraDetail struct {
	Camera   CameraView            `json:"camera"`
	History  []CamerasHistoryPoint `json:"history"`
	Commands []CamerasCommandRow   `json:"commands"`
	Events   []CamerasEventRow     `json:"events"`
}

// ListFilter narrows GET cameras.
type ListFilter struct {
	Site, Stand, Tag string
	Online           *bool
}

func (s *Service) view(app string, r CameraRow) CameraView {
	v := CameraView{Device: r.Device, Name: r.Name, Site: r.Site, Stand: r.Stand, Model: r.Model, Room: r.Room, Tags: r.Tags,
		Provisioned: r.Provisioned, Linked: r.LinkedAt != nil || r.Hello != nil, Online: r.Status == "online", Status: r.Status,
		StatusAt: r.StatusAt, LastSeen: r.LastSeen, EventsLost: r.EventsLost, ThumbAt: r.ThumbAt, StreamURL: r.StreamURL,
		HasStreamKey: r.StreamKey != nil && *r.StreamKey != "", MqttUser: r.MqttUser, Hello: r.Hello, State: r.State,
		HelloAt: r.HelloAt, StateAt: r.StateAt, CreatedAt: r.CreatedAt, BootID: r.BootID}
	if r.LastSeen != nil {
		if t, ok := jsx.ParseDate(*r.LastSeen); ok {
			ms := s.now().UnixMilli() - t.UnixMilli()
			v.AgeMs = &ms
		}
	}
	v.Fw, v.API, v.Image = digStr(r.Hello, "fw"), digNum(r.Hello, "api"), digStr(r.Hello, "image")
	if caps := capsOf(r.Hello); caps != nil {
		v.Caps, v.CapsKnown = caps, true
	} else {
		v.Caps = []string{}
	}
	if r.Room != nil && *r.Room != "" {
		p := "/hls/" + pathEscape(app) + "/" + pathEscape(*r.Room) + "/index.m3u8"
		v.HlsPath = &p
	}
	v.HdUntil = s.hdUntil(app, r.Device)
	st := r.State
	v.Summary = CameraSummary{
		Rssi: digNum(st, "net", "rssi"), Ssid: digStr(st, "net", "ssid"), IP: digStr(st, "net", "ip"),
		StreamRunning: digBool(st, "stream", "running"), StreamSource: digNum(st, "stream", "source"), BitrateKbps: digNum(st, "stream", "bitrate_kbps"),
		RecordRunning: digBool(st, "record", "running"),
		SdPresent:     digBool(st, "sd", "present"), SdFreeKb: digNum(st, "sd", "free_kb"), SdTotalKb: digNum(st, "sd", "total_kb"),
		QueueFiles: digNum(st, "queue", "files"), QueueBytes: digNum(st, "queue", "bytes"),
		PtzX: digNum(st, "ptz", "x"), PtzY: digNum(st, "ptz", "y"), PtzMoving: digBool(st, "ptz", "moving"), PtzPreset: digNum(st, "ptz", "preset"),
		MemFreeKb: digNum(st, "health", "mem_free_kb"), Load1: digNum(st, "health", "load1"), SafeMode: digBool(st, "health", "safe_mode"),
		UptimeS: digNum(st, "uptime_s"), LastRebootReason: digStr(st, "health", "last_reboot", "reason"),
		ConfigRev: currentRev(&r),
	}
	return v
}

// List returns the app's cameras (and wakes the subscriber).
func (s *Service) List(ctx context.Context, app string, f ListFilter) (*CamerasList, error) {
	root, active, err := s.EnsureForApp(ctx, app)
	if err != nil {
		return nil, err
	}
	if root == "" {
		root = s.config(ctx, app).BaseTopic
	}
	rows, err := s.store.List(ctx, app, s.apps.AppDir(app))
	if err != nil {
		return nil, err
	}
	out := &CamerasList{Active: active, BaseTopic: root, Cameras: []CameraView{}, GeneratedAt: jsx.ISO(s.now())}
	for _, r := range rows {
		if f.Site != "" && (r.Site == nil || *r.Site != f.Site) {
			continue
		}
		if f.Stand != "" && (r.Stand == nil || *r.Stand != f.Stand) {
			continue
		}
		if f.Tag != "" && !contains(r.Tags, f.Tag) {
			continue
		}
		if f.Online != nil && (r.Status == "online") != *f.Online {
			continue
		}
		out.Cameras = append(out.Cameras, s.view(app, r))
	}
	return out, nil
}

// Get returns one camera's detail (nil when unknown).
func (s *Service) Get(ctx context.Context, app, device string) (*CameraDetail, error) {
	if _, _, err := s.EnsureForApp(ctx, app); err != nil {
		return nil, err
	}
	appDir := s.apps.AppDir(app)
	row, err := s.store.Get(ctx, app, appDir, device)
	if err != nil || row == nil {
		return nil, err
	}
	cfg := s.config(ctx, app)
	hist, err := s.store.History(ctx, app, appDir, device, cfg.HistoryPoints)
	if err != nil {
		return nil, err
	}
	cmds, err := s.store.CommandsFor(ctx, app, appDir, device, 20)
	if err != nil {
		return nil, err
	}
	evs, err := s.store.Events(ctx, app, appDir, device, EventQuery{Limit: 50})
	if err != nil {
		return nil, err
	}
	return &CameraDetail{Camera: s.view(app, *row), History: hist, Commands: cmds, Events: evs}, nil
}

// Events returns a device's event log page.
func (s *Service) Events(ctx context.Context, app, device string, q EventQuery) ([]CamerasEventRow, error) {
	appDir := s.apps.AppDir(app)
	row, err := s.store.Get(ctx, app, appDir, device)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &NotFoundError{fmt.Sprintf("camera '%s' not found", device)}
	}
	return s.store.Events(ctx, app, appDir, device, q)
}

// Thumb returns the retained thumbnail.
func (s *Service) Thumb(ctx context.Context, app, device string) ([]byte, string, error) {
	return s.store.Thumb(ctx, app, s.apps.AppDir(app), device)
}

// Upsert is POST cameras (create=true: alta, 409 when it already was
// provisioned) and PATCH cameras/{device}. An alta mints the per-camera MQTT
// credential (`cam-<device>` + a random password) unless one is given.
func (s *Service) Upsert(ctx context.Context, app, device string, inv Inventory, create bool) (*CameraView, bool, error) {
	if !ValidDevice(device) {
		return nil, false, cmdErr("device must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
	}
	appDir := s.apps.AppDir(app)
	cur, err := s.store.Get(ctx, app, appDir, device)
	if err != nil {
		return nil, false, err
	}
	if create && cur != nil && cur.Provisioned {
		return nil, false, &ConflictError{fmt.Sprintf("camera '%s' already exists", device)}
	}
	if !create && cur == nil {
		return nil, false, &NotFoundError{fmt.Sprintf("camera '%s' not found", device)}
	}
	if create {
		if inv.MqttUser == nil && (cur == nil || cur.MqttUser == nil) {
			u := "cam-" + device
			inv.MqttUser = &u
		}
		if inv.MqttPass == nil && (cur == nil || cur.MqttPass == nil) {
			p := randomSecret()
			inv.MqttPass = &p
		}
	}
	created, err := s.store.Upsert(ctx, app, appDir, device, inv, create)
	if err != nil {
		return nil, false, err
	}
	row, err := s.store.Get(ctx, app, appDir, device)
	if err != nil || row == nil {
		return nil, false, err
	}
	v := s.view(app, *row)
	return &v, created, nil
}

// Delete forgets a camera (inventory, history, commands, events).
func (s *Service) Delete(ctx context.Context, app, device string) (bool, error) {
	return s.store.Delete(ctx, app, s.apps.AppDir(app), device)
}

func randomSecret() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func pathEscape(s string) string {
	r := strings.NewReplacer("%", "%25", "/", "%2F", " ", "%20", "?", "%3F", "#", "%23")
	return r.Replace(s)
}
