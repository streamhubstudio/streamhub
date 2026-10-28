// Package httpx holds the HTTP conventions shared by every module: the error
// shapes the Node core emits (so the SPA, MCP server and SDK parse them the
// same), client-IP resolution and small response helpers.
//
// Two error shapes exist in the Node core and both must be preserved per route:
//
//   - Nest's default exception body, used by thrown HttpExceptions:
//     {"statusCode":404,"message":"app \"x\" not found","error":"Not Found"}
//     (validation failures carry "message" as an array of strings);
//   - the StreamHub envelope used by a few hand-written handlers (rate limiter,
//     static mounts): {"data":null,"error":{"code":"not_found","message":"…"}}.
package httpx

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
)

// Error is an HTTP error carrying an exact JSON body. It satisfies
// huma.StatusError so handlers can simply `return nil, httpx.NotFound(...)`.
type Error struct {
	Status int
	Body   any
}

func (e *Error) Error() string {
	switch b := e.Body.(type) {
	case NestBody:
		return fmt.Sprint(b.Message)
	case Envelope:
		if b.Error != nil {
			return b.Error.Message
		}
	}
	return http.StatusText(e.Status)
}

// GetStatus implements huma.StatusError.
func (e *Error) GetStatus() int { return e.Status }

// MarshalJSON writes the exact body (huma serializes the error value itself).
func (e *Error) MarshalJSON() ([]byte, error) { return json.Marshal(e.Body) }

// NestBody is Nest's default HttpException response.
type NestBody struct {
	StatusCode int    `json:"statusCode"`
	Message    any    `json:"message"` // string, or []string for validation
	Error      string `json:"error,omitempty"`
}

// EnvelopeError is the error half of the StreamHub envelope.
type EnvelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Envelope is the {data, error} wrapper.
type Envelope struct {
	Data  any            `json:"data"`
	Error *EnvelopeError `json:"error"`
}

// Nest builds a Nest-shaped error. Like Nest, when the message equals the
// status text the "error" field is omitted (e.g. new NotFoundException()).
func Nest(status int, message string) *Error {
	text := http.StatusText(status)
	if message == "" {
		return &Error{Status: status, Body: NestBody{StatusCode: status, Message: text}}
	}
	return &Error{Status: status, Body: NestBody{StatusCode: status, Message: message, Error: text}}
}

// NestValidation is the ValidationPipe 400: message is a list of strings.
func NestValidation(messages []string) *Error {
	return &Error{Status: http.StatusBadRequest, Body: NestBody{
		StatusCode: http.StatusBadRequest, Message: messages, Error: http.StatusText(http.StatusBadRequest),
	}}
}

// Enveloped builds a {data:null,error:{code,message}} error.
func Enveloped(status int, code, message string) *Error {
	return &Error{Status: status, Body: Envelope{Error: &EnvelopeError{Code: code, Message: message}}}
}

func BadRequest(msg string) *Error   { return Nest(http.StatusBadRequest, msg) }
func Unauthorized(msg string) *Error { return Nest(http.StatusUnauthorized, msg) }
func Forbidden(msg string) *Error    { return Nest(http.StatusForbidden, msg) }
func NotFound(msg string) *Error     { return Nest(http.StatusNotFound, msg) }
func Conflict(msg string) *Error     { return Nest(http.StatusConflict, msg) }
func Internal(msg string) *Error     { return Nest(http.StatusInternalServerError, msg) }
func Unavailable(msg string) *Error  { return Nest(http.StatusServiceUnavailable, msg) }

// InstallHumaErrors makes huma's own errors (validation, 404 on params, panics
// converted by huma) use the Nest shape instead of RFC 9457 problem+json.
func InstallHumaErrors() {
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) == 0 {
			return Nest(status, msg)
		}
		details := make([]string, 0, len(errs))
		for _, e := range errs {
			if e == nil {
				continue
			}
			details = append(details, validationMessage(e))
		}
		if status == http.StatusUnprocessableEntity || status == http.StatusBadRequest {
			// Nest's ValidationPipe answers 400, never 422.
			return NestValidation(details)
		}
		return Nest(status, msg)
	}
}

func validationMessage(e error) string {
	if d, ok := e.(*huma.ErrorDetail); ok {
		if d.Location != "" {
			return fmt.Sprintf("%s %s", d.Location, d.Message)
		}
		return d.Message
	}
	return e.Error()
}

// WriteJSON writes v with status (used by plain net/http handlers).
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError writes an *Error from a plain net/http handler.
func WriteError(w http.ResponseWriter, e *Error) { WriteJSON(w, e.Status, e.Body) }
