package web

import (
	"bytes"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
)

// HLSGate decides whether one /hls request may be served (G2: signed HLS for
// private apps + geo-blocking). Implemented by playback.Guard; nil = every
// request passes (the pre-3.4 public mount).
type HLSGate interface {
	AuthorizeHLS(r *http.Request, app, dir string) HLSDecision
}

// HLSDecision is the gate's verdict for (app, room dir).
type HLSDecision struct {
	// Status is 0 when allowed, else the HTTP status to answer (403).
	Status  int
	Code    string
	Message string
	// Private: the app requires the ?st= token. Its playlists are then
	// rewritten with Token and nothing is marked publicly cacheable.
	Private bool
	// Token is the validated st the request carried (propagated verbatim into
	// the playlist — never re-minted, so a token cannot outlive its exp).
	Token string
}

// HLSScopeHeader is the /hls-auth answer header (public | private) the
// direct-serve proxies derive the segment Cache-Control from.
const HLSScopeHeader = "X-StreamHub-HLS-Scope"

// Allowed reports whether the request may be served.
func (d HLSDecision) Allowed() bool { return d.Status == 0 }

func writeDenied(w http.ResponseWriter, d HLSDecision) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteError(w, httpx.Enveloped(d.Status, d.Code, d.Message))
}

// privateCacheHeaders overrides the public cache policy for a private app:
// a shared cache (CDN, the nginx HLS edge) must never store a tokenized
// object it could hand to someone without the token.
func privateCacheHeaders(h http.Header, file string) {
	switch {
	case strings.HasSuffix(file, ".m3u8"):
		h.Set("Cache-Control", "private, no-cache, no-store, must-revalidate")
	default:
		h.Set("Cache-Control", "private, max-age=31536000, immutable")
	}
}

// serveRewrittenPlaylist serves a private playlist with every relative URI
// tokenized (see playback.RewritePlaylist), through ServeContent so HEAD /
// Range / conditional requests behave like the plain file.
func serveRewrittenPlaylist(w http.ResponseWriter, r *http.Request, file string, rewrite func([]byte) []byte) bool {
	f, err := os.Open(file)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return false
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(f); err != nil {
		return false
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), bytes.NewReader(rewrite(buf.Bytes())))
	return true
}

// hlsAuthHandler is GET /hls-auth: the subrequest target of the direct-serve
// proxies (nginx auth_request, Caddy forward_auth) that serve HLS segments
// straight from disk. The original URI rides in X-Original-URI (nginx; the
// Caddyfile sets it too) or X-Forwarded-Uri (Caddy's forward_auth default);
// the client IP in X-Forwarded-For like any proxied request. 204 = serve it,
// 403 = deny (Caddy relays the body; nginx answers its own 403). Anything that
// is not an /hls/<app>/<room>/<file> URI is denied — the proxy only asks for
// those, so failing closed costs nothing. It reveals no more than requesting
// the URI itself would.
func hlsAuthHandler(gate HLSGate) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		deny := HLSDecision{Status: http.StatusForbidden, Code: "forbidden", Message: "HLS request not authorized"}
		raw := r.Header.Get("X-Original-URI")
		if raw == "" {
			raw = r.Header.Get("X-Forwarded-Uri")
		}
		u, err := url.ParseRequestURI(raw)
		if raw == "" || err != nil {
			writeDenied(w, deny)
			return
		}
		// Match on the CLEANED path, like nginx/Caddy match their location on
		// the normalized URI: "/hls/pub/x/../../priv/r/s.ts" must be judged as
		// app "priv" (what the proxy will serve from disk), never as "pub".
		m := hlsPath.FindStringSubmatch(path.Clean(u.Path))
		if m == nil {
			writeDenied(w, deny)
			return
		}
		if _, ok := safeJoin("/", m[1], "hls", m[2], m[3]); !ok {
			writeDenied(w, deny)
			return
		}
		orig := r.Clone(r.Context())
		orig.URL = u
		d := gate.AuthorizeHLS(orig, m[1], m[2])
		if !d.Allowed() {
			writeDenied(w, d)
			return
		}
		// The proxy picks its Cache-Control from this (auth_request_set /
		// forward_auth copy_headers): a private app's segment must never be
		// marked publicly cacheable, exactly like the core's own answer.
		scope := "public"
		if d.Private {
			scope = "private"
		}
		w.Header().Set(HLSScopeHeader, scope)
		w.WriteHeader(http.StatusNoContent)
	})
}
