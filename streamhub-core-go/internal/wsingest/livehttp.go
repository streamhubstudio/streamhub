package wsingest

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Port of live-http.ts — playback without transcode:
//
//	GET /live/<app>/<room>/mjpeg      multipart/x-mixed-replace (works in <img>)
//	GET /live/<app>/<room>/frame.jpg  last frame
//
// Terminal for the whole /live prefix (unknown paths 404 as JSON, never the
// SPA). Auth mirrors /play. Each HTTP viewer is drained by its own handler
// goroutine from a drop-oldest queue, so a slow client never blocks others.

const boundary = "frame"

var livePathRE = regexp.MustCompile(`^/([^/]+)/([^/]+)/(mjpeg|frame\.jpg)$`)

// LiveHTTP is LiveHttpService.
type LiveHTTP struct {
	svc *Service
}

// NewLiveHTTP builds the /live handler.
func NewLiveHTTP(svc *Service) *LiveHTTP { return &LiveHTTP{svc: svc} }

// rawWriter strips the Express content-type normalizer: these responses are
// written with res.writeHead in Node ("application/json", no charset).
func rawWriter(w http.ResponseWriter) http.ResponseWriter {
	for {
		if fmt.Sprintf("%T", w) != "*httpx.ctWriter" {
			return w
		}
		u, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			return w
		}
		w = u.Unwrap()
	}
}

// ServeHTTP handles every request under /live.
func (l *LiveHTTP) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w := rawWriter(rw)
	// Path relative to the /live mount, still escaped (decoded per segment).
	rel := strings.TrimPrefix(r.URL.EscapedPath(), "/live")
	m := livePathRE.FindStringSubmatch(rel)
	if m == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		notFound(w)
		return
	}
	app, err1 := url.PathUnescape(m[1])
	room, err2 := url.PathUnescape(m[2])
	if err1 != nil || err2 != nil {
		notFound(w)
		return
	}
	ctx := r.Context()
	nsRoom, cfg, ok := l.svc.ResolveRoom(ctx, app, room)
	if !ok {
		notFound(w)
		return
	}
	if !l.svc.PlaybackAllowed(cfg, nsRoom, r.URL.Query().Get("token")) {
		writeJSON(w, http.StatusUnauthorized, `{"data":null,"error":{"code":"unauthorized","message":"play token required"}}`)
		return
	}
	if m[3] == "frame.jpg" {
		l.serveFrame(w, r, app, nsRoom)
		return
	}
	l.serveMjpeg(w, r, app, nsRoom)
}

func (l *LiveHTTP) serveFrame(w http.ResponseWriter, r *http.Request, app, room string) {
	frame, _ := l.svc.d.Hub.LastFrame(app, room)
	if frame == nil {
		notFound(w)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/jpeg")
	h.Set("Content-Length", strconv.Itoa(len(frame)))
	h.Set("Cache-Control", "no-store, no-cache, must-revalidate")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(frame)
	}
}

func (l *LiveHTTP) serveMjpeg(w http.ResponseWriter, r *http.Request, app, room string) {
	h := w.Header()
	h.Set("Content-Type", "multipart/x-mixed-replace; boundary="+boundary)
	h.Set("Cache-Control", "no-store, no-cache, must-revalidate")
	h.Set("Pragma", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	_ = rc.Flush()
	if r.Method == http.MethodHead {
		return
	}

	hub, met := l.svc.d.Hub, l.svc.d.Metrics
	v := NewViewer("http")
	hub.Subscribe(app, room, v)
	met.SetViewers(app, "http", hub.ViewerCount(app, room))
	defer func() {
		hub.Unsubscribe(app, room, v)
		met.SetViewers(app, "http", hub.ViewerCount(app, room))
	}()
	for {
		select {
		case <-r.Context().Done():
			return
		case f, ok := <-v.C:
			if !ok {
				return
			}
			if _, err := w.Write(multipartPart(f)); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		}
	}
}

// multipartPart is one multipart/x-mixed-replace part.
func multipartPart(frame []byte) []byte {
	head := "--" + boundary + "\r\nContent-Type: image/jpeg\r\nContent-Length: " + strconv.Itoa(len(frame)) + "\r\n\r\n"
	out := make([]byte, 0, len(head)+len(frame)+2)
	out = append(out, head...)
	out = append(out, frame...)
	return append(out, '\r', '\n')
}

func notFound(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, `{"data":null,"error":{"code":"not_found","message":"live resource not found"}}`)
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}
