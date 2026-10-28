package httpx

import (
	"net/http"
	"strings"
)

// ExpressContentType rewrites Content-Type the way Express sends it, so
// clients and the parity suite see identical headers:
//   - JSON and problem/openapi JSON → "application/json; charset=utf-8"
//   - text/html and text/plain without a charset get "; charset=utf-8"
//
// Static media (video/mp2t, application/vnd.apple.mpegurl, JS, images) is
// left untouched.
func ExpressContentType(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&ctWriter{ResponseWriter: w}, r)
	})
}

type ctWriter struct {
	http.ResponseWriter
	done bool
}

func (c *ctWriter) fix() {
	if c.done {
		return
	}
	c.done = true
	h := c.Header()
	ct := h.Get("Content-Type")
	if ct == "" {
		return
	}
	base, _, _ := strings.Cut(ct, ";")
	base = strings.TrimSpace(strings.ToLower(base))
	switch {
	case base == "application/json", strings.HasSuffix(base, "+json"):
		h.Set("Content-Type", "application/json; charset=utf-8")
	case (base == "text/html" || base == "text/plain") && !strings.Contains(strings.ToLower(ct), "charset"):
		h.Set("Content-Type", base+"; charset=utf-8")
	}
}

func (c *ctWriter) WriteHeader(code int) {
	c.fix()
	c.ResponseWriter.WriteHeader(code)
}

func (c *ctWriter) Write(b []byte) (int, error) {
	c.fix()
	return c.ResponseWriter.Write(b)
}

// Unwrap exposes the underlying writer to http.ResponseController.
func (c *ctWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }
