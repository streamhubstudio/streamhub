package plugins

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of plugin-registry.service.ts. The in-tree (built-in) metas are
// declarative JSON embedded from builtin/builtins.json — THE source of truth
// for them (originally exported from the Node core's plugin.meta.ts files,
// tag 2.24.0; see builtin/README.md). A meta's `worker.spawn` names a Go func
// (builtinSpawn). Vendored packages (`<vendorRoot>/<id>/streamhub.app.json`)
// are discovered at runtime with the same semantics as Node.

//go:embed builtin/builtins.json
var builtinsJSON []byte

var (
	categories = set("tool", "processor", "panel")
	uiSlots    = set("app-tab", "panel", "player-overlay", "player")
	kinds      = set("plugin", "app")
	fieldTypes = set("string", "number", "boolean", "select", "secret")
	placements = set("local", "grid")
	idSlug     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	semverRe   = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$`)
)

func set(vals ...string) map[string]bool {
	m := map[string]bool{}
	for _, v := range vals {
		m[v] = true
	}
	return m
}

// Registry is the plugin catalog.
type Registry struct {
	log        *slog.Logger
	env        func(string) string
	vendorRoot string
	paths      Paths

	mu      sync.RWMutex
	plugins map[string]*Meta
}

// NewRegistry builds the registry; call Discover to populate it.
func NewRegistry(paths Paths, env func(string) string, log *slog.Logger) *Registry {
	if env == nil {
		env = os.Getenv
	}
	return &Registry{log: log, env: env, vendorRoot: paths.VendorRoot, paths: paths, plugins: map[string]*Meta{}}
}

// pluginsEnabled: off only for an explicit false/0/off/no.
func (r *Registry) pluginsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(r.env("STREAMHUB_PLUGINS_ENABLE"))) {
	case "false", "0", "off", "no":
		return false
	}
	return true
}

// Discover (re)loads the catalog: built-ins first, then vendored packages
// (an in-tree id always wins a collision).
func (r *Registry) Discover() {
	found := map[string]*Meta{}
	defer func() {
		r.mu.Lock()
		r.plugins = found
		r.mu.Unlock()
	}()
	if !r.pluginsEnabled() {
		r.log.Info("plugins disabled (STREAMHUB_PLUGINS_ENABLE=false); 0 plugins loaded")
		return
	}
	r.loadBuiltins(found)
	r.discoverVendor(found)
	ids := make([]string, 0, len(found))
	for id := range found {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	list := strings.Join(ids, ", ")
	if list == "" {
		list = "(none)"
	}
	r.log.Info(fmt.Sprintf("discovered %d plugin(s): %s", len(found), list))
}

func (r *Registry) loadBuiltins(found map[string]*Meta) {
	parsed, err := y.ParseJSON(builtinsJSON)
	if err != nil {
		r.log.Error("builtin plugin catalog unreadable: " + err.Error())
		return
	}
	list, _ := parsed.([]any)
	for _, raw := range list {
		m, _ := raw.(*y.Map)
		id, _ := prop(m, "id").(string)
		if err := validateBuiltin(m, id); err != "" {
			r.log.Error(fmt.Sprintf("skipping plugin '%s': %s", id, err))
			continue
		}
		if _, dup := found[id]; dup {
			r.log.Error(fmt.Sprintf("duplicate plugin id '%s' (folder '%s') — skipped", id, id))
			continue
		}
		found[id] = r.builtinMeta(m)
	}
}

func (r *Registry) discoverVendor(found map[string]*Meta) {
	entries, err := os.ReadDir(r.vendorRoot)
	if err != nil {
		return // no vendor dir → nothing to do (the common case)
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), "_") {
			continue
		}
		dir := filepath.Join(r.vendorRoot, e.Name())
		data, err := os.ReadFile(filepath.Join(dir, "streamhub.app.json"))
		if err != nil {
			continue
		}
		raw, err := y.ParseJSON(data)
		if err != nil {
			r.log.Error(fmt.Sprintf("skipping vendored app '%s': manifest is not valid JSON (%s)", e.Name(), err))
			continue
		}
		folder := e.Name()
		if errs := ValidateAppManifest(raw, &folder); len(errs) > 0 {
			r.log.Error(fmt.Sprintf("skipping vendored app '%s': %s", e.Name(), strings.Join(errs, "; ")))
			continue
		}
		m := raw.(*y.Map)
		id := m.Get("id").(string)
		if _, dup := found[id]; dup {
			r.log.Warn(fmt.Sprintf("vendored app '%s' shadows an in-tree plugin — keeping the in-tree one, skipping the vendored package", id))
			continue
		}
		found[id] = SynthesizeMeta(m, SynthesizeOptions{PackageDir: dir, Env: r.env})
	}
}

var nameCollator = collate.New(language.Und)
var collatorMu sync.Mutex

// localeCompare is String#localeCompare (ICU root collation).
func localeCompare(a, b string) int {
	collatorMu.Lock()
	defer collatorMu.Unlock()
	return nameCollator.CompareString(a, b)
}

// ListManifests is the catalog sorted by name (localeCompare).
func (r *Registry) ListManifests() []Manifest {
	r.mu.RLock()
	metas := make([]*Meta, 0, len(r.plugins))
	for _, m := range r.plugins {
		metas = append(metas, m)
	}
	r.mu.RUnlock()
	sort.SliceStable(metas, func(i, j int) bool {
		if c := localeCompare(metas[i].Name, metas[j].Name); c != 0 {
			return c < 0
		}
		return metas[i].ID < metas[j].ID
	})
	out := make([]Manifest, len(metas))
	for i, m := range metas {
		out[i] = ToManifest(m)
	}
	return out
}

// GetMeta returns the full meta (nil when unknown).
func (r *Registry) GetMeta(id string) *Meta {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.plugins[id]
}

// GetManifest returns one manifest.
func (r *Registry) GetManifest(id string) (Manifest, bool) {
	m := r.GetMeta(id)
	if m == nil {
		return Manifest{}, false
	}
	return ToManifest(m), true
}

// Has reports whether the id is registered.
func (r *Registry) Has(id string) bool { return r.GetMeta(id) != nil }

// Register adds a meta directly (tests / fixtures).
func (r *Registry) Register(m *Meta) {
	r.mu.Lock()
	r.plugins[m.ID] = m
	r.mu.Unlock()
}

// ---------------------------------------------------------------------------
// validation (shared by the built-in and vendored paths)
// ---------------------------------------------------------------------------

// prop is `v?.[k]` over the JSON value model.
func prop(v any, k string) any {
	if m, ok := v.(*y.Map); ok && m != nil {
		return m.Get(k)
	}
	return y.Undefined
}

func isStr(v any) bool { _, ok := v.(string); return ok }

// isBareFilename: non-empty single segment, no separators, no '..'.
func isBareFilename(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	return !strings.ContainsAny(name, `/\`) && !strings.Contains(name, "..")
}

func jsString(v any) string { return y.ToString(v) }

// validateField is the shared configSchema field check.
func validateField(raw any, seen map[string]bool) string {
	f, ok := raw.(*y.Map)
	if !ok || f == nil {
		return "config field must be an object"
	}
	key, _ := f.Get("key").(string)
	if key == "" {
		return "config field missing key"
	}
	if seen[key] {
		return fmt.Sprintf("duplicate config key '%s'", key)
	}
	seen[key] = true
	if t, ok := f.Get("type").(string); !ok || !fieldTypes[t] {
		return fmt.Sprintf("field '%s' has invalid type '%s'", key, jsString(f.Get("type")))
	}
	if y.IsUndefined(f.Get("default")) {
		return fmt.Sprintf("field '%s' missing default", key)
	}
	if !isStr(f.Get("label")) {
		return fmt.Sprintf("field '%s' missing label", key)
	}
	if f.Get("type") == "select" {
		if opts, ok := f.Get("options").([]any); !ok || len(opts) == 0 {
			return fmt.Sprintf("select field '%s' needs options", key)
		}
	}
	return ""
}

// validateBuiltin is the registry's validate() for an in-tree meta.
func validateBuiltin(m *y.Map, folder string) string {
	if m == nil {
		return "no PluginMeta default export"
	}
	id, ok := m.Get("id").(string)
	if !ok || id == "" {
		return "missing string id"
	}
	if !idSlug.MatchString(id) {
		return fmt.Sprintf("id '%s' must be a lowercase slug", id)
	}
	if id != folder {
		return fmt.Sprintf("id '%s' must equal folder name '%s'", id, folder)
	}
	if n, _ := m.Get("name").(string); n == "" {
		return "missing name"
	}
	if !isStr(m.Get("description")) {
		return "missing description"
	}
	if c, _ := m.Get("category").(string); !categories[c] {
		return fmt.Sprintf("invalid category '%s'", jsString(m.Get("category")))
	}
	if u, _ := m.Get("ui").(string); !uiSlots[u] {
		return fmt.Sprintf("invalid ui slot '%s'", jsString(m.Get("ui")))
	}
	if v := m.Get("version"); !y.IsUndefined(v) {
		if s, ok := v.(string); !ok || !semverRe.MatchString(s) {
			return fmt.Sprintf("invalid version '%s' (expected semver, e.g. 1.2.3)", jsString(v))
		}
	}
	if e := validateTaxonomy(m); e != "" {
		return e
	}
	schema, ok := m.Get("configSchema").([]any)
	if !ok {
		return "configSchema must be an array"
	}
	seen := map[string]bool{}
	for _, f := range schema {
		if e := validateField(f, seen); e != "" {
			return e
		}
	}
	w := m.Get("worker")
	if y.Truthy(m.Get("needsWorker")) && (!y.Truthy(w) || !isStr(prop(w, "spawn"))) {
		return "needsWorker=true but worker.spawn() is missing"
	}
	if y.Truthy(w) {
		if e := validatePlacement(w); e != "" {
			return e
		}
	}
	return ""
}

func validateTaxonomy(m *y.Map) string {
	if k := m.Get("kind"); !y.IsUndefined(k) {
		if s, _ := k.(string); !kinds[s] {
			return fmt.Sprintf("invalid kind '%s' (plugin|app)", jsString(k))
		}
	}
	if st := m.Get("storage"); !y.IsUndefined(st) {
		if !y.IsObject(st) {
			return "storage must be an object"
		}
		if db := prop(st, "db"); !y.IsUndefined(db) {
			s, ok := db.(string)
			if !ok {
				return "storage.db must be a string"
			}
			if !isBareFilename(s) {
				return fmt.Sprintf("storage.db '%s' must be a bare filename (no path separators)", s)
			}
		}
	}
	if ex := m.Get("export"); !y.IsUndefined(ex) {
		kind, _ := y.Coalesce(m.Get("kind"), "plugin").(string)
		if kind != "app" {
			return "export is only valid on kind 'app'"
		}
		if !y.IsObject(ex) {
			return "export must be an object"
		}
		if d := prop(ex, "workerDir"); !y.IsUndefined(d) {
			s, ok := d.(string)
			if !ok {
				return "export.workerDir must be a string"
			}
			if !isBareFilename(s) {
				return fmt.Sprintf("export.workerDir '%s' must be a bare directory name (no path separators)", s)
			}
		}
	}
	return ""
}

func validatePlacement(w any) string {
	placement := prop(w, "placement")
	if !y.IsUndefined(placement) && !placements[jsString(placement)] {
		return fmt.Sprintf("invalid worker.placement '%s' (local|grid)", jsString(placement))
	}
	if e := prop(w, "edge"); !y.IsUndefined(e) {
		if _, ok := e.(bool); !ok {
			return "worker.edge must be a boolean"
		}
	}
	grid := prop(w, "grid")
	if y.IsUndefined(grid) {
		return ""
	}
	if placement != "grid" {
		return "worker.grid requirements need worker.placement 'grid'"
	}
	g, ok := grid.(*y.Map)
	if !ok || g == nil {
		return "worker.grid must be an object"
	}
	if v := g.Get("gpu"); !y.IsUndefined(v) {
		if _, ok := v.(bool); !ok {
			return "worker.grid.gpu must be a boolean"
		}
	}
	if v := g.Get("minVramGb"); !y.IsUndefined(v) {
		if f, ok := v.(float64); !ok || f < 0 {
			return "worker.grid.minVramGb must be a non-negative number"
		}
	}
	for _, key := range []string{"capabilities", "regions"} {
		v := g.Get(key)
		if y.IsUndefined(v) {
			continue
		}
		list, ok := v.([]any)
		bad := !ok
		for _, s := range list {
			bad = bad || !isStr(s)
		}
		if bad {
			return fmt.Sprintf("worker.grid.%s must be an array of strings", key)
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// raw JSON → Meta
// ---------------------------------------------------------------------------

func strPtr(v any) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	return &s
}

func strList(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, _ := e.(string)
		out = append(out, s)
	}
	return out
}

func numPtr(v any) *float64 {
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	return &f
}

// parseFields types the raw configSchema.
func parseFields(schema []any) []Field {
	out := make([]Field, 0, len(schema))
	for _, raw := range schema {
		f, _ := raw.(*y.Map)
		if f == nil {
			continue
		}
		field := Field{
			Key: jsString(f.Get("key")), Type: jsString(f.Get("type")), Default: f.Get("default"),
			Required: y.Truthy(f.Get("required")), Min: numPtr(f.Get("min")), Max: numPtr(f.Get("max")), Raw: f,
		}
		if y.IsUndefined(field.Default) {
			field.Default = nil
		}
		if opts, ok := f.Get("options").([]any); ok {
			for _, o := range opts {
				field.Options = append(field.Options, prop(o, "value"))
			}
		}
		out = append(out, field)
	}
	return out
}

func gridFrom(g any) *GridRequirements {
	m, ok := g.(*y.Map)
	if !ok || m == nil {
		return nil
	}
	return &GridRequirements{
		GPU: m.Get("gpu") == true, MinVramGb: numPtr(m.Get("minVramGb")),
		Capabilities: strList(m.Get("capabilities")), Regions: strList(m.Get("regions")),
	}
}

// baseMeta fills the fields shared by both sources from a validated object.
func baseMeta(m *y.Map) *Meta {
	schema, _ := m.Get("configSchema").([]any)
	meta := &Meta{
		ID: jsString(m.Get("id")), Name: jsString(m.Get("name")), Description: jsString(m.Get("description")),
		Category: jsString(m.Get("category")), UI: jsString(m.Get("ui")),
		ConfigSchema: schema, Fields: parseFields(schema),
		Version: strPtr(m.Get("version")), Kind: strPtr(m.Get("kind")), Icon: strPtr(m.Get("icon")),
	}
	if ev, ok := m.Get("events").([]any); ok {
		meta.Events = strList(ev)
	}
	return meta
}

// builtinMeta turns a generated in-tree meta into a Meta.
func (r *Registry) builtinMeta(m *y.Map) *Meta {
	meta := baseMeta(m)
	meta.NeedsWorker = m.Get("needsWorker") == true
	if st := m.Get("storage"); y.IsObject(st) {
		meta.StorageSet = true
		meta.StorageDB = strPtr(prop(st, "db"))
	}
	if ex := m.Get("export"); y.IsObject(ex) {
		meta.ExportSet = true
		meta.ExportDir = strPtr(prop(ex, "workerDir"))
	}
	if w := m.Get("worker"); y.Truthy(w) {
		d := &WorkerDescriptor{Edge: prop(w, "edge") == true, Grid: gridFrom(prop(w, "grid"))}
		if p, ok := prop(w, "placement").(string); ok {
			d.Placement = p
		}
		if key, ok := prop(w, "spawn").(string); ok {
			if fn := r.builtinSpawn(key); fn != nil {
				d.Spawn = fn
			}
		}
		meta.Worker = d
	}
	return meta
}

// BuiltinIDs are the ids of the in-tree plugins (builtins.json): a vendored
// package with one of these ids is shadowed — `apps pull` says so.
func BuiltinIDs() []string {
	var metas []struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(builtinsJSON, &metas)
	ids := make([]string, 0, len(metas))
	for _, m := range metas {
		ids = append(ids, m.ID)
	}
	return ids
}
