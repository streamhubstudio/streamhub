// Command parity is the HTTP parity harness of the Go core against the legacy
// NestJS core (the oracle). The corpus lives in test/parity/cases/*.json; the
// oracle's recorded responses in test/parity/golden/.
//
//	go run ./cmd/parity -go ./bin/streamhub                    # replay (default): Go vs golden/, no Node
//	go run ./cmd/parity -record -node <legacy>/streamhub-core  # oracle → golden/
//	go run ./cmd/parity -live -node <legacy>/streamhub-core -go ./bin/streamhub  # Node ↔ Go, live
//
// Every mode seeds a DATA_DIR through a core's own API, boots the server(s)
// on copies of it with identical env and runs the cases in order. The oracle
// lives on in the legacy/node-2.x branch (tag 2.24.0). See
// test/parity/README.md.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"
)

type options struct {
	mode      string // replay | record | live
	nodeDir   string
	nodeBin   string
	goBin     string
	vendorDir string
	casesDir  string
	golden    string
	module    string
	caseName  string
	keep      bool
	accept    bool
	verbose   bool
	extraEnv  map[string]string
}

type envFlag map[string]string

func (e envFlag) String() string { return "" }
func (e envFlag) Set(s string) error {
	k, v, ok := strings.Cut(s, "=")
	if !ok || k == "" {
		return fmt.Errorf("want KEY=VALUE, got %q", s)
	}
	e[k] = v
	return nil
}

func main() {
	os.Exit(run())
}

func run() int {
	o := &options{extraEnv: map[string]string{}}
	var record, live, replay bool
	flag.BoolVar(&replay, "replay", false, "compare Go against the recorded oracle in -golden (the default mode; no Node needed)")
	flag.BoolVar(&record, "record", false, "run only the Node oracle and (re)write -golden")
	flag.BoolVar(&live, "live", false, "run Node and Go side by side and diff them")
	flag.BoolVar(&o.accept, "accept", false, "replay: overwrite the golden entries of the selected cases with Go's responses (deliberate contract changes only — log them in internal design notes)")
	flag.StringVar(&o.nodeDir, "node", "", "legacy Node core dir (dist/main.js, node_modules, scripts/seed-token.js) — -record/-live; a checkout of legacy/node-2.x")
	flag.StringVar(&o.nodeBin, "node-bin", "node", "node executable")
	flag.StringVar(&o.goBin, "go", "./bin/streamhub", "Go core binary (-replay/-live)")
	flag.StringVar(&o.vendorDir, "vendor", "", "composed decoupled apps both cores load (default: -record/-live <node>/dist/plugins-vendor, -replay <repo>/plugins-vendor)")
	flag.StringVar(&o.casesDir, "cases", "test/parity/cases", "corpus dir (*.json)")
	flag.StringVar(&o.golden, "golden", "test/parity/golden", "recorded oracle responses")
	flag.StringVar(&o.module, "module", "", "run only this module (case file), e.g. auth")
	flag.StringVar(&o.caseName, "case", "", "report only this case (earlier cases of its file still run, as setup)")
	flag.BoolVar(&o.keep, "keep", false, "keep data dirs and server logs")
	flag.BoolVar(&o.verbose, "v", false, "print every case, not only failures")
	flag.Var(envFlag(o.extraEnv), "env", "extra KEY=VALUE for the servers (repeatable)")
	flag.Parse()

	switch {
	case record && !live && !replay:
		o.mode = "record"
	case live && !record && !replay:
		o.mode = "live"
	case !record && !live:
		o.mode = "replay"
	default:
		fmt.Fprintln(os.Stderr, "parity: -record, -live and -replay are exclusive")
		return 2
	}
	if o.accept && o.mode != "replay" {
		fmt.Fprintln(os.Stderr, "parity: -accept only applies to -replay")
		return 2
	}

	if err := o.resolve(); err != nil {
		fmt.Fprintln(os.Stderr, "parity:", err)
		return 2
	}
	files, err := loadCases(o.casesDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parity:", err)
		return 2
	}
	files = selectFiles(files, o)
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "parity: no case matches -module/-case")
		return 2
	}
	if o.mode == "replay" && !o.accept { // -accept re-baselines the vendor digest too
		if err := checkReplayVendor(o); err != nil {
			fmt.Fprintln(os.Stderr, "parity:", err)
			return 2
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	root, err := os.MkdirTemp("", "streamhub-parity-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "parity:", err)
		return 2
	}
	defer func() {
		if o.keep {
			fmt.Printf("\nkept: %s (data dirs, logs/, fixture.json)\n", root)
		} else {
			os.RemoveAll(root)
		}
	}()

	env := baseEnv()
	// Both cores must see the same composed Studio Apps.
	env["STREAMHUB_PLUGINS_VENDOR_DIR"] = o.vendorDir
	for k, v := range o.extraEnv {
		env[k] = v
	}

	seedImpl := "node"
	if o.mode == "replay" {
		seedImpl = "go"
	}
	fmt.Printf("parity: %s — seeding fixture through the %s core …\n", o.mode, seedImpl)
	vars, err := buildFixture(ctx, o, root, env, seedImpl)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parity: fixture:", err)
		o.keep = true
		return 2
	}
	if b, err := json.MarshalIndent(vars, "", "  "); err == nil {
		_ = os.WriteFile(filepath.Join(root, "fixture.json"), b, 0o644)
	}

	// One server set per env group: the default group (files without an
	// "env") keeps the data-<side>/ layout; every distinct file env gets its
	// own fixture copy (data-<side>-<n>/).
	var groups []*envGroup
	byKey := map[string]*envGroup{}
	for _, f := range files {
		k := f.envKey()
		g, ok := byKey[k]
		if !ok {
			g = &envGroup{env: f.Env}
			byKey[k] = g
			groups = append(groups, g)
		}
		g.files = append(g.files, f)
	}
	sort.SliceStable(groups, func(i, j int) bool { return len(groups[i].env) == 0 && len(groups[j].env) != 0 })

	var results []*caseResult
	for i, g := range groups {
		suffix := ""
		if len(g.env) > 0 {
			suffix = fmt.Sprintf("-%d", i)
		}
		genv := cloneEnv(env)
		for k, v := range g.env {
			genv[k] = v
		}
		servers, sideVars, err := startSet(ctx, o, root, suffix, genv)
		if err != nil {
			fmt.Fprintln(os.Stderr, "parity: boot:", err)
			o.keep = true
			return 2
		}
		rs, err := runCorpus(ctx, o, g.files, servers, vars, sideVars)
		for _, s := range servers {
			s.stop()
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "parity:", err)
			return 2
		}
		results = append(results, rs...)
	}

	failed := report(results, o)
	switch {
	case o.mode == "record":
		if failed {
			fmt.Fprintln(os.Stderr, "parity: corpus errors on the oracle — golden NOT written")
			return 1
		}
		if err := writeRecording(o, files, results); err != nil {
			fmt.Fprintln(os.Stderr, "parity: golden:", err)
			return 2
		}
		fmt.Printf("golden written to %s\n", o.golden)
	case o.accept:
		n, err := acceptResults(o, files, results)
		if err != nil {
			fmt.Fprintln(os.Stderr, "parity: accept:", err)
			return 2
		}
		fmt.Printf("accepted %d Go response(s) into %s\n", n, o.golden)
		return 0
	}
	if failed {
		return 1
	}
	return 0
}

// envGroup is the case files sharing one server env.
type envGroup struct {
	env   map[string]string
	files []*caseFile
}

func cloneEnv(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// sides lists the servers a mode boots.
func (o *options) sides() []string {
	switch o.mode {
	case "record":
		return []string{"node"}
	case "replay":
		return []string{"go"}
	}
	return []string{"node", "go"}
}

func (o *options) serverArgv(impl string) []string {
	if impl == "node" {
		return []string{o.nodeBin, filepath.Join(o.nodeDir, "dist", "main.js")}
	}
	return []string{o.goBin}
}

// startSet copies the seed into data-<side><suffix>/ and boots the mode's
// servers with env. On error the already-started servers stop.
func startSet(ctx context.Context, o *options, root, suffix string, env map[string]string) (map[string]*server, map[string]map[string]any, error) {
	servers := map[string]*server{}
	sideVars := map[string]map[string]any{} // per-side extras (paths differ by side)
	fail := func(err error) (map[string]*server, map[string]map[string]any, error) {
		for _, s := range servers {
			s.stop()
		}
		return nil, nil, err
	}
	for _, side := range o.sides() {
		dataDir := filepath.Join(root, "data-"+side+suffix)
		cwd := filepath.Join(root, "cwd-"+side+suffix)
		if err := copyDir(filepath.Join(root, "seed-data"), dataDir); err != nil {
			return fail(fmt.Errorf("copy seed: %w", err))
		}
		if err := os.MkdirAll(cwd, 0o755); err != nil {
			return fail(err)
		}
		if err := writeVersion(cwd); err != nil {
			return fail(err)
		}
		s, err := startServer(ctx, serverSpec{
			label:   side,
			argv:    o.serverArgv(side),
			cwd:     cwd,
			dataDir: dataDir,
			logPath: filepath.Join(root, "logs", side+suffix+".log"),
			env:     env,
		})
		if err != nil {
			return fail(err)
		}
		servers[side] = s
		sideVars[side] = map[string]any{"dataDir": dataDir}
		fmt.Printf("parity: %s%s up at %s\n", side, suffix, s.baseURL)
	}
	return servers, sideVars, nil
}

func (o *options) resolve() error {
	var err error
	if o.mode != "replay" {
		if o.nodeDir == "" {
			return fmt.Errorf("-%s needs -node <legacy/node-2.x checkout>/streamhub-core (git worktree add ../node2 legacy/node-2.x)", o.mode)
		}
		if o.nodeDir, err = filepath.Abs(o.nodeDir); err != nil {
			return err
		}
		if _, err := os.Stat(filepath.Join(o.nodeDir, "dist", "main.js")); err != nil {
			return fmt.Errorf("-node %s: dist/main.js missing (npm ci && npm run build there): %w", o.nodeDir, err)
		}
		if _, err := exec.LookPath(o.nodeBin); err != nil {
			return fmt.Errorf("-node-bin: %w", err)
		}
		if o.vendorDir == "" {
			// Node loads <dist>/plugins-vendor unconditionally; Go follows it.
			o.vendorDir = filepath.Join(o.nodeDir, "dist", "plugins-vendor")
		}
	}
	if o.mode != "record" {
		if o.goBin, err = filepath.Abs(o.goBin); err != nil {
			return err
		}
		if st, err := os.Stat(o.goBin); err != nil || st.IsDir() {
			return fmt.Errorf("-go %s: binary not found (go build -o bin/streamhub ./cmd/streamhub)", o.goBin)
		}
	}
	if o.vendorDir == "" {
		// replay: the repo's composed vendor dir (cwd = streamhub-core-go/).
		o.vendorDir = filepath.Join("..", "plugins-vendor")
	}
	if o.vendorDir, err = filepath.Abs(o.vendorDir); err != nil {
		return err
	}
	if o.golden, err = filepath.Abs(o.golden); err != nil {
		return err
	}
	return nil
}

// checkReplayVendor refuses to replay against a different set of composed apps
// than the recording saw: catalog/export responses depend on it.
func checkReplayVendor(o *options) error {
	m, err := readMeta(o.golden)
	if err != nil {
		return fmt.Errorf("golden %s: %w (record first)", o.golden, err)
	}
	got, apps, err := vendorDigest(o.vendorDir)
	if err != nil {
		return fmt.Errorf("vendor dir %s: %w — compose the apps pinned in apps.lock.json first (-vendor to override)", o.vendorDir, err)
	}
	if got != m.VendorDigest {
		return fmt.Errorf("vendor dir %s (%s: %s) differs from the recording's (%s: %s) — compose exactly apps.lock.json, or re-baseline with -accept",
			o.vendorDir, got, shortList(apps), m.VendorDigest, shortList(m.VendorApps))
	}
	return nil
}

func selectFiles(files []*caseFile, o *options) []*caseFile {
	var out []*caseFile
	for _, f := range files {
		if o.module != "" && f.Module != o.module {
			continue
		}
		if o.caseName != "" {
			found := false
			for _, c := range f.Cases {
				found = found || c.Name == o.caseName
			}
			if !found {
				continue
			}
		}
		out = append(out, f)
	}
	return out
}

// caseResult is the outcome of one case.
type caseResult struct {
	file    *caseFile
	c       *tcase
	status  string // pass | fail | skip | error
	reasons []string
	refCode int       // reference status (Node live / recorded), 0 = none
	node    *observed // Node's observation (-live/-record)
	goObs   *observed // Go's observation (-live/-replay)
}

func runCorpus(ctx context.Context, o *options, files []*caseFile, servers map[string]*server, fixture map[string]any, sideVars map[string]map[string]any) ([]*caseResult, error) {
	var results []*caseResult
	for _, f := range files {
		var golden map[string]*goldenEntry
		if o.mode == "replay" {
			g, err := loadGolden(o.golden, f.Module)
			if err != nil && !o.accept {
				return nil, fmt.Errorf("golden for %s: %w", f.Module, err)
			}
			if g != nil {
				golden = g.index()
			}
		}
		// Every file starts from the fixture vars; captures are per side.
		vars := map[string]map[string]any{}
		for side := range servers {
			vars[side] = cloneVars(fixture)
			for k, v := range sideVars[side] {
				vars[side][k] = v
			}
		}
		targetIdx := len(f.Cases) - 1
		if o.caseName != "" {
			for i, c := range f.Cases {
				if c.Name == o.caseName {
					targetIdx = i
				}
			}
		}
		for _, c := range f.Cases[:targetIdx+1] {
			if ctx.Err() != nil {
				return results, nil
			}
			res := runCase(o, f, c, servers, vars, golden)
			if o.caseName != "" && c.Name != o.caseName {
				continue // setup only
			}
			results = append(results, res)
		}
	}
	return results, nil
}

func cloneVars(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func runCase(o *options, f *caseFile, c *tcase, servers map[string]*server, vars map[string]map[string]any, golden map[string]*goldenEntry) *caseResult {
	res := &caseResult{file: f, c: c, status: "pass"}
	if c.Skip != "" {
		res.status = "skip"
		res.reasons = []string{c.Skip}
		return res
	}
	resp := map[string]*response{}
	for _, side := range []string{"node", "go"} {
		s, ok := servers[side]
		if !ok {
			continue
		}
		if c.SleepMs > 0 {
			time.Sleep(time.Duration(c.SleepMs) * time.Millisecond)
		}
		r := execute(s.baseURL, c, f.Defaults.Headers, vars[side])
		resp[side] = r
		if r.Err != nil {
			res.status = "error"
			res.reasons = append(res.reasons, fmt.Sprintf("%s: %v", side, r.Err))
			continue
		}
		for _, e := range capture(c, r, vars[side]) {
			res.status = "error"
			res.reasons = append(res.reasons, side+": "+e)
		}
	}

	// The reference: Node, live or recorded.
	var ref *observed
	if nr := resp["node"]; nr != nil && nr.Err == nil {
		ref = observe(nr, c, f.Defaults, vars["node"])
		res.node, res.refCode = ref, nr.Status
		if c.ExpectStatus != 0 && nr.Status != c.ExpectStatus {
			res.status = "error"
			res.reasons = append(res.reasons, fmt.Sprintf("corpus: node answered %d, case expects %d — fix the case (body: %s)", nr.Status, c.ExpectStatus, truncate(string(nr.Raw), 300)))
		}
	}
	if gr := resp["go"]; gr != nil && gr.Err == nil {
		res.goObs = observe(gr, c, f.Defaults, vars["go"])
	}
	if o.mode == "replay" {
		e := golden[c.Name]
		switch {
		case e == nil:
			res.status = "error"
			res.reasons = append(res.reasons, "no golden entry — record it (-record against legacy/node-2.x) or review Go's answer and -accept it")
			return res
		case e.Fingerprint != fingerprint(f, c):
			res.status = "error"
			res.reasons = append(res.reasons, fmt.Sprintf("golden stale: the case changed since it was recorded (%s ≠ %s) — re-record, or review and -accept", e.Fingerprint, fingerprint(f, c)))
			return res
		case e.Skip != "":
			res.status = "error"
			res.reasons = append(res.reasons, "golden entry was recorded as skipped ("+e.Skip+") — nothing to compare against")
			return res
		}
		var err error
		if ref, err = e.observed(); err != nil {
			res.status = "error"
			res.reasons = append(res.reasons, err.Error())
			return res
		}
		res.refCode = ref.Status
	}

	if ref == nil || res.goObs == nil {
		return res
	}
	if diffs := diffObserved(c, f.Defaults, ref, res.goObs); len(diffs) > 0 {
		if res.status == "pass" {
			res.status = "fail"
		}
		res.reasons = append(res.reasons, diffs...)
	}
	return res
}

func compareHeaderList(c *tcase, d defaults) []string {
	seen := map[string]bool{}
	var out []string
	for _, h := range append(append([]string{}, d.CompareHeaders...), c.CompareHeaders...) {
		k := strings.ToLower(h)
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// normalizedBody: JSON → normalized value; anything else → normalized text.
func normalizedBody(r *response, c *tcase, d defaults, vars map[string]any) any {
	if r.IsJSON && c.Compare != "text" {
		return prepareBody(r.JSON, c, d, vars)
	}
	return newNormalizer(vars, c.Strict).str(string(r.Raw))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// writeRecording stores the oracle's observations (and skips, with their
// reason) and the recording's meta.
func writeRecording(o *options, files []*caseFile, results []*caseResult) error {
	byFile := map[*caseFile]map[string]*goldenEntry{}
	for _, r := range results {
		e := newGoldenEntry(r.file, r.c)
		if r.status != "skip" {
			if r.node == nil {
				return fmt.Errorf("%s/%s: no oracle response", r.file.Module, r.c.Name)
			}
			if err := e.setObserved(r.node, r.c); err != nil {
				return fmt.Errorf("%s/%s: %w", r.file.Module, r.c.Name, err)
			}
		}
		if byFile[r.file] == nil {
			byFile[r.file] = map[string]*goldenEntry{}
		}
		byFile[r.file][r.c.Name] = e
	}
	for _, f := range files {
		if err := mergeGolden(o.golden, f, byFile[f]); err != nil {
			return err
		}
	}
	digest, apps, err := vendorDigest(o.vendorDir)
	if err != nil {
		return fmt.Errorf("vendor dir %s: %w", o.vendorDir, err)
	}
	return writeMeta(o.golden, &goldenMeta{
		Oracle:       "streamhub-core (NestJS) 2.x — branch legacy/node-2.x, tag 2.24.0",
		AppVersion:   parityVersion,
		VendorDigest: digest,
		VendorApps:   apps,
		Note:         "Recorded by `go run ./cmd/parity -record`. Entries with \"source\": \"go\" were accepted from the Go core with -accept (see internal design notes).",
	})
}

// acceptResults re-baselines the selected cases from Go's responses.
func acceptResults(o *options, files []*caseFile, results []*caseResult) (int, error) {
	n := 0
	byFile := map[*caseFile]map[string]*goldenEntry{}
	old := map[string]map[string]*goldenEntry{} // module → recorded entries
	for _, r := range results {
		e := newGoldenEntry(r.file, r.c)
		if r.status != "skip" {
			if r.goObs == nil {
				return n, fmt.Errorf("%s/%s: Go gave no response to accept: %s", r.file.Module, r.c.Name, strings.Join(r.reasons, "; "))
			}
			if err := e.setObserved(r.goObs, r.c); err != nil {
				return n, err
			}
			if r.status != "pass" {
				e.Source = "go"
				n++
			}
		}
		if byFile[r.file] == nil {
			byFile[r.file] = map[string]*goldenEntry{}
		}
		// Keep untouched passing entries byte-identical (their source too).
		if r.status == "pass" {
			idx, ok := old[r.file.Module]
			if !ok {
				if g, err := loadGolden(o.golden, r.file.Module); err == nil {
					idx = g.index()
				}
				old[r.file.Module] = idx
			}
			if prev := idx[r.c.Name]; prev != nil {
				e = prev
			}
		}
		byFile[r.file][r.c.Name] = e
	}
	for _, f := range files {
		if err := mergeGolden(o.golden, f, byFile[f]); err != nil {
			return n, err
		}
	}
	// The accepted responses were observed with this vendor composition.
	m, err := readMeta(o.golden)
	if err != nil {
		return n, err
	}
	if m.VendorDigest, m.VendorApps, err = vendorDigest(o.vendorDir); err != nil {
		return n, fmt.Errorf("vendor dir %s: %w", o.vendorDir, err)
	}
	return n, writeMeta(o.golden, m)
}

func report(results []*caseResult, o *options) bool {
	type agg struct{ pass, fail, skip, errs int }
	byMod := map[string]*agg{}
	var mods []string
	failed := false
	ref := map[string]string{"live": "node", "record": "node", "replay": "golden"}[o.mode]
	for _, r := range results {
		mod := r.file.Module
		a, ok := byMod[mod]
		if !ok {
			a = &agg{}
			byMod[mod] = a
			mods = append(mods, mod)
		}
		label := strings.ToUpper(r.status)
		switch r.status {
		case "pass":
			a.pass++
		case "skip":
			a.skip++
		case "fail":
			a.fail++
			failed = true
		case "error":
			a.errs++
			failed = true
		}
		if (r.status == "pass" || r.status == "skip") && !o.verbose {
			continue
		}
		code := ""
		if r.refCode != 0 {
			code = fmt.Sprintf(" [%s %d]", ref, r.refCode)
		}
		fmt.Printf("%-5s %s/%s — %s %s%s\n", label, mod, r.c.Name, r.c.Method, r.c.Path, code)
		lines := r.reasons
		if len(lines) > 40 {
			lines = append(lines[:40:40], fmt.Sprintf("… %d more", len(r.reasons)-40))
		}
		for _, l := range lines {
			fmt.Printf("      %s\n", l)
		}
	}
	sort.Strings(mods)
	fmt.Println()
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MODULE\tPASS\tFAIL\tERROR\tSKIP\tTOTAL")
	var t agg
	for _, m := range mods {
		a := byMod[m]
		fmt.Fprintf(tw, "%s\t%d\t%d\t%d\t%d\t%d\n", m, a.pass, a.fail, a.errs, a.skip, a.pass+a.fail+a.errs+a.skip)
		t.pass, t.fail, t.errs, t.skip = t.pass+a.pass, t.fail+a.fail, t.errs+a.errs, t.skip+a.skip
	}
	fmt.Fprintf(tw, "TOTAL\t%d\t%d\t%d\t%d\t%d\n", t.pass, t.fail, t.errs, t.skip, t.pass+t.fail+t.errs+t.skip)
	tw.Flush()
	switch o.mode {
	case "record":
		fmt.Println("(record: PASS = the oracle answered and the case's expectStatus held)")
	case "replay":
		fmt.Println("(replay: Go vs the oracle recorded in " + o.golden + ")")
	}
	return failed
}
