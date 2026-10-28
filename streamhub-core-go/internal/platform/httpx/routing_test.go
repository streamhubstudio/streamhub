package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExpressRouting(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("health")) })
	mux.HandleFunc("GET /api/v1/apps/{app}/streams", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("streams:" + r.PathValue("app")))
	})
	mux.HandleFunc("GET /api/v1/files/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("files:" + r.PathValue("rest")))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("spa:" + r.URL.Path)) })
	h := ExpressRouting(mux)
	for path, want := range map[string]string{
		"/api/v1/health":              "health",
		"/api/v1/health/":             "health",
		"/API/V1/Health":              "health",
		"/api/v1/Apps/MyApp/STREAMS/": "streams:MyApp",
		"/api/v1/FILES/A/b":           "files:A/b",
		"/api/v1/nope/":               "spa:/api/v1/nope/",
		"/somepage/":                  "spa:/somepage/",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Body.String() != want {
			t.Errorf("%s: got %q want %q", path, w.Body.String(), want)
		}
	}
}
