package opsfmt

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Usage lists the views (stdin = the REST response body).
const Usage = `usage: streamhub-core opsfmt <view> [args]   (reads a /api/v1 JSON response on stdin)

  node-id <ref>   id of the /edge/nodes entry whose id or name is <ref> (exit 3: none)
  nodes           the 'streamhub cluster status' node table
  assignments     /edge/assignments counted by status
  nodes-json      the .data of /edge/nodes as indented JSON
  events          /logs?source=edge lines
  command         an /edge/nodes/:id/command result
  api-error       the message of an error body ("" when there is none)
  pin             an app plugin-version view (pin + effective)
  versions        a plugin version catalog / app version view
  pushed          the manifest of a pushed plugin version
`

// Run renders view from the JSON on stdin; it is `streamhub-core opsfmt`.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprint(stderr, Usage)
		if len(args) == 0 {
			return 2
		}
		return 0
	}
	view, rest := args[0], args[1:]
	render, ok := views[view]
	if !ok {
		fmt.Fprintf(stderr, "opsfmt: unknown view %q\n%s", view, Usage)
		return 2
	}
	if view == "node-id" && len(rest) != 1 {
		fmt.Fprintln(stderr, "usage: streamhub-core opsfmt node-id <ref>")
		return 2
	}
	doc, err := decode(stdin)
	if err != nil {
		if view == "api-error" { // a non-JSON error body → no message
			fmt.Fprintln(stdout)
			return 0
		}
		fmt.Fprintln(stderr, "opsfmt: invalid JSON:", err)
		return 1
	}
	top, isObj := doc.(*obj)
	if !isObj {
		if view == "api-error" {
			fmt.Fprintln(stdout)
			return 0
		}
		fmt.Fprintln(stderr, "opsfmt: expected a JSON object")
		return 1
	}
	var b strings.Builder
	code := render(&b, top, rest)
	io.WriteString(stdout, b.String())
	return code
}

type renderer func(b *strings.Builder, top *obj, args []string) int

var views = map[string]renderer{
	"node-id":     nodeID,
	"nodes":       nodes,
	"assignments": assignments,
	"nodes-json":  nodesJSON,
	"events":      events,
	"command":     command,
	"api-error":   apiError,
	"pin":         pin,
	"versions":    versions,
	"pushed":      pushed,
}

func line(b *strings.Builder, s string) { b.WriteString(s + "\n") }

func dataList(top *obj) []any { return asList(top.getOr("data", []any{})) }
func dataObj(top *obj) *obj   { return asObj(top.getOr("data", nil)) }

// table prints rows as left-justified columns, two-space indented and
// separated (the Python `"  " + "  ".join(r[i].ljust(w[i]) ...)`).
func table(b *strings.Builder, rows [][]string) {
	w := make([]int, len(rows[0]))
	for _, r := range rows {
		for i, c := range r {
			if n := width(c); n > w[i] {
				w[i] = n
			}
		}
	}
	for _, r := range rows {
		cells := make([]string, len(r))
		for i, c := range r {
			cells[i] = ljust(c, w[i])
		}
		line(b, "  "+strings.Join(cells, "  "))
	}
}

func nodeID(b *strings.Builder, top *obj, args []string) int {
	ref := args[0]
	for _, x := range dataList(top) {
		n := asObj(x)
		id, _ := n.get("id")
		name, _ := n.get("name")
		if pyEq(id, ref) || pyEq(name, ref) {
			line(b, pyStr(id))
			return 0
		}
	}
	return 3
}

func pct(x any) string {
	f, ok := pyFloatOf(x)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return "-"
	}
	r := math.RoundToEven(f * 100)
	if r == 0 {
		r = 0 // no "-0"
	}
	return strconv.FormatFloat(r, 'f', 0, 64) + "%"
}

func nodes(b *strings.Builder, top *obj, _ []string) int {
	rows := [][]string{{"NODE", "TYPE", "STATE", "CPU", "MEM", "DISK", "GPU", "VRAMFREE", "WT"}}
	for _, x := range dataList(top) {
		n := asObj(x)
		st := asObj(or(n.getOr("stats", nil), nil))
		grid := asObj(or(st.getOr("grid", nil), nil))
		disk := asObj(or(st.getOr("disk", nil), nil))
		state := "up"
		if truthy(n.getOr("stale", nil)) {
			state = "stale"
		}
		gpu := grid.getOr("gpuName", nil)
		if !truthy(gpu) {
			if truthy(grid.getOr("gpu", nil)) {
				gpu = "yes"
			} else {
				gpu = "no"
			}
		}
		vram := "-"
		if v := grid.getOr("vramFreeMb", nil); v != nil {
			vram = pyStr(v)
		}
		rows = append(rows, []string{
			pyStr(n.getOr("name", "?")), pyStr(n.getOr("type", "?")), state,
			pct(st.getOr("cpu", nil)), pct(st.getOr("memUsedRatio", nil)), pct(disk.getOr("usedRatio", nil)),
			pyStr(gpu), vram, pyStr(n.getOr("weight", "-")),
		})
	}
	if len(rows) == 1 {
		line(b, "  (no nodes registered)")
		return 0
	}
	table(b, rows)
	return 0
}

func assignments(b *strings.Builder, top *obj, _ []string) int {
	count := map[string]int{}
	for _, x := range dataList(top) {
		count[pyStr(asObj(x).getOr("status", "unknown"))]++
	}
	order := []string{"running", "offered", "pending", "failed", "stopped", "revoked"}
	known := map[string]bool{}
	var keys []string
	for _, k := range order {
		known[k] = true
		if _, ok := count[k]; ok {
			keys = append(keys, k)
		}
	}
	var extra []string
	for k := range count {
		if !known[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra) // UTF-8 byte order == Python's code-point order
	keys = append(keys, extra...)
	if len(keys) == 0 {
		line(b, "  (no assignments)")
		return 0
	}
	for _, k := range keys {
		line(b, fmt.Sprintf("  %s %d", ljust(k, 9), count[k]))
	}
	line(b, fmt.Sprintf("  %s %d  (parked — no eligible node)", ljust("PENDING", 9), count["pending"]))
	return 0
}

func nodesJSON(b *strings.Builder, top *obj, _ []string) int {
	dumpIndent(b, top.getOr("data", []any{}), 0)
	b.WriteString("\n")
	return 0
}

func events(b *strings.Builder, top *obj, _ []string) int {
	data := top.getOr("data", []any{})
	if !truthy(data) {
		line(b, "  (no edge events)")
	}
	for _, x := range asList(data) {
		e := asObj(x)
		line(b, fmt.Sprintf("  %s  %s  %s",
			pyStr(e.getOr("ts", "?")), ljust(strings.ToUpper(pyStr(e.getOr("level", "?"))), 5), pyStr(e.getOr("message", ""))))
	}
	return 0
}

func command(b *strings.Builder, top *obj, _ []string) int {
	d := dataObj(top)
	out := d.getOr("output", nil)
	tail := ""
	if truthy(out) {
		tail = "  output=" + pyStr(out)
	}
	line(b, "  ok="+pyStr(d.getOr("ok", nil))+tail)
	return 0
}

// apiError pulls the message out of a Nest-style error body
// ({statusCode,message,error}); message may be a class-validator array.
func apiError(b *strings.Builder, top *obj, _ []string) int {
	m := top.getOr("message", nil)
	if m == nil {
		m = top.getOr("error", nil)
	}
	if l, ok := m.([]any); ok {
		parts := make([]string, len(l))
		for i, x := range l {
			parts[i] = pyStr(x)
		}
		m = strings.Join(parts, "; ")
	}
	line(b, pyStr(or(m, "")))
	return 0
}

func pin(b *strings.Builder, top *obj, _ []string) int {
	d := dataObj(top)
	line(b, "  pin:       "+pyStr(or(d.getOr("active", nil), "(none — runs built-in/latest)")))
	line(b, "  effective: "+pyStr(or(d.getOr("effective", nil), "-")))
	return 0
}

func human(x any) string {
	n, ok := pyFloatOf(x)
	if !ok {
		return "-"
	}
	for _, u := range []string{"B", "KiB", "MiB", "GiB"} {
		if n < 1024 || u == "GiB" {
			if u == "B" {
				t := math.Trunc(n)
				if t == 0 {
					t = 0
				}
				return strconv.FormatFloat(t, 'f', 0, 64) + " " + u
			}
			return fmt.Sprintf("%.1f %s", n, u)
		}
		n /= 1024
	}
	return "-"
}

func stamp(v any) string {
	s := pyStr(or(v, ""))
	return strings.ReplaceAll(head(s, 19), "T", " ")
}

func versions(b *strings.Builder, top *obj, _ []string) int {
	d := dataObj(top)
	var (
		cat               *obj
		effective, active any
		history           []any
		app               any
	)
	if _, ok := d.get("available"); ok {
		cat = asObj(or(d.getOr("available", nil), nil))
		effective = d.getOr("effective", nil)
		active = d.getOr("active", nil)
		history = asList(or(d.getOr("history", nil), []any{}))
		app = d.getOr("app", nil)
	} else {
		cat = d
	}
	rows := [][]string{{"VERSION", "SOURCE", "SIZE", "CREATED", "FLAGS"}}
	for _, x := range asList(or(cat.getOr("versions", nil), []any{})) {
		v := asObj(x)
		var f []string
		if truthy(v.getOr("builtin", nil)) {
			f = append(f, "builtin")
		}
		if truthy(v.getOr("latest", nil)) {
			f = append(f, "latest")
		}
		if effective != nil && pyEq(v.getOr("version", nil), effective) {
			f = append(f, "ACTIVE")
		}
		flags := strings.Join(f, ",")
		if flags == "" {
			flags = "-"
		}
		created := "-"
		if s := stamp(v.getOr("createdAt", nil)); s != "" {
			created = s
		}
		rows = append(rows, []string{pyStr(v.getOr("version", "?")), pyStr(v.getOr("source", "?")),
			human(v.getOr("bundleBytes", nil)), created, flags})
	}
	if len(rows) == 1 {
		line(b, "  (no versions stored — the built-in materializes at first boot)")
	} else {
		table(b, rows)
	}
	if app != nil {
		line(b, "")
		line(b, fmt.Sprintf("  app %s: pin=%s  effective=%s", pyRepr(app), pyStr(or(active, "(none)")), pyStr(or(effective, "-"))))
		if len(history) > 0 {
			line(b, "  history (newest first):")
			if len(history) > 20 {
				history = history[:20]
			}
			for _, x := range history {
				h := asObj(x)
				line(b, fmt.Sprintf("    %s  %s -> %s", stamp(h.getOr("at", nil)),
					pyStr(or(h.getOr("from", nil), "builtin")), pyStr(or(h.getOr("to", nil), "builtin"))))
			}
		}
	}
	return 0
}

func pushed(b *strings.Builder, top *obj, _ []string) int {
	m := dataObj(top)
	files := asObj(or(m.getOr("files", nil), nil))
	line(b, "  plugin:  "+pyStr(m.getOr("pluginId", "?")))
	line(b, "  version: "+pyStr(m.getOr("version", "?")))
	line(b, "  source:  "+pyStr(m.getOr("source", "?")))
	line(b, "  sha256:  "+pyStr(m.getOr("sha256", "?")))
	line(b, fmt.Sprintf("  size:    %s bytes (%s files)", pyStr(files.getOr("bytes", "?")), pyStr(files.getOr("count", "?"))))
	if notes := m.getOr("notes", nil); truthy(notes) {
		line(b, "  notes:   "+pyStr(notes))
	}
	return 0
}
