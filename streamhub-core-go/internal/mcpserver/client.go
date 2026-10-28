package mcpserver

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Thin HTTP client over the StreamHub REST API (/api/v1): bearer auth, query
// serialization (undefined/null skipped), { data, error } envelope unwrapping
// and Nest error bodies → APIError. No retries: errors go back to the model.
//
// Values follow the JS model of the yamljs package (*y.Map objects in JS key
// order, float64 numbers, y.Undefined for absent) so request bodies and the
// rendered results are byte-identical to the TypeScript server.

// APIError is StreamHubApiError: Status 0 = network failure.
type APIError struct {
	Status  int
	Message string
	Body    any
}

func (e *APIError) Error() string { return e.Message }

// QueryParam is one query key/value (order is kept, like URLSearchParams).
type QueryParam struct {
	Key   string
	Value any
}

// Client calls one StreamHub instance.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// NewClient builds a client for cfg (http.DefaultClient when hc is nil).
func NewClient(baseURL, token string, hc *http.Client) *Client {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Client{BaseURL: baseURL, Token: token, HTTP: hc}
}

var apiSuffix = regexp.MustCompile(`/api/v1$`)

// Origin is the base URL without /api/v1 (for /play, /embed, /hls links).
func (c *Client) Origin() string { return apiSuffix.ReplaceAllString(c.BaseURL, "") }

// BuildURL appends path and the non-nullish query params to the base URL.
func (c *Client) BuildURL(path string, query []QueryParam) string {
	u := c.BaseURL + path
	var parts []string
	for _, q := range query {
		if y.IsNullish(q.Value) {
			continue
		}
		parts = append(parts, formEncode(q.Key)+"="+formEncode(y.ToString(q.Value)))
	}
	if len(parts) > 0 {
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		u += sep + strings.Join(parts, "&")
	}
	return u
}

// formEncode is the application/x-www-form-urlencoded serializer of
// URLSearchParams: alphanumerics and *-._ stay, space → '+', the rest %XX.
func formEncode(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

// Do performs one request; body Undefined (or nil interface) sends none.
func (c *Client) Do(ctx context.Context, method, path string, query []QueryParam, body any) (any, error) {
	u := c.BuildURL(path, query)
	var rd io.Reader
	hasBody := body != nil && !y.IsUndefined(body)
	if hasBody {
		s, err := y.Stringify(body)
		if err != nil {
			return nil, err
		}
		rd = strings.NewReader(s)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, &APIError{Status: 0, Message: fmt.Sprintf("Cannot reach StreamHub at %s: fetch failed", u)}
	}
	req.Header.Set("authorization", "Bearer "+c.Token)
	req.Header.Set("accept", "application/json")
	if hasBody {
		req.Header.Set("content-type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		// Node's fetch reports every transport failure as "fetch failed".
		return nil, &APIError{Status: 0, Message: fmt.Sprintf("Cannot reach StreamHub at %s: fetch failed", u)}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		ok := y.NewMap()
		ok.Set("ok", true)
		return ok, nil
	}
	raw, _ := io.ReadAll(res.Body)
	var parsed any
	if len(raw) > 0 {
		if v, err := y.ParseJSON(raw); err == nil {
			parsed = v
		} else {
			parsed = string(raw)
		}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &APIError{Status: res.StatusCode, Message: ExtractErrorMessage(parsed, res.StatusCode), Body: parsed}
	}
	return UnwrapEnvelope(parsed, res.StatusCode)
}

// UnwrapEnvelope unwraps { data, error }:
//   - { data, error: null }            → data
//   - { data, total, limit, offset }   → { items, total, limit, offset }
//   - anything else                    → passed through
//
// A non-null error throws an APIError.
func UnwrapEnvelope(body any, status int) (any, error) {
	m, ok := body.(*y.Map)
	if !ok || m == nil || !m.Has("data") {
		return body, nil
	}
	if e, has := m.Lookup("error"); has && !y.IsNullish(e) {
		msg, isStr := e.(string)
		if !isStr {
			enc, _ := y.Stringify(e)
			msg = "StreamHub returned an error: " + enc
		}
		return nil, &APIError{Status: status, Message: msg, Body: body}
	}
	if m.Has("total") {
		out := y.NewMap()
		out.Set("items", m.Get("data"))
		out.Set("total", m.Get("total"))
		out.Set("limit", m.Get("limit"))
		out.Set("offset", m.Get("offset"))
		return out, nil
	}
	return m.Get("data"), nil
}

// ExtractErrorMessage pulls a human message out of a Nest error body
// (message may be an array).
func ExtractErrorMessage(parsed any, status int) string {
	if m, ok := parsed.(*y.Map); ok && m != nil {
		switch msg := m.Get("message").(type) {
		case []any:
			parts := make([]string, len(msg))
			for i, p := range msg {
				parts[i] = y.ToString(p)
			}
			return strings.Join(parts, "; ")
		case string:
			if msg != "" {
				return msg
			}
		}
		if e, ok := m.Get("error").(string); ok && e != "" {
			return e
		}
	}
	if s, ok := parsed.(string); ok && y.Trim(s) != "" {
		return y.Trim(s)
	}
	return fmt.Sprintf("HTTP %d", status)
}
