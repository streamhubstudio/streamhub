package passthrough

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

const secret = "s3cret"

type hookHarness struct {
	*svcFixture
	h http.Handler
}

func newHooks(t *testing.T, mutate func(*config.Config)) *hookHarness {
	f := newSvc(t, func(c *config.Config) {
		c.MediamtxEnable, c.MediamtxHookSecret = true, secret
		if mutate != nil {
			mutate(c)
		}
	})
	mux := http.NewServeMux()
	a := api.New(mux, "test")
	(&Module{Svc: f.svc}).Register(a)
	return &hookHarness{f, httpx.WithRequest(mux)}
}

type hookReq struct {
	path, body, ip, header, query string
	noSecret                      bool
	contentType                   string
}

func (h *hookHarness) do(t *testing.T, r hookReq) (int, map[string]any) {
	t.Helper()
	target := "/api/v1/internal/mediamtx/" + r.path
	if r.query != "" {
		target += "?secret=" + r.query
	}
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(r.body))
	ct := r.contentType
	if ct == "" {
		ct = "application/json"
	}
	req.Header.Set("Content-Type", ct)
	ip := r.ip
	if ip == "" {
		ip = "127.0.0.1"
	}
	req.RemoteAddr = ip + ":40000"
	if strings.Contains(ip, ":") {
		req.RemoteAddr = "[" + ip + "]:40000"
	}
	switch {
	case r.header != "":
		req.Header.Set("X-MediaMTX-Secret", r.header)
	case !r.noSecret && r.query == "":
		req.Header.Set("X-MediaMTX-Secret", secret)
	}
	w := httptest.NewRecorder()
	h.h.ServeHTTP(w, req)
	b, _ := io.ReadAll(w.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return w.Code, m
}

func TestHookGuard(t *testing.T) {
	h := newHooks(t, nil)
	body := `{"action":"publish","path":"live/sk_x"}`
	cases := []struct {
		name string
		r    hookReq
		code int
		msg  string
	}{
		{"public peer", hookReq{ip: "8.8.8.8"}, 403, "mediamtx hooks are internal-only"},
		{"missing secret", hookReq{noSecret: true}, 403, "mediamtx hook secret mismatch"},
		{"wrong secret", hookReq{header: "nope"}, 403, "mediamtx hook secret mismatch"},
		{"ipv6 loopback", hookReq{ip: "::1"}, 200, ""},
		{"compose bridge", hookReq{ip: "172.18.0.5"}, 200, ""},
		{"ipv4-mapped", hookReq{ip: "::ffff:10.0.0.2"}, 200, ""},
		{"query secret", hookReq{query: secret}, 200, ""},
		{"wrong query secret", hookReq{query: "nope"}, 403, "mediamtx hook secret mismatch"},
	}
	for _, c := range cases {
		c.r.path, c.r.body = "auth", body
		code, m := h.do(t, c.r)
		if code != c.code || (c.msg != "" && m["message"] != c.msg) {
			t.Errorf("%s: %d %v", c.name, code, m)
		}
	}
	for _, p := range []string{"ready", "notready"} {
		if code, _ := h.do(t, hookReq{path: p, body: body, ip: "8.8.8.8"}); code != 403 {
			t.Errorf("%s off-internal = %d", p, code)
		}
		if code, _ := h.do(t, hookReq{path: p, body: body, header: "bad"}); code != 403 {
			t.Errorf("%s bad secret = %d", p, code)
		}
	}
}

func TestHookDisabledWithoutSecret(t *testing.T) {
	h := newHooks(t, func(c *config.Config) { c.MediamtxHookSecret = "" })
	code, m := h.do(t, hookReq{path: "auth", body: `{}`, header: "anything"})
	if code != 403 || m["message"] != "mediamtx hooks disabled (no secret configured)" {
		t.Fatalf("%d %v", code, m)
	}
}

func TestHookAuth(t *testing.T) {
	h := newHooks(t, nil)
	_, key := h.register(t, "ch1", "rtmp", "")
	cases := []struct {
		body string
		code int
	}{
		{`{"action":"read","path":"garbage"}`, 200},
		{`{"action":"publish","path":"live/sk_xyz"}`, 200},
		{`{"action":"publish","path":"live/` + key + `"}`, 200},
		{`{"path":"live/` + key + `"}`, 200},
		{`{"action":"publish","path":"live/ptk_unknown"}`, 401},
		{`{"action":"publish","path":"garbage"}`, 401},
		{`{}`, 401},
		{``, 401},
	}
	for _, c := range cases {
		code, m := h.do(t, hookReq{path: "auth", body: c.body})
		if code != c.code {
			t.Errorf("%s: %d %v", c.body, code, m)
		}
		if code == 401 && m["message"] != "mediamtx publish denied" {
			t.Errorf("%s: %v", c.body, m)
		}
		if code == 200 && m["ok"] != true {
			t.Errorf("%s: %v", c.body, m)
		}
	}
	if h.sp.count() != 0 {
		t.Fatal("auth hook armed a remux")
	}
}

func TestHookReadyNotready(t *testing.T) {
	h := newHooks(t, nil)
	id, key := h.register(t, "ch1", "rtmp", "")
	if code, _ := h.do(t, hookReq{path: "ready", body: `{"path":"live/` + key + `"}`}); code != 200 || !h.svc.Remux().IsActive(id) {
		t.Fatal("ready did not arm the pull remux")
	}
	if code, _ := h.do(t, hookReq{path: "ready", body: `{"path":"live/sk_lk"}`}); code != 200 || !h.svc.Remux().IsActive("fwd_sk_lk") {
		t.Fatal("ready did not arm the forward")
	}
	n := h.sp.count()
	if code, _ := h.do(t, hookReq{path: "ready", body: `{"path":"garbage"}`}); code != 200 || h.sp.count() != n {
		t.Fatal("garbage ready armed something")
	}
	h.do(t, hookReq{path: "notready", body: `{"path":"live/` + key + `"}`})
	h.do(t, hookReq{path: "notready", body: `{"path":"live/sk_lk"}`})
	if h.svc.Remux().IsActive(id) || h.svc.Remux().IsActive("fwd_sk_lk") {
		t.Fatal("notready did not stop")
	}
	if code, _ := h.do(t, hookReq{path: "notready", body: `{"path":"x"}`}); code != 200 {
		t.Fatal("garbage notready")
	}
	// A non-JSON body reads as {} (body-parser), even when it looks like JSON.
	if code, _ := h.do(t, hookReq{path: "auth", body: `{"path":"live/sk"}`, contentType: "text/plain"}); code != 401 {
		t.Fatal("text/plain body was parsed")
	}
}
