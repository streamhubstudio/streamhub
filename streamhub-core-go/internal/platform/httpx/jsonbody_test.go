package httpx

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJSONBodyParser(t *testing.T) {
	var seen string
	h := JSONBodyParser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seen = string(b)
	}))
	cases := []struct {
		ct, body string
		code     int
	}{
		{"application/json", `{"a":1}`, 200},
		{"application/json; charset=utf-8", `[1]`, 200},
		{"application/json", ``, 200},
		{"application/json", `{nope`, 404},
		{"application/json", `"str"`, 404}, // strict: objects/arrays only
		{"application/webhook+json", `{`, 404},
		{"application/json", `{"big":"` + strings.Repeat("a", 100*1024) + `"}`, 404},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/v1/auth/login?x=1", strings.NewReader(c.body))
		r.Header.Set("Content-Type", c.ct)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.code {
			t.Errorf("%s %q: %d", c.ct, c.body, w.Code)
		}
		if c.code == 404 && !strings.Contains(w.Body.String(), `"message":"Cannot POST /api/v1/auth/login?x=1"`) {
			t.Errorf("body %s", w.Body)
		}
		if c.code == 200 && seen != c.body {
			t.Errorf("body not restored: %q", seen)
		}
	}
}

// TestBodyParserSelection: urlencoded → its qs JSON, multipart untouched,
// any other / missing type → no body (Express has no parser for it).
func TestBodyParserSelection(t *testing.T) {
	var seen, ct string
	h := JSONBodyParser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seen, ct = string(b), r.Header.Get("Content-Type")
	}))
	for _, c := range []struct{ ct, body, want, wantCT string }{
		{"application/x-www-form-urlencoded", "a=1&b[c]=2&b[d][]=x", `{"a":"1","b":{"c":"2","d":["x"]}}`, "application/json"},
		{"application/x-www-form-urlencoded; charset=utf-8", "", `{}`, "application/json"},
		{"multipart/form-data; boundary=x", "--x--", "--x--", "multipart/form-data; boundary=x"},
		{"text/plain", `{"a":1}`, "", ""},
		{"", `{"a":1}`, "", ""},
	} {
		r := httptest.NewRequest("POST", "/api/v1/x", strings.NewReader(c.body))
		r.Header.Set("Content-Type", c.ct)
		h.ServeHTTP(httptest.NewRecorder(), r)
		if seen != c.want || ct != c.wantCT {
			t.Errorf("%q %q: got %q (%q)", c.ct, c.body, seen, ct)
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/x", strings.NewReader("k"+strings.Repeat("[x]", 33)+"=v"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 404 { // body-parser 400 → serve-static's 404 under /api
		t.Errorf("depth: %d", w.Code)
	}
}

func TestJSONBodyParserOutsideAPI(t *testing.T) {
	h := JSONBodyParser(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for path, code := range map[string]int{"/somepage": 400, "/": 400, "/metrics": 404, "/hls/a/b": 404, "/API/v1/x": 404, "/apix": 400} {
		r := httptest.NewRequest("POST", path, strings.NewReader("{bad"))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != code {
			t.Errorf("%s: %d, want %d", path, w.Code, code)
		}
	}
}
