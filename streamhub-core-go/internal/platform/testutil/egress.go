package testutil

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// RedirectToLoopback is the 30x SSRF probe for the egress-guarded clients,
// all in-process: an httptest server whose every path 302s to
// http://127.0.0.1:<port>/internal (the same server). It returns the start
// URL on the hostname "localhost" — exempt once the test sets
// STREAMHUB_CALLBACK_ALLOW_HOSTS=localhost, so the URL guard and the dial
// let the first hop through — and the hit counter of /internal, which a
// guarded client never reaches (127.0.0.1 itself is not allowlisted).
func RedirectToLoopback(t testing.TB) (start string, internalHits *atomic.Int32) {
	t.Helper()
	hits := &atomic.Int32{}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal" {
			hits.Add(1)
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"keys":[]}`))
			return
		}
		http.Redirect(w, r, srv.URL+"/internal", http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("STREAMHUB_CALLBACK_ALLOW_HOSTS", "localhost")
	return strings.Replace(srv.URL, "127.0.0.1", "localhost", 1) + "/hook", hits
}
