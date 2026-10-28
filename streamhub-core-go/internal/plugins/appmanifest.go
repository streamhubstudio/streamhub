package plugins

import (
	"fmt"
	"path/filepath"
	"strings"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of app-manifest.ts: validation of a declarative `streamhub.app.json`
// (the same bar as a built-in meta) and its projection to a Meta whose spawn
// is the template interpreter.

func validateManifestWorker(raw any) string {
	w, ok := raw.(*y.Map)
	if !ok || w == nil {
		return "worker must be an object"
	}
	entry, _ := w.Get("entry").(string)
	cmd, _ := w.Get("command").(string)
	if w.Get("needsWorker") == true && strings.TrimSpace(entry) == "" && cmd == "" {
		return "worker needs an 'entry' string or a 'command'"
	}
	if env := w.Get("env"); !y.IsUndefined(env) {
		m, ok := env.(*y.Map)
		if !ok || m == nil {
			return "worker.env must be an object of string templates"
		}
		for _, k := range m.Keys() {
			if !isStr(m.Get(k)) {
				return fmt.Sprintf("worker.env.%s must be a string template", k)
			}
		}
	}
	if args := w.Get("args"); !y.IsUndefined(args) {
		list, ok := args.([]any)
		bad := !ok
		for _, a := range list {
			bad = bad || !isStr(a)
		}
		if bad {
			return "worker.args must be an array of string templates"
		}
	}
	placement := w.Get("placement")
	if !y.IsUndefined(placement) && !placements[jsString(placement)] {
		return fmt.Sprintf("invalid worker.placement '%s' (local|grid)", jsString(placement))
	}
	if e := w.Get("edge"); !y.IsUndefined(e) {
		if _, ok := e.(bool); !ok {
			return "worker.edge must be a boolean"
		}
	}
	if g := w.Get("grid"); !y.IsUndefined(g) {
		if placement != "grid" {
			return "worker.grid requirements need worker.placement 'grid'"
		}
		if _, ok := g.(*y.Map); !ok {
			return "worker.grid must be an object"
		}
	}
	return ""
}

// ValidateAppManifest returns every validation error ([] = valid). folder,
// when non-nil, enforces id == folder name.
func ValidateAppManifest(raw any, folder *string) []string {
	m, ok := raw.(*y.Map)
	if !ok || m == nil {
		return []string{"manifest is not an object"}
	}
	var errs []string
	id, isID := m.Get("id").(string)
	switch {
	case !isID || id == "":
		errs = append(errs, "missing string id")
	case !idSlug.MatchString(id):
		errs = append(errs, fmt.Sprintf("id '%s' must be a lowercase slug", id))
	case folder != nil && id != *folder:
		errs = append(errs, fmt.Sprintf("id '%s' must equal folder name '%s'", id, *folder))
	}
	if n, _ := m.Get("name").(string); n == "" {
		errs = append(errs, "missing name")
	}
	if !isStr(m.Get("description")) {
		errs = append(errs, "missing description")
	}
	if c, _ := m.Get("category").(string); !categories[c] {
		errs = append(errs, fmt.Sprintf("invalid category '%s'", jsString(m.Get("category"))))
	}
	if u, _ := m.Get("ui").(string); !uiSlots[u] {
		errs = append(errs, fmt.Sprintf("invalid ui slot '%s'", jsString(m.Get("ui"))))
	}
	if v, ok := m.Get("version").(string); !ok || !semverRe.MatchString(v) {
		errs = append(errs, fmt.Sprintf("invalid version '%s' (expected semver)", jsString(m.Get("version"))))
	}
	if k := m.Get("kind"); !y.IsUndefined(k) {
		if s, _ := k.(string); !kinds[s] {
			errs = append(errs, fmt.Sprintf("invalid kind '%s' (plugin|app)", jsString(k)))
		}
	}
	if db := prop(m.Get("storage"), "db"); !y.IsUndefined(db) {
		if s, ok := db.(string); !ok || !isBareFilename(s) {
			errs = append(errs, fmt.Sprintf("storage.db '%s' must be a bare filename", jsString(db)))
		}
	}
	if ex := m.Get("export"); !y.IsUndefined(ex) {
		if kind, _ := y.Coalesce(m.Get("kind"), "app").(string); kind != "app" {
			errs = append(errs, "export is only valid on kind 'app'")
		}
		if d := prop(ex, "workerDir"); !y.IsUndefined(d) {
			if s, ok := d.(string); !ok || !isBareFilename(s) {
				errs = append(errs, fmt.Sprintf("export.workerDir '%s' must be a bare directory name", jsString(d)))
			}
		}
	}
	if ev := m.Get("events"); !y.IsUndefined(ev) {
		list, ok := ev.([]any)
		bad := !ok
		for _, e := range list {
			bad = bad || !isStr(e)
		}
		if bad {
			errs = append(errs, "events must be an array of strings")
		}
	}
	if schema, ok := m.Get("configSchema").([]any); !ok {
		errs = append(errs, "configSchema must be an array")
	} else {
		seen := map[string]bool{}
		for _, f := range schema {
			if fe := validateField(f, seen); fe != "" {
				errs = append(errs, fe)
			}
		}
	}
	if w := m.Get("worker"); !y.IsUndefined(w) {
		if we := validateManifestWorker(w); we != "" {
			errs = append(errs, we)
		}
	}
	return errs
}

// SynthesizeOptions resolve a package's worker dir.
type SynthesizeOptions struct {
	PackageDir string
	WorkerDir  string // explicit override
	Env        func(string) string
}

// SynthesizeMeta projects a VALIDATED manifest to a Meta.
func SynthesizeMeta(m *y.Map, o SynthesizeOptions) *Meta {
	meta := baseMeta(m)
	if meta.Kind == nil {
		app := "app"
		meta.Kind = &app
	}
	if meta.Events == nil {
		meta.Events = []string{}
	}
	if y.Truthy(m.Get("icon")) {
		meta.Icon = strPtr(m.Get("icon"))
	} else {
		meta.Icon = nil
	}
	if db := prop(m.Get("storage"), "db"); y.Truthy(db) {
		meta.StorageSet, meta.StorageDB = true, strPtr(db)
	}
	if d := prop(m.Get("export"), "workerDir"); y.Truthy(d) {
		meta.ExportSet, meta.ExportDir = true, strPtr(d)
	}
	w, _ := m.Get("worker").(*y.Map)
	if w != nil && w.Get("needsWorker") == true {
		workerDir := resolveManifestWorkerDir(w, o)
		env := o.Env
		meta.NeedsWorker = true
		d := &WorkerDescriptor{Edge: w.Get("edge") == true, Grid: gridFrom(w.Get("grid"))}
		if p, ok := w.Get("placement").(string); ok {
			d.Placement = p
		}
		d.Spawn = func(ctx WorkerContext) WorkerSpec {
			return InterpretWorkerTemplate(w, ctx, TemplateOptions{WorkerDir: workerDir, Env: env})
		}
		meta.Worker = d
	}
	return meta
}

func resolveManifestWorkerDir(w *y.Map, o SynthesizeOptions) string {
	if o.WorkerDir != "" {
		return o.WorkerDir
	}
	declared, _ := w.Get("workerDir").(string)
	if declared != "" && filepath.IsAbs(declared) {
		return declared
	}
	if declared == "" {
		declared = "worker"
	}
	return filepath.Join(o.PackageDir, declared)
}
