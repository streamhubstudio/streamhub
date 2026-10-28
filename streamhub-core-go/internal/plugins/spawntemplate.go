package plugins

import (
	"regexp"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of spawn-template.ts: the declarative, zero-eval worker template a
// vendored package ships instead of a spawn closure. A package can only
// choose the STRINGS of its own subprocess command/args/env/cwd.
//
// Grammar inside {{ … }}: refs (app appDir dataDir livekitUrl originUrl
// publicBase workerDir pluginPython configJson config.<k> env.<NAME>
// 'literal'), coalesce `a ?? b`, one filter `| ternary:t:e`, `| map:k=v,*=d`,
// `| localOnly`.

// TemplateOptions complete the context for the interpreter.
type TemplateOptions struct {
	WorkerDir    string
	PluginPython *string // nil = env.PLUGIN_PYTHON ?? 'python3'
	PublicBase   *string // nil = env.PUBLIC_BASE_URL ?? ''
	Env          func(string) string
}

// StringifyConfigValue is String(...) as the code metas apply it.
func StringifyConfigValue(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return y.JSNumberString(x)
	case string:
		return x
	}
	if y.IsUndefined(v) {
		return ""
	}
	s, _ := y.Stringify(v)
	return s
}

func truthyToken(v string) bool { return v != "" && v != "false" && v != "0" }

func resolveRef(ref string, ctx WorkerContext, o TemplateOptions) string {
	r := strings.TrimSpace(ref)
	if r == "" {
		return ""
	}
	if len(r) >= 2 && ((r[0] == '\'' && r[len(r)-1] == '\'') || (r[0] == '"' && r[len(r)-1] == '"')) {
		return r[1 : len(r)-1]
	}
	if len(r) == 1 && (r == "'" || r == `"`) {
		return "" // JS: "'".slice(1, -1) === ''
	}
	if strings.HasPrefix(r, "config.") {
		if ctx.Config == nil {
			return ""
		}
		return StringifyConfigValue(ctx.Config.Get(r[len("config."):]))
	}
	if strings.HasPrefix(r, "env.") {
		return o.Env(r[len("env."):])
	}
	switch r {
	case "app":
		return ctx.App
	case "appDir":
		return ctx.AppDir
	case "dataDir":
		return ctx.DataDir
	case "livekitUrl":
		return ctx.LivekitURL
	case "originUrl":
		return ctx.OriginURL
	case "publicBase":
		if o.PublicBase != nil {
			return *o.PublicBase
		}
		return o.Env("PUBLIC_BASE_URL")
	case "workerDir":
		return o.WorkerDir
	case "pluginPython":
		if o.PluginPython != nil {
			return *o.PluginPython
		}
		if p := o.Env("PLUGIN_PYTHON"); p != "" {
			return p
		}
		return "python3"
	case "configJson":
		if ctx.Config == nil {
			return "{}"
		}
		s, _ := y.Stringify(ctx.Config)
		return s
	}
	return ""
}

func applyFilter(value, filter string, remote bool) string {
	trimmed := strings.TrimSpace(filter)
	name, rest := trimmed, ""
	if i := strings.IndexByte(trimmed, ':'); i >= 0 {
		name, rest = strings.TrimSpace(trimmed[:i]), trimmed[i+1:]
	}
	switch name {
	case "localOnly":
		if remote {
			return ""
		}
		return value
	case "ternary":
		thenV, elseV := strings.TrimSpace(rest), ""
		if i := strings.IndexByte(rest, ':'); i >= 0 {
			thenV, elseV = strings.TrimSpace(rest[:i]), strings.TrimSpace(rest[i+1:])
		}
		if truthyToken(value) {
			return thenV
		}
		return elseV
	case "map":
		table := map[string]string{}
		for _, pair := range strings.Split(rest, ",") {
			eq := strings.IndexByte(pair, '=')
			if eq == -1 {
				continue
			}
			table[strings.TrimSpace(pair[:eq])] = strings.TrimSpace(pair[eq+1:])
		}
		if v, ok := table[value]; ok {
			return v
		}
		return table["*"]
	}
	return value
}

func evalExpr(body string, ctx WorkerContext, o TemplateOptions) string {
	source, filter, hasFilter := body, "", false
	if i := strings.IndexByte(body, '|'); i >= 0 {
		source, filter, hasFilter = body[:i], body[i+1:], true
	}
	value := ""
	for _, ref := range splitTopLevel(strings.TrimSpace(source), "??") {
		if value = resolveRef(ref, ctx, o); value != "" {
			break
		}
	}
	if !hasFilter {
		return value
	}
	return applyFilter(value, filter, ctx.OriginURL != "" || ctx.Node != nil)
}

// splitTopLevel splits on delim outside quotes.
func splitTopLevel(expr, delim string) []string {
	var out []string
	var buf strings.Builder
	var quote byte
	for i := 0; i < len(expr); i++ {
		c := expr[i]
		if quote != 0 {
			buf.WriteByte(c)
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			buf.WriteByte(c)
			continue
		}
		if strings.HasPrefix(expr[i:], delim) {
			out = append(out, buf.String())
			buf.Reset()
			i += len(delim) - 1
			continue
		}
		buf.WriteByte(c)
	}
	return append(out, buf.String())
}

var placeholder = regexp.MustCompile(`\{\{([^}]*)\}\}`)

// RenderTemplate substitutes every {{ … }} placeholder.
func RenderTemplate(tpl string, ctx WorkerContext, o TemplateOptions) string {
	return placeholder.ReplaceAllStringFunc(tpl, func(m string) string {
		return evalExpr(m[2:len(m)-2], ctx, o)
	})
}

// InterpretWorkerTemplate turns a manifest `worker` block + a context into
// the spawn spec. `entry` is tokenized BEFORE substitution, so a value can
// never inject an extra argument.
func InterpretWorkerTemplate(w *y.Map, ctx WorkerContext, o TemplateOptions) WorkerSpec {
	if o.Env == nil {
		o.Env = func(string) string { return "" }
	}
	var spec WorkerSpec
	if entry, _ := w.Get("entry").(string); strings.TrimSpace(entry) != "" {
		tokens := strings.Fields(entry)
		spec.Command = RenderTemplate(tokens[0], ctx, o)
		spec.Args = make([]string, 0, len(tokens)-1)
		for _, t := range tokens[1:] {
			spec.Args = append(spec.Args, RenderTemplate(t, ctx, o))
		}
	} else {
		cmd, _ := w.Get("command").(string)
		spec.Command = RenderTemplate(cmd, ctx, o)
		spec.Args = []string{}
		for _, t := range strList(w.Get("args")) {
			spec.Args = append(spec.Args, RenderTemplate(t, ctx, o))
		}
	}
	spec.Env = []EnvVar{}
	if env, ok := w.Get("env").(*y.Map); ok && env != nil {
		for _, k := range env.Keys() {
			v, _ := env.Get(k).(string)
			spec.Env = append(spec.Env, EnvVar{k, RenderTemplate(v, ctx, o)})
		}
	}
	cwd, ok := w.Get("cwd").(string)
	if !ok {
		cwd = "{{workerDir}}"
	}
	spec.Cwd = RenderTemplate(cwd, ctx, o)
	return spec
}
