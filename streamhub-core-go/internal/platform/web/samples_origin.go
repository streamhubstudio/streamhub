package web

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// samplesHostPrefixes are the only surfaces the samples host serves: the
// sample pages themselves plus what they call same-origin (the REST API for
// play/listen tokens and POST …/tokens with ?apitoken, the SDK, HLS). All
// auth on the API is bearer-only (no cookies), so a page on the samples
// origin gains nothing from it that it could not already do cross-origin.
var samplesHostPrefixes = []string{"/samples/", "/sdk/", "/hls/", "/api/"}

// SamplesOrigin splits traffic between the dashboard and a dedicated samples
// origin (STREAMHUB_SAMPLES_URL), so tenant-editable sample HTML never runs
// on the origin whose localStorage holds the dashboard JWT:
//
//   - Host == samples host: /samples, /sdk, /hls and /api are served as
//     usual; anything else (the SPA, its assets, /metrics…) is a 302 to the
//     same path on dashboardURL, so nobody logs in on the samples origin.
//     Without a dashboardURL those paths are a 404.
//   - any other Host: /samples/* is a 302 to the same path+query on
//     samplesURL; everything else is untouched.
//
// samplesURL == "" returns next unchanged (today's behaviour).
func SamplesOrigin(next http.Handler, samplesURL, dashboardURL string) http.Handler {
	if samplesURL == "" {
		return next
	}
	samplesURL = strings.TrimRight(samplesURL, "/")
	dashboardURL = strings.TrimRight(dashboardURL, "/")
	match := hostMatcher(samplesURL)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lower := strings.ToLower(r.URL.Path)
		if match(r.Host) {
			if lower == "/api" || hasAnyPrefix(lower, samplesHostPrefixes) {
				next.ServeHTTP(w, r)
				return
			}
			if dashboardURL == "" {
				httpx.WriteError(w, httpx.Nest(http.StatusNotFound, fmt.Sprintf("Cannot %s %s", r.Method, r.URL.Path)))
				return
			}
			redirect(w, r, dashboardURL+r.URL.RequestURI())
			return
		}
		if strings.HasPrefix(r.URL.Path, "/samples/") {
			redirect(w, r, samplesURL+r.URL.RequestURI())
			return
		}
		next.ServeHTTP(w, r)
	})
}

func redirect(w http.ResponseWriter, r *http.Request, to string) {
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, to, http.StatusFound)
}

// hostMatcher matches a request Host against the samples URL's host. When
// the URL carries an explicit port the port must match too (two origins may
// differ only by port); otherwise any port on that hostname matches, so a
// proxy that forwards "host:443" or a bare "host" both land.
func hostMatcher(origin string) func(string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return func(string) bool { return false }
	}
	want, wantName, explicitPort := strings.ToLower(u.Host), strings.ToLower(u.Hostname()), u.Port() != ""
	return func(host string) bool {
		host = strings.ToLower(strings.TrimSuffix(host, "."))
		if host == want {
			return true
		}
		if explicitPort {
			return false
		}
		name := host
		if h, _, err := net.SplitHostPort(host); err == nil {
			name = h
		}
		return name == wantName
	}
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
