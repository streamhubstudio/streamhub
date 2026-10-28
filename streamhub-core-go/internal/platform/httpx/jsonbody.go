package httpx

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// JSONBodyParser reproduces how the Node core rejects bad JSON bodies.
//
// It is also Express's body-parser selection: urlencoded bodies are parsed
// (qs, extended) into the JSON the handler would see, multipart passes
// through to the handler, and a body of any other (or no) content type is
// dropped — Node registers no parser for it, so req.body stays undefined.
//
// main.ts registers express.json (types application/json and
// application/webhook+json, strict = top-level object/array only, 100kb
// limit) before anything else, so a parse failure skips every normal
// middleware — the auth rate limiter and helmet included — and goes straight
// to Express's error chain. There @nestjs/serve-static's error handler turns
// ANY error on a path excluded from the SPA fallback (/api, /rtc, /hls,
// /live, /samples, /sdk, /metrics) into Nest's 404 "Cannot <METHOD> <url>";
// on any other path the parser's 400 reaches the Nest exception filter with
// V8's JSON.parse message (not reproducible byte-for-byte: a generic text
// is used). It applies to every route, not only the auth ones.
func JSONBodyParser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		switch {
		case r.Body == nil || r.Body == http.NoBody:
			next.ServeHTTP(w, r)
			return
		case mt == "application/x-www-form-urlencoded":
			urlencodedBody(next, w, r)
			return
		case strings.HasPrefix(mt, "multipart/"):
			// multer (FileInterceptor) reads these in the handler
			next.ServeHTTP(w, r)
			return
		case mt != "application/json" && mt != "application/webhook+json":
			// No parser registered for this type (or none given): Express
			// leaves req.body undefined, so the handler sees no body.
			r.Body.Close()
			r.Body, r.ContentLength = http.NoBody, 0
			r.Header.Del("Content-Type")
			r.Header.Del("Content-Length")
			next.ServeHTTP(w, r)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, jsonBodyLimit+1))
		r.Body.Close()
		if err != nil {
			bodyParserError(w, r, BadRequest("request aborted"))
			return
		}
		if len(raw) > jsonBodyLimit {
			bodyParserError(w, r, Nest(http.StatusRequestEntityTooLarge, "request entity too large"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) > 0 && ((trimmed[0] != '{' && trimmed[0] != '[') || !json.Valid(trimmed)) {
			bodyParserError(w, r, BadRequest("Unexpected token in JSON body"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// urlencodedBody is express.urlencoded({extended: true}) (Nest registers it
// by default): the qs-parsed body is handed on as the equivalent JSON, which
// is what the handler would have seen as req.body.
func urlencodedBody(next http.Handler, w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, jsonBodyLimit+1))
	r.Body.Close()
	if err != nil {
		bodyParserError(w, r, BadRequest("request aborted"))
		return
	}
	if len(raw) > jsonBodyLimit {
		bodyParserError(w, r, Nest(http.StatusRequestEntityTooLarge, "request entity too large"))
		return
	}
	parsed, perr := ParseURLEncoded(string(raw))
	if perr != nil {
		e, _ := perr.(*Error)
		bodyParserError(w, r, e)
		return
	}
	js, _ := y.Stringify(parsed)
	r.Body, r.ContentLength = io.NopCloser(strings.NewReader(js)), int64(len(js))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Content-Length", strconv.Itoa(len(js)))
	next.ServeHTTP(w, r)
}

// jsonBodyLimit is body-parser's default 100kb.
const jsonBodyLimit = 100 * 1024

// spaExcluded are ServeStaticModule's `exclude` prefixes (app.module.ts).
var spaExcluded = []string{"/api", "/rtc", "/hls", "/live", "/samples", "/sdk"}

// isSPAExcluded mirrors serve-static's isRouteExcluded: path-to-regexp
// ("/api/*splat", "/metrics", case-insensitive) over pathname + "/".
func isSPAExcluded(path string) bool {
	p := strings.ToLower(path) + "/"
	if p == "/metrics/" {
		return true
	}
	for _, prefix := range spaExcluded {
		if strings.HasPrefix(p, prefix+"/") && len(p) > len(prefix)+1 {
			return true
		}
	}
	return false
}

func bodyParserError(w http.ResponseWriter, r *http.Request, e *Error) {
	if isSPAExcluded(r.URL.Path) {
		e = NotFound("Cannot " + r.Method + " " + r.URL.RequestURI())
	}
	WriteError(w, e)
}
