package api

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Envelope is the StreamHub success wrapper {data, error: null} (SPEC §6).
type Envelope[T any] struct {
	Data  T         `json:"data"`
	Error *struct{} `json:"error"`
}

// Out is a huma output carrying Body as the response JSON.
type Out[T any] struct {
	Body T
}

// OK wraps v as {data: v, error: null}.
func OK[T any](v T) *Out[Envelope[T]] { return &Out[Envelope[T]]{Body: Envelope[T]{Data: v}} }

// Data wraps v as {data: v} (no error key), as some Node handlers return.
type Data[T any] struct {
	Data T `json:"data"`
}

// JSON returns v as the raw response body.
func JSON[T any](v T) *Out[T] { return &Out[T]{Body: v} }

// RawBodyInput is the input of operations that validate their JSON body by
// hand (validate package) to reproduce class-validator messages exactly.
type RawBodyInput struct {
	RawBody []byte
}

// Request returns the inbound request (httpx.WithRequest must wrap the mux).
func Request(ctx context.Context) *http.Request {
	if r := httpx.RequestFrom(ctx); r != nil {
		return r
	}
	return &http.Request{Header: http.Header{}, URL: &url.URL{}}
}

// GlobalScopeMessage is the 403 text of the superadmin surfaces (/system, /security).
const GlobalScopeMessage = "this endpoint requires a global-scope credential"

// RequireGlobal rejects app-/user-scoped principals with 403 msg. No
// principal (dev without an authenticator) passes, as in Node.
func RequireGlobal(ctx context.Context, msg string) error {
	p := auth.From(ctx)
	if p != nil && !p.IsSuperadmin && p.Scope != auth.ScopeGlobal {
		return httpx.Forbidden(msg)
	}
	return nil
}

var intParam = regexp.MustCompile(`^-?\d+$`)

// ParseIntParam is Nest's ParseIntPipe on a path param.
func ParseIntParam(v string) (int64, error) {
	if !intParam.MatchString(v) {
		return 0, httpx.BadRequest("Validation failed (numeric string is expected)")
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, httpx.BadRequest("Validation failed (numeric string is expected)")
	}
	return n, nil
}
