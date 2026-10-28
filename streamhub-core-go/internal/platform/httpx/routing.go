package httpx

import (
	"net/http"
	"strings"
)

// ExpressRouting gives the mux Express's default router matching: routes
// are case-insensitive and non-strict (one trailing slash is optional), so
// GET /API/V1/Health/ reaches GET /api/v1/health with the original casing
// kept in the path params. Only a request that would otherwise miss every
// method route is rewritten; everything else is served untouched.
func ExpressRouting(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); isRoute(pattern) {
			mux.ServeHTTP(w, r)
			return
		}
		path := r.URL.Path
		if len(path) > 1 && strings.HasSuffix(path, "/") {
			path = path[:len(path)-1]
		}
		probe := r.Clone(r.Context())
		probe.URL.Path, probe.URL.RawPath = strings.ToLower(path), ""
		_, pattern := mux.Handler(probe)
		if !isRoute(pattern) {
			mux.ServeHTTP(w, r)
			return
		}
		rewritten, ok := withPatternLiterals(pattern, path)
		if !ok || rewritten == r.URL.Path {
			mux.ServeHTTP(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path, r2.URL.RawPath = rewritten, ""
		mux.ServeHTTP(w, r2)
	})
}

// isRoute: a method-qualified pattern ("GET /api/v1/...") — not a static
// mount or the SPA fallback.
func isRoute(pattern string) bool { return strings.Contains(pattern, " ") }

// withPatternLiterals rebuilds path with the pattern's literal segments and
// the request's own text for every wildcard segment.
func withPatternLiterals(pattern, path string) (string, bool) {
	pat := pattern[strings.IndexByte(pattern, ' ')+1:]
	if i := strings.IndexByte(pat, '/'); i > 0 {
		pat = pat[i:] // drop a host part
	}
	ps, xs := strings.Split(pat, "/"), strings.Split(path, "/")
	out := make([]string, 0, len(xs))
	for i, p := range ps {
		if i >= len(xs) {
			return "", false
		}
		switch {
		case strings.HasSuffix(p, "...}"):
			return strings.Join(append(out, xs[i:]...), "/"), true
		case strings.HasPrefix(p, "{"):
			out = append(out, xs[i])
		default:
			out = append(out, p)
		}
	}
	if len(ps) != len(xs) {
		return "", false
	}
	return strings.Join(out, "/"), true
}
