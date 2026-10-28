// Package cdp is a minimal Chrome DevTools Protocol driver for the ops
// tooling (cmd/smoke conference, test/bench latency): launch a headless
// Chrome, open one page, evaluate JS, intercept requests, screenshot. It
// replaces the puppeteer-core dependency of the old Node scripts. Never
// imported by the core binary.
package cdp

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// FindChrome returns $PUPPETEER_EXECUTABLE_PATH / $CHROME_PATH or the first
// well-known Chrome/Chromium binary that exists ("" when none).
func FindChrome() string {
	for _, p := range []string{
		os.Getenv("CHROME_PATH"), os.Getenv("PUPPETEER_EXECUTABLE_PATH"),
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
		"/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
	} {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// Browser is a headless Chrome process.
type Browser struct {
	cmd     *exec.Cmd
	dataDir string
	port    string
}

var devtoolsLine = regexp.MustCompile(`DevTools listening on ws://127\.0\.0\.1:(\d+)/`)

// Launch starts chrome headless with extra flags and waits for DevTools.
func Launch(ctx context.Context, chrome string, flags ...string) (*Browser, error) {
	dir, err := os.MkdirTemp("", "sh-cdp-*")
	if err != nil {
		return nil, err
	}
	args := append([]string{
		"--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir,
		"--no-first-run", "--no-default-browser-check", "about:blank",
	}, flags...)
	cmd := exec.CommandContext(ctx, chrome, args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	b := &Browser{cmd: cmd, dataDir: dir}
	found := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			if m := devtoolsLine.FindStringSubmatch(sc.Text()); m != nil {
				select {
				case found <- m[1]:
				default:
				}
			}
		}
	}()
	select {
	case b.port = <-found:
		return b, nil
	case <-time.After(20 * time.Second):
		b.Close()
		return nil, errors.New("chrome did not expose DevTools within 20s")
	}
}

// Close kills Chrome and removes its profile.
func (b *Browser) Close() {
	if b.cmd.Process != nil {
		_ = b.cmd.Process.Kill()
		_ = b.cmd.Wait()
	}
	os.RemoveAll(b.dataDir)
}

// NewPage opens a blank tab and attaches to it.
func (b *Browser) NewPage(ctx context.Context) (*Page, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPut, "http://127.0.0.1:"+b.port+"/json/new?about:blank", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var t struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(res.Body).Decode(&t); err != nil || t.WebSocketDebuggerURL == "" {
		return nil, fmt.Errorf("open tab: %v", err)
	}
	conn, _, err := websocket.Dial(ctx, t.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(64 << 20)
	p := &Page{conn: conn, pending: map[int64]chan reply{}, events: map[string][]func(json.RawMessage){}}
	go p.readLoop()
	return p, nil
}

// Page is one attached tab.
type Page struct {
	conn    *websocket.Conn
	mu      sync.Mutex
	seq     int64
	pending map[int64]chan reply
	events  map[string][]func(json.RawMessage)
}

type reply struct {
	Result json.RawMessage
	Err    error
}

type message struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (p *Page) readLoop() {
	for {
		_, data, err := p.conn.Read(context.Background())
		if err != nil {
			p.mu.Lock()
			for id, ch := range p.pending {
				ch <- reply{Err: err}
				delete(p.pending, id)
			}
			p.mu.Unlock()
			return
		}
		var m message
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.ID != 0 {
			p.mu.Lock()
			ch := p.pending[m.ID]
			delete(p.pending, m.ID)
			p.mu.Unlock()
			if ch != nil {
				r := reply{Result: m.Result}
				if m.Error != nil {
					r.Err = errors.New(m.Error.Message)
				}
				ch <- r
			}
			continue
		}
		p.mu.Lock()
		hs := append([]func(json.RawMessage){}, p.events[m.Method]...)
		p.mu.Unlock()
		for _, h := range hs {
			go h(m.Params)
		}
	}
}

// On registers an event handler (e.g. "Runtime.exceptionThrown").
func (p *Page) On(method string, h func(params json.RawMessage)) {
	p.mu.Lock()
	p.events[method] = append(p.events[method], h)
	p.mu.Unlock()
}

// Call sends a CDP command and waits for its result.
func (p *Page) Call(ctx context.Context, method string, params any, out any) error {
	p.mu.Lock()
	p.seq++
	id := p.seq
	ch := make(chan reply, 1)
	p.pending[id] = ch
	p.mu.Unlock()
	if params == nil {
		params = struct{}{}
	}
	b, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err := p.conn.Write(ctx, websocket.MessageText, b); err != nil {
		return err
	}
	select {
	case r := <-ch:
		if r.Err != nil {
			return fmt.Errorf("%s: %w", method, r.Err)
		}
		if out != nil {
			return json.Unmarshal(r.Result, out)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Navigate loads url.
func (p *Page) Navigate(ctx context.Context, url string) error {
	var r struct {
		ErrorText string `json:"errorText"`
	}
	if err := p.Call(ctx, "Page.navigate", map[string]any{"url": url}, &r); err != nil {
		return err
	}
	if r.ErrorText != "" {
		return errors.New("navigate: " + r.ErrorText)
	}
	return nil
}

// Eval evaluates expr (promises awaited) and decodes its JSON value into out.
func (p *Page) Eval(ctx context.Context, expr string, out any) error {
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	err := p.Call(ctx, "Runtime.evaluate", map[string]any{"expression": expr, "returnByValue": true, "awaitPromise": true}, &r)
	if err != nil {
		return err
	}
	if r.ExceptionDetails != nil {
		return fmt.Errorf("eval: %s %s", r.ExceptionDetails.Text, r.ExceptionDetails.Exception.Description)
	}
	if out != nil && len(r.Result.Value) > 0 {
		return json.Unmarshal(r.Result.Value, out)
	}
	return nil
}

// WaitTrue polls a boolean JS expression until true or timeout.
func (p *Page) WaitTrue(ctx context.Context, expr string, timeout, every time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var ok bool
		if err := p.Eval(ctx, "!!("+expr+")", &ok); err == nil && ok {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for %s", expr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
}

// Screenshot returns a PNG of the viewport.
func (p *Page) Screenshot(ctx context.Context) ([]byte, error) {
	var r struct {
		Data string `json:"data"`
	}
	if err := p.Call(ctx, "Page.captureScreenshot", map[string]any{"format": "png"}, &r); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(r.Data)
}

// Request is a paused request (Fetch.requestPaused).
type Request struct {
	ID  string
	URL string
}

// Intercept pauses every request and lets decide answer it: return
// (body, contentType, true) to fulfill with 200, ("", "", false) with
// pass=true to continue, or block it otherwise.
func (p *Page) Intercept(ctx context.Context, decide func(Request) (body, contentType string, fulfill, pass bool)) error {
	p.On("Fetch.requestPaused", func(raw json.RawMessage) {
		var ev struct {
			RequestID string `json:"requestId"`
			Request   struct {
				URL string `json:"url"`
			} `json:"request"`
		}
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		body, ct, fulfill, pass := decide(Request{ev.RequestID, ev.Request.URL})
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		switch {
		case fulfill:
			_ = p.Call(c, "Fetch.fulfillRequest", map[string]any{
				"requestId": ev.RequestID, "responseCode": 200,
				"responseHeaders": []map[string]string{{"name": "Content-Type", "value": ct}},
				"body":            base64.StdEncoding.EncodeToString([]byte(body)),
			}, nil)
		case pass:
			_ = p.Call(c, "Fetch.continueRequest", map[string]any{"requestId": ev.RequestID}, nil)
		default:
			_ = p.Call(c, "Fetch.failRequest", map[string]any{"requestId": ev.RequestID, "errorReason": "BlockedByClient"}, nil)
		}
	})
	return p.Call(ctx, "Fetch.enable", map[string]any{"patterns": []map[string]string{{"urlPattern": "*"}}}, nil)
}

// CollectErrors records uncaught page exceptions (pageerror) and console
// messages (onConsole may be nil).
func (p *Page) CollectErrors(ctx context.Context, onConsole func(string)) (func() []string, error) {
	var mu sync.Mutex
	var errs []string
	p.On("Runtime.exceptionThrown", func(raw json.RawMessage) {
		var ev struct {
			ExceptionDetails struct {
				Text      string `json:"text"`
				Exception struct {
					Description string `json:"description"`
				} `json:"exception"`
			} `json:"exceptionDetails"`
		}
		_ = json.Unmarshal(raw, &ev)
		d := strings.TrimSpace(ev.ExceptionDetails.Text + " " + ev.ExceptionDetails.Exception.Description)
		mu.Lock()
		errs = append(errs, d)
		mu.Unlock()
	})
	if onConsole != nil {
		p.On("Runtime.consoleAPICalled", func(raw json.RawMessage) {
			var ev struct {
				Args []struct {
					Value any `json:"value"`
				} `json:"args"`
			}
			_ = json.Unmarshal(raw, &ev)
			var parts []string
			for _, a := range ev.Args {
				parts = append(parts, fmt.Sprint(a.Value))
			}
			onConsole(strings.Join(parts, " "))
		})
	}
	if err := p.Call(ctx, "Runtime.enable", nil, nil); err != nil {
		return nil, err
	}
	if err := p.Call(ctx, "Page.enable", nil, nil); err != nil {
		return nil, err
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), errs...)
	}, nil
}

// SetViewport fixes the device metrics.
func (p *Page) SetViewport(ctx context.Context, w, h int) error {
	return p.Call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{"width": w, "height": h, "deviceScaleFactor": 1, "mobile": false}, nil)
}

// Close detaches.
func (p *Page) Close() { _ = p.conn.Close(websocket.StatusNormalClosure, "") }
