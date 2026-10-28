package logs

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/url"

	"github.com/danielgtaylor/huma/v2"
	"github.com/dlclark/regexp2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Page is the paginated viewer response (LogsPageResponse).
type Page struct {
	Data   []Entry `json:"data"`
	Total  int64   `json:"total"`
	Limit  int     `json:"limit"`
	Offset int     `json:"offset"`
}

// Register implements api.Module: GET /logs and GET /apps/:app/logs.
func (s *Service) Register(a huma.API) {
	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "LogsController_query",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/logs",
		Summary:     "List server logs",
		Tags:        []string{"logs"},
	}), func(ctx context.Context, _ *struct{}) (*api.Out[Page], error) {
		f, err := parseQuery(api.Request(ctx).URL.Query(), true)
		if err != nil {
			return nil, err
		}
		return api.JSON(s.page(ctx, f)), nil
	})

	type appInput struct {
		App string `path:"app"`
	}
	huma.Register(a, *authz.Require(api.Bearer(&huma.Operation{
		OperationID: "AppLogsController_query",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/apps/{app}/logs",
		Summary:     "List logs for a single app",
		Tags:        []string{"logs"},
	}), "usage", "read"), func(ctx context.Context, in *appInput) (*api.Out[Page], error) {
		f, err := parseQuery(api.Request(ctx).URL.Query(), false)
		if err != nil {
			return nil, err
		}
		f.App = in.App
		return api.JSON(s.page(ctx, f)), nil
	})
}

// page is the controller body: defaults limit 100 / offset 0 into both
// the query and the envelope.
func (s *Service) page(ctx context.Context, f Filters) Page {
	limit, offset := defaultLimit, 0
	if f.Limit != nil {
		limit = *f.Limit
	}
	if f.Offset != nil {
		offset = *f.Offset
	}
	f.Limit, f.Offset = &limit, &offset
	return Page{Data: s.Query(ctx, f), Total: s.Count(ctx, f), Limit: limit, Offset: offset}
}

// parseQuery is ValidationPipe({transform, whitelist}) over LogQueryDto
// (withApp) / AppLogQueryDto. class-validator reports the subclass's own
// property (app) before the inherited ones; within a property, rules are
// listed bottom-up (see package validate).
func parseQuery(q url.Values, withApp bool) (Filters, error) {
	fields := map[string]any{}
	for _, k := range []string{"app", "level", "since", "until", "source", "q"} {
		if v, ok := queryValue(q, k); ok {
			fields[k] = v
		}
	}
	for _, k := range []string{"limit", "offset"} {
		if v, ok := queryValue(q, k); ok {
			fields[k] = toNumber(v)
		}
	}
	raw, _ := json.Marshal(fields)
	b, err := validate.Parse(raw)
	if err != nil {
		return Filters{}, err
	}
	if withApp {
		b.Optional("app").MaxLength(64).IsString()
	}
	levels := make([]string, len(Levels))
	copy(levels, Levels)
	b.Optional("level").IsIn(levels...)
	b.Optional("since").Check(isISO8601(fields["since"]), "since must be a valid ISO 8601 date string")
	b.Optional("until").Check(isISO8601(fields["until"]), "until must be a valid ISO 8601 date string")
	b.Optional("source").MaxLength(64).IsString()
	b.Optional("q").MaxLength(200).IsString()
	b.Optional("limit").Max(1000).Min(1).IsInt()
	b.Optional("offset").Min(0).IsInt()
	if err := b.Err(); err != nil {
		return Filters{}, err
	}
	f := Filters{Level: b.String("level"), Since: b.String("since"), Until: b.String("until"), Source: b.String("source"), Q: b.String("q")}
	if withApp {
		f.App = b.String("app")
	}
	if n := b.Int("limit"); n != nil {
		v := int(*n)
		f.Limit = &v
	}
	if n := b.Int("offset"); n != nil {
		v := int(*n)
		f.Offset = &v
	}
	return f, nil
}

// queryValue is Express's parsed query value: a string, or an array when
// the key repeats.
func queryValue(q url.Values, k string) (any, bool) {
	vs, ok := q[k]
	if !ok {
		return nil, false
	}
	if len(vs) == 1 {
		return vs[0], true
	}
	out := make([]any, len(vs))
	for i, v := range vs {
		out[i] = v
	}
	return out, true
}

// toNumber is @Type(() => Number): Number(value). NaN and ±Infinity can't
// travel through JSON; they become a string, which fails IsInt/Min/Max with
// the same messages as NaN.
func toNumber(v any) any {
	var f float64
	switch t := v.(type) {
	case string:
		f = yamljs.StringToNumber(t)
	case []any:
		if len(t) != 1 {
			return "NaN"
		}
		s, _ := t[0].(string)
		f = yamljs.StringToNumber(s)
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "NaN"
	}
	return f
}

// iso8601 is validator.js isISO8601 (default options: regex only, no
// calendar check). It needs look-ahead and back-references, hence regexp2.
var iso8601 = regexp2.MustCompile(`^([\+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([\.,]\d+(?!:))?)?(\17[0-5]\d([\.,]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$`, regexp2.ECMAScript)

func isISO8601(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	m, err := iso8601.MatchString(s)
	return err == nil && m
}
