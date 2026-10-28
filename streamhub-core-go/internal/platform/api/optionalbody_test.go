package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
)

func TestOptionalRawBody(t *testing.T) {
	mux := http.NewServeMux()
	a := New(mux, "test")
	type typed struct {
		Body struct {
			Name string `json:"name"`
		}
	}
	got := ""
	huma.Register(a, huma.Operation{OperationID: "raw", Method: http.MethodPost, Path: "/raw"},
		func(_ context.Context, in *RawBodyInput) (*struct{}, error) {
			got = "raw:" + string(in.RawBody)
			return nil, nil
		})
	huma.Register(a, huma.Operation{OperationID: "typed", Method: http.MethodPost, Path: "/typed"},
		func(_ context.Context, in *typed) (*struct{}, error) { return nil, nil })

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/raw", nil))
	if w.Code != http.StatusNoContent || got != "raw:" {
		t.Fatalf("raw op without body: %d %s (handler %q)", w.Code, w.Body, got)
	}
	if a.OpenAPI().Paths["/raw"].Post.RequestBody.Required {
		t.Fatal("raw op still documented as required")
	}
	// Typed bodies keep huma's default.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/typed", nil))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "request body is required") {
		t.Fatalf("typed op without body: %d %s", w.Code, w.Body)
	}
}
