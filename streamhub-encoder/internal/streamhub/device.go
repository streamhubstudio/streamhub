package streamhub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// ── pairing (device-code flow) ──────────────────────────────────────────────

// PairStartRequest is POST /api/v1/devices/pair/start.
type PairStartRequest struct {
	Model   string `json:"model,omitempty"`
	Version string `json:"version,omitempty"`
	Serial  string `json:"serial,omitempty"`
}

// PairStart is its answer.
type PairStart struct {
	DeviceID     string `json:"deviceId"`
	Code         string `json:"code"`
	DisplayCode  string `json:"displayCode"`
	PollToken    string `json:"pollToken"`
	ExpiresAt    string `json:"expiresAt"`
	PollInterval int    `json:"pollInterval"`
}

// PairPoll is GET /api/v1/devices/pair/{deviceId}?token=.
type PairPoll struct {
	Status     string `json:"status"` // pending|claimed
	ExpiresAt  string `json:"expiresAt,omitempty"`
	DeviceID   string `json:"deviceId,omitempty"`
	Credential string `json:"credential,omitempty"`
	WSURL      string `json:"wsUrl,omitempty"`
	App        string `json:"app,omitempty"`
}

// ErrPairingExpired is the 404 of the poll (expired/unknown/already delivered).
var ErrPairingExpired = errors.New("pairing expired or unknown")

// StartPairing begins the device-code flow.
func StartPairing(ctx context.Context, hc *http.Client, base string, req PairStartRequest) (PairStart, error) {
	c := &Client{BaseURL: base, HTTP: hc}
	var out PairStart
	err := c.do(ctx, http.MethodPost, "/api/v1/devices/pair/start", req, &out)
	if err == nil && (out.DeviceID == "" || out.PollToken == "" || out.Code == "") {
		err = errors.New("pair/start: incomplete answer")
	}
	if out.PollInterval <= 0 {
		out.PollInterval = 5
	}
	if out.DisplayCode == "" {
		out.DisplayCode = out.Code
	}
	return out, err
}

// PollPairing asks whether the code was claimed.
func PollPairing(ctx context.Context, hc *http.Client, base, deviceID, token string) (PairPoll, error) {
	c := &Client{BaseURL: base, HTTP: hc}
	var out PairPoll
	err := c.do(ctx, http.MethodGet, "/api/v1/devices/pair/"+url.PathEscape(deviceID)+"?token="+url.QueryEscape(token), nil, &out)
	if errors.Is(err, ErrNotFound) {
		return out, ErrPairingExpired
	}
	if err == nil && out.Status == "claimed" && (out.Credential == "" || out.WSURL == "") {
		err = errors.New("pair poll: claimed without credential/wsUrl")
	}
	return out, err
}

// ── control channel frames ──────────────────────────────────────────────────

// Hello is device→core, first frame.
type Hello struct {
	Type         string         `json:"type"`
	Model        string         `json:"model"`
	Version      string         `json:"version"`
	Serial       string         `json:"serial"`
	Capabilities map[string]any `json:"capabilities"`
}

// ChannelRef is one channel advertised in hello.capabilities.channels.
type ChannelRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// StatusFrame is device→core, every 5–15 s.
type StatusFrame struct {
	Type        string          `json:"type"`
	CPU         float64         `json:"cpu"`
	GPU         *float64        `json:"gpu"`
	Temperature *float64        `json:"temperature,omitempty"`
	UptimeSec   int64           `json:"uptimeSec"`
	Channels    []ChannelStatus `json:"channels"`
	Errors      []string        `json:"errors"`
}

// ChannelStatus is one entry of StatusFrame.channels.
type ChannelStatus struct {
	ID          string  `json:"id"`
	State       string  `json:"state"` // idle|starting|live|reconnecting|error|stopped
	BitrateKbps float64 `json:"bitrateKbps"`
	FPS         float64 `json:"fps"`
	Input       string  `json:"input,omitempty"`
	Error       *string `json:"error"`
}

// ConfigFrame is core→device desired state.
type ConfigFrame struct {
	Rev    int64 `json:"rev"`
	Device struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		App  string `json:"app"`
	} `json:"device"`
	Channels []ConfigChannel `json:"channels"`
}

// ConfigChannel is one publish target.
type ConfigChannel struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	Room       string `json:"room"`
	Protocol   string `json:"protocol"` // rtmp|srt
	PublishURL string `json:"publishUrl"`
	StreamKey  string `json:"streamKey"`
	IngressID  string `json:"ingressId"`
}

// Command is core→device.
type Command struct {
	ID      string `json:"id"`
	Action  string `json:"action"` // start|stop|restart|apply_preset|reboot
	Channel string `json:"channel,omitempty"`
	Preset  string `json:"preset,omitempty"`
}

// CommandResult is device→core.
type CommandResult struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// Handler is the encoder side the link drives.
type Handler interface {
	Hello() Hello
	Status() StatusFrame
	ApplyConfig(ConfigFrame) error
	Command(Command) (ok bool, message string)
}

// Close codes of the device WS.
const (
	CloseRevoked  = 4401 // credential revoked: stop and re-pair
	CloseReplaced = 4409 // a newer connection replaced this one
)

// ErrRevoked ends Link.Run: the device must pair again.
var ErrRevoked = errors.New("device credential revoked (4401)")

// Link keeps the outbound control WebSocket up.
type Link struct {
	WSURL      string
	Credential string
	Handler    Handler
	HTTP       *http.Client
	// StatusEvery is the status cadence (default 10 s).
	StatusEvery time.Duration
	// OnState reports connection state changes ("connecting", "connected",
	// "disconnected: …", "revoked").
	OnState func(state string)

	mu      sync.Mutex
	lastRev int64
}

func (l *Link) state(s string) {
	if l.OnState != nil {
		l.OnState(s)
	}
}

// Run connects and reconnects with backoff until ctx ends or the credential
// is revoked (ErrRevoked).
func (l *Link) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		l.state("connecting")
		start := time.Now()
		err := l.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrRevoked) {
			l.state("revoked")
			return err
		}
		wait := backoff
		if websocket.CloseStatus(err) == CloseReplaced {
			wait = 30 * time.Second // another box with our credential: don't flap
		}
		l.state("disconnected: " + errString(err))
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		if backoff *= 2; backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func errString(err error) string {
	if err == nil {
		return "closed"
	}
	return err.Error()
}

func (l *Link) session(ctx context.Context) error {
	hdr := http.Header{}
	hdr.Set("Authorization", "Device "+l.Credential)
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, resp, err := websocket.Dial(dctx, l.WSURL, &websocket.DialOptions{HTTPHeader: hdr, HTTPClient: l.HTTP})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return ErrRevoked
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	l.state("connected")

	sctx, scancel := context.WithCancel(ctx)
	defer scancel()
	var wmu sync.Mutex
	send := func(v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		wmu.Lock()
		defer wmu.Unlock()
		wctx, c := context.WithTimeout(sctx, 10*time.Second)
		defer c()
		return conn.Write(wctx, websocket.MessageText, b)
	}
	h := l.Handler.Hello()
	h.Type = "hello"
	if err := send(h); err != nil {
		return err
	}
	every := l.StatusEvery
	if every == 0 {
		every = 10 * time.Second
	}
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			st := l.Handler.Status()
			st.Type = "status"
			if send(st) != nil {
				return
			}
			select {
			case <-sctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == CloseRevoked {
				return ErrRevoked
			}
			return err
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &head) != nil {
			continue
		}
		switch head.Type {
		case "config":
			var cf ConfigFrame
			if err := json.Unmarshal(data, &cf); err != nil {
				continue
			}
			l.mu.Lock()
			stale := cf.Rev != 0 && cf.Rev < l.lastRev
			if !stale {
				l.lastRev = cf.Rev
			}
			l.mu.Unlock()
			if stale {
				continue
			}
			// An apply error is surfaced in the next status frame (errors[]).
			_ = l.Handler.ApplyConfig(cf)
			// report the effect right away
			st := l.Handler.Status()
			st.Type = "status"
			_ = send(st)
		case "command":
			var c Command
			if err := json.Unmarshal(data, &c); err != nil {
				continue
			}
			go func(c Command) {
				ok, msg := l.Handler.Command(c)
				_ = send(CommandResult{Type: "command_result", ID: c.ID, OK: ok, Message: msg})
			}(c)
		case "pong", "error":
			// error frames are informational ({message}); nothing to do
		default:
		}
	}
}

// LastRev is the last applied config revision.
func (l *Link) LastRev() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastRev
}

// SetLastRev seeds the revision (persisted across restarts).
func (l *Link) SetLastRev(r int64) {
	l.mu.Lock()
	l.lastRev = r
	l.mu.Unlock()
}

// SplitSRTPublish turns srt://host:port?streamid=X into (srt://host:port, X).
func SplitSRTPublish(raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "srt" || u.Host == "" {
		return "", "", fmt.Errorf("invalid SRT publish URL %q", raw)
	}
	sid := u.Query().Get("streamid")
	return "srt://" + u.Host, sid, nil
}

// NormalizeProtocol maps a config protocol to an output type.
func NormalizeProtocol(p string) string { return strings.ToLower(strings.TrimSpace(p)) }
