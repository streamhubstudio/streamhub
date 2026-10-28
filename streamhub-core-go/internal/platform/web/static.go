// Package web mounts every non-API HTTP surface the core serves, mirroring the
// express mounts in streamhub-core/src/main.ts and the SPA ServeStaticModule:
//
//	/hls/<app>/<room>/<file>  → <DATA_DIR>/apps/<app>/hls/<room>/<file>   (public)
//	/samples/<app>/<file>     → <DATA_DIR>/apps/<app>/samples/<file>       (public, sandboxed)
//	/sdk/<file>               → $SDK_DIR or <DATA_DIR>/sdk                  (public)
//	/*                        → the React SPA (index.html fallback)
//
// Static files go through http.ServeContent (sendfile on Linux), so viewer
// fan-out costs a goroutine each instead of time on a shared event loop.
package web

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// ByteCounter receives bytes served under /hls, attributed to an app
// (net-metrics). Optional.
type ByteCounter interface {
	CountHLS(app string, bytes int64)
}

// Options configures the mounts.
type Options struct {
	DataDir string
	SDKDir  string // default <DataDir>/sdk
	WebDir  string // SPA build dir (index.html + assets)
	HLSCDN  bool   // STREAMHUB_HLS_CDN
	Counter ByteCounter
}

// Mount registers the static surfaces on mux. The SPA handler is the "/"
// catch-all, so it must be the only "/" registration.
func Mount(mux *http.ServeMux, o Options) {
	appsRoot := filepath.Join(o.DataDir, "apps")
	sdkDir := o.SDKDir
	if sdkDir == "" {
		sdkDir = filepath.Join(o.DataDir, "sdk")
	}
	_ = os.MkdirAll(sdkDir, 0o775)

	mux.Handle("/hls/", hlsHandler(appsRoot, o.HLSCDN, o.Counter))
	mux.Handle("/samples/", samplesHandler(appsRoot))
	mux.Handle("/sdk/", sdkHandler(sdkDir))
	mux.Handle("/", spaHandler(o.WebDir))
}

// ---------------------------------------------------------------------------
// /hls
// ---------------------------------------------------------------------------

var hlsPath = regexp.MustCompile(`^/hls/([^/]+)/([^/]+)/(.+)$`)

func hlsHandler(appsRoot string, cdn bool, counter ByteCounter) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		notFound := func() {
			httpx.WriteError(w, httpx.Enveloped(http.StatusNotFound, "not_found", "HLS resource not found"))
		}
		m := hlsPath.FindStringSubmatch(r.URL.Path)
		if m == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			notFound()
			return
		}
		file, ok := safeJoin(appsRoot, m[1], "hls", m[2], m[3])
		if !ok {
			notFound()
			return
		}
		for k, v := range HLSCacheHeaders(file, cdn, strings.HasSuffix(file, ".m3u8") && playlistIsFinished(file)) {
			h.Set(k, v)
		}
		cw := w
		var counted *countingWriter
		if counter != nil {
			counted = &countingWriter{ResponseWriter: w}
			cw = counted
		}
		if !serveFile(cw, r, file) {
			h.Del("Cache-Control")
			notFound()
			return
		}
		if counted != nil && counted.n > 0 {
			counter.CountHLS(m[1], counted.n)
		}
	})
}

// ---------------------------------------------------------------------------
// /samples
// ---------------------------------------------------------------------------

var samplesPath = regexp.MustCompile(`^/samples/([^/]+)/([^/?#]+)`)

func samplesHandler(appsRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		notFound := func() {
			httpx.WriteError(w, httpx.Enveloped(http.StatusNotFound, "not_found", "sample not found"))
		}
		m := samplesPath.FindStringSubmatch(r.URL.Path)
		if m == nil {
			notFound()
			return
		}
		file, ok := safeJoin(appsRoot, m[1], "samples", m[2])
		if !ok {
			notFound()
			return
		}
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if strings.HasSuffix(file, ".html") || strings.HasSuffix(file, ".htm") {
			// Sandboxed but same-origin: samples fetch their public play token
			// and call getUserMedia(), both denied under an opaque origin.
			h.Set("Content-Security-Policy",
				"sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-modals; frame-ancestors *")
			h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
		} else {
			h.Set("Cache-Control", "public, max-age=60")
		}
		if !serveFile(w, r, file) {
			for _, k := range []string{"Content-Security-Policy", "Cache-Control"} {
				h.Del(k)
			}
			notFound()
		}
	})
}

// ---------------------------------------------------------------------------
// /sdk
// ---------------------------------------------------------------------------

func sdkHandler(sdkDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/sdk/")
		file, ok := safeJoin(sdkDir, rel)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "public, max-age=300")
		if !serveFile(w, r, file) {
			w.Header().Del("Cache-Control")
			http.NotFound(w, r) // express.static fallthrough:false → plain 404
		}
	})
}

// ---------------------------------------------------------------------------
// SPA
// ---------------------------------------------------------------------------

// apiPrefixes never fall back to index.html (ServeStaticModule exclude list);
// unknown paths under them get Nest's "Cannot METHOD path" 404.
var apiPrefixes = []string{"/api/", "/rtc/", "/hls/", "/live/", "/samples/", "/sdk/"}

func spaHandler(webDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		excluded := p == "/metrics" || p == "/api" || p == "/rtc"
		for _, pre := range apiPrefixes {
			if strings.HasPrefix(p, pre) {
				excluded = true
				break
			}
		}
		if excluded || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
			httpx.WriteError(w, httpx.Nest(http.StatusNotFound, fmt.Sprintf("Cannot %s %s", r.Method, p)))
			return
		}
		if file, ok := safeJoin(webDir, strings.TrimPrefix(p, "/")); ok && p != "/" && serveFile(w, r, file) {
			return
		}
		if !serveFile(w, r, filepath.Join(webDir, "index.html")) {
			httpx.WriteError(w, httpx.Nest(http.StatusNotFound, fmt.Sprintf("Cannot %s %s", r.Method, p)))
		}
	})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// safeJoin joins URL segments under root, rejecting traversal and dotfiles.
func safeJoin(root string, segs ...string) (string, bool) {
	rel := path.Clean("/" + path.Join(segs...))
	for _, part := range strings.Split(rel, "/") {
		if strings.HasPrefix(part, ".") {
			return "", false
		}
	}
	return filepath.Join(root, filepath.FromSlash(rel)), true
}

// serveFile serves a regular file (Range/HEAD/conditional handled by
// ServeContent). Returns false when the file is missing or a directory.
func serveFile(w http.ResponseWriter, r *http.Request, file string) bool {
	f, err := os.Open(file)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return false
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
	return true
}

type countingWriter struct {
	http.ResponseWriter
	n int64
}

func (c *countingWriter) Write(b []byte) (int, error) {
	n, err := c.ResponseWriter.Write(b)
	c.n += int64(n)
	return n, err
}
