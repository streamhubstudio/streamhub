package whip

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNegotiate(t *testing.T) {
	var gotAuth, gotCT, gotBody, deleted string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			gotAuth, gotCT = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
			w.Header().Set("Location", "/whip/resource/abc")
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n")
		case http.MethodDelete:
			deleted = r.URL.Path + "|" + r.Header.Get("Authorization")
		}
	}))
	defer srv.Close()
	ans, loc, err := Negotiate(context.Background(), srv.Client(), srv.URL+"/whip/endpoint", "key1", "v=0\r\noffer")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer key1" || gotCT != "application/sdp" || !strings.Contains(gotBody, "offer") {
		t.Fatalf("request: %q %q %q", gotAuth, gotCT, gotBody)
	}
	if !strings.HasPrefix(ans, "v=0") || loc != srv.URL+"/whip/resource/abc" {
		t.Fatalf("answer/location: %q %q", ans, loc)
	}
	Teardown(srv.Client(), loc, "key1")
	if deleted != "/whip/resource/abc|Bearer key1" {
		t.Fatalf("DELETE: %q", deleted)
	}
}

func TestNegotiateErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, "missing token")
			return
		}
		_, _ = io.WriteString(w, "<html>not sdp</html>")
	}))
	defer srv.Close()
	if _, _, err := Negotiate(context.Background(), srv.Client(), srv.URL, "", "v=0"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("401: %v", err)
	}
	if _, _, err := Negotiate(context.Background(), srv.Client(), srv.URL, "k", "v=0"); err == nil || !strings.Contains(err.Error(), "not an SDP") {
		t.Fatalf("non-SDP: %v", err)
	}
}
