package wsingest

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

type denyGuard struct{ ip string }

func (d denyGuard) RejectUpgradeReason(ip string) string {
	if ip == d.ip {
		return "banned"
	}
	return ""
}

// server mounts the gateway like the core does (middleware ahead of a mux
// whose fallback answers 418, so pass-through is observable).
func (f *fixture) server(t *testing.T, guard UpgradeGuard) *httptest.Server {
	ctx, cancel := context.WithCancel(context.Background())
	gw := NewGateway(ctx, f.svc, NewLiveHTTP(f.svc), guard, testutil.Log())
	srv := httptest.NewServer(gw.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})))
	t.Cleanup(func() { cancel(); srv.Close() })
	return srv
}

func wsURL(srv *httptest.Server, path string) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + path
}

func TestIntegrationIngestToViewers(t *testing.T) {
	f := newFixture(t)
	f.svc.now = time.Now // real clock: the fps bucket refills
	srv := f.server(t, nil)
	key := f.mint("live-cam1")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Camera connects (Bearer header) and gets `ready`.
	cam, _, err := websocket.Dial(ctx, wsURL(srv, "/ingest/ws?app=live&room=cam1"), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + key}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cam.CloseNow()
	_, msg, err := cam.Read(ctx)
	var ready map[string]any
	if err != nil || json.Unmarshal(msg, &ready) != nil || ready["type"] != "ready" {
		t.Fatalf("%s %v", msg, err)
	}

	// A WS viewer and an MJPEG HTTP viewer subscribe.
	viewer, _, err := websocket.Dial(ctx, wsURL(srv, "/live/ws?app=live&room=cam1"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.CloseNow()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/live/live/cam1/mjpeg", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	mt, params, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if res.StatusCode != 200 || mt != "multipart/x-mixed-replace" || params["boundary"] != "frame" ||
		res.Header.Get("X-Accel-Buffering") != "no" || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("%d %v", res.StatusCode, res.Header)
	}
	waitFor(t, func() bool { return f.svc.Hub().ViewerCount(testApp, "live-cam1") == 2 })

	frame := jpeg(64)
	frame[10] = 42
	if err := cam.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatal(err)
	}
	typ, got, err := viewer.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || len(got) != 64 || got[10] != 42 {
		t.Fatalf("viewer: %v %d", err, len(got))
	}
	part, err := multipart.NewReader(bufio.NewReader(res.Body), "frame").NextPart()
	if err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 64) // the part only ends at the next boundary
	if _, err := io.ReadFull(part, body); err != nil {
		t.Fatal(err)
	}
	if part.Header.Get("Content-Type") != "image/jpeg" || part.Header.Get("Content-Length") != "64" || len(body) != 64 || body[10] != 42 {
		t.Fatalf("mjpeg part %v %d", part.Header, len(body))
	}

	// frame.jpg serves the last frame (already-namespaced room works too).
	fr, err := http.Get(srv.URL + "/live/live/live-cam1/frame.jpg")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(fr.Body)
	fr.Body.Close()
	if fr.StatusCode != 200 || fr.Header.Get("Content-Type") != "image/jpeg" || fr.Header.Get("Content-Length") != "64" || len(b) != 64 {
		t.Fatalf("frame.jpg %d %v", fr.StatusCode, fr.Header)
	}

	// Camera disconnect → stream ended, publisher cleared.
	cam.Close(websocket.StatusNormalClosure, "bye")
	waitFor(t, func() bool { return f.streams.endCount() == 1 && !f.svc.Hub().HasPublisher(testApp, "live-cam1") })

	// Viewer disconnect → unsubscribed.
	viewer.CloseNow()
	cancel()
	waitFor(t, func() bool { return f.svc.Hub().ViewerCount(testApp, "live-cam1") == 0 })
}

func TestIntegrationRejectionsAndRouting(t *testing.T) {
	f := newFixture(t)
	srv := f.server(t, denyGuard{"203.0.113.66"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Protocol rejection: error JSON then close 4401.
	c, _, err := websocket.Dial(ctx, wsURL(srv, "/ingest/ws?app=live&room=cam1&key=wsk_bad"), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, msg, _ := c.Read(ctx)
	if string(msg) != `{"type":"error","code":"4401","message":"invalid_key"}` {
		t.Fatal(string(msg))
	}
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != 4401 {
		t.Fatalf("close status %v", err)
	}

	// Banned IP → bare 403 before the upgrade.
	_, res, err := websocket.Dial(ctx, wsURL(srv, "/live/ws?app=live&room=cam1"), &websocket.DialOptions{
		HTTPHeader: http.Header{"X-Forwarded-For": {"203.0.113.66, 10.0.0.1"}},
	})
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %v", err)
	}

	// /live HTTP gates.
	for path, want := range map[string]int{
		"/live/ghost/cam1/mjpeg":    404,
		"/live/live/cam1/frame.jpg": 404, // no frame yet
		"/live/live/cam1":           404,
		"/live":                     404,
		"/live/ws":                  404, // no upgrade → terminal /live 404
		"/ingest/ws":                418, // no upgrade → falls through
		"/livex":                    418,
	} {
		r, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != want {
			t.Errorf("%s: %d", path, r.StatusCode)
		}
		if want == 404 && (string(b) != `{"data":null,"error":{"code":"not_found","message":"live resource not found"}}` || r.Header.Get("Content-Type") != "application/json") {
			t.Errorf("%s: %s %s", path, b, r.Header.Get("Content-Type"))
		}
	}
	f.apps.cfg.Features.PublicPlayback = false
	r, _ := http.Get(srv.URL + "/live/live/cam1/frame.jpg")
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 401 || string(b) != `{"data":null,"error":{"code":"unauthorized","message":"play token required"}}` {
		t.Fatalf("%d %s", r.StatusCode, b)
	}
}
