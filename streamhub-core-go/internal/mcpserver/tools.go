package mcpserver

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// toolSpec maps one MCP tool to exactly one StreamHub REST endpoint.
//
// Path segments {arg} are filled from the validated arguments (strings with
// encodeURIComponent, numbers as JS numbers). Body lists the argument keys
// sent as the JSON body (absent ones dropped; nil Body = no body at all);
// Query lists the query params (nullish dropped). Custom overrides both.
type toolSpec struct {
	Name        string
	Method      string
	Path        string
	Body        []string
	Query       []string
	Destructive bool
	Custom      func(ctx context.Context, c *Client, a *y.Map) (any, error)
}

// errNotConfirmed is the second destructive gate (the schema's literal
// confirm: true is the first).
var errNotConfirmed = errors.New("Destructive operation not confirmed. Ask the user for explicit approval, then retry with confirm: true.")

var pathArg = regexp.MustCompile(`\{([A-Za-z0-9_]+)\}`)

// fillPath substitutes {arg} placeholders.
func fillPath(tmpl string, a *y.Map) string {
	return pathArg.ReplaceAllStringFunc(tmpl, func(m string) string {
		v := a.Get(m[1 : len(m)-1])
		if s, ok := v.(string); ok {
			return jsx.EncodeURIComponent(s)
		}
		return y.ToString(v)
	})
}

// pick is defined({k: a.k, ...}) in key order.
func pick(a *y.Map, keys []string) *y.Map {
	out := y.NewMap()
	for _, k := range keys {
		if v := a.Get(k); !y.IsUndefined(v) {
			out.Set(k, v)
		}
	}
	return out
}

func queryOf(a *y.Map, keys []string) []QueryParam {
	q := make([]QueryParam, 0, len(keys))
	for _, k := range keys {
		q = append(q, QueryParam{k, a.Get(k)})
	}
	return q
}

// run executes a spec with validated arguments.
func (t *toolSpec) run(ctx context.Context, c *Client, a *y.Map) (any, error) {
	if t.Destructive && a.Get("confirm") != true {
		return nil, errNotConfirmed
	}
	if t.Custom != nil {
		return t.Custom(ctx, c, a)
	}
	var body any = y.Undefined
	if t.Body != nil {
		body = pick(a, t.Body)
	}
	return c.Do(ctx, t.Method, fillPath(t.Path, a), queryOf(a, t.Query), body)
}

// pluginWorker: action status → GET …/worker/status, start|stop → POST.
func pluginWorker(ctx context.Context, c *Client, a *y.Map) (any, error) {
	base := fillPath("/apps/{app}/plugins/{id}/worker", a)
	action, _ := a.Get("action").(string)
	if action == "status" {
		return c.Do(ctx, http.MethodGet, base+"/status", nil, y.Undefined)
	}
	return c.Do(ctx, http.MethodPost, base+"/"+action, nil, y.Undefined)
}

// streamHealthSettings: PUT { config: defined({…thresholds}) }.
func streamHealthSettings(ctx context.Context, c *Client, a *y.Map) (any, error) {
	body := y.NewMap()
	body.Set("config", pick(a, []string{"sample_interval_sec", "silence_db", "silence_duration_sec",
		"desync_ms", "stall_sec", "bitrate_drop_pct", "recover_samples"}))
	return c.Do(ctx, http.MethodPut, fillPath("/apps/{app}/plugins/stream-health/streams/{room}/settings", a), nil, body)
}
