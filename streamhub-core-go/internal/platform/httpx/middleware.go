package httpx

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"
)

// SecurityHeaders applies helmet's defaults as configured in main.ts (CSP,
// CORP/COEP/COOP and frameguard OFF so players stay embeddable).
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-DNS-Prefetch-Control", "off")
		h.Set("X-Download-Options", "noopen")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("Origin-Agent-Cluster", "?1")
		h.Set("X-XSS-Protection", "0")
		next.ServeHTTP(w, r)
	})
}

// Recover turns a handler panic into a Nest-shaped 500 and logs the stack.
func Recover(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if v := recover(); v != nil {
					if v == http.ErrAbortHandler {
						panic(v)
					}
					log.Error("panic", "method", r.Method, "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
					WriteError(w, Nest(http.StatusInternalServerError, "Internal server error"))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += int64(n)
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer (flush,
// hijack for WebSockets, deadlines).
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// AccessLog logs one line per request (pino-http equivalent). Static media
// (/hls) is logged at debug to keep viewer fan-out out of the info stream.
func AccessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			level := slog.LevelInfo
			if len(r.URL.Path) >= 5 && r.URL.Path[:5] == "/hls/" {
				level = slog.LevelDebug
			}
			if rec.status >= 500 {
				level = slog.LevelError
			}
			log.Log(r.Context(), level, "request completed",
				"method", r.Method,
				"url", r.URL.RequestURI(),
				"status", rec.status,
				"bytes", rec.bytes,
				"ms", time.Since(start).Milliseconds(),
				"ip", ClientIP(r),
			)
		})
	}
}

// Chain applies middlewares outermost-first.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}
