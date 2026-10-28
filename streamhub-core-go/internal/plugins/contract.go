// Package plugins is the plugin framework (modules/plugins): the catalog
// (in-tree metas embedded as declarative JSON + vendored `streamhub.app.json`
// packages interpreted by the spawn-template engine), per-app installs in
// app.db `app_plugins`, configSchema validation, the worker process manager
// (os/exec), the live-data/event channels, StreamHub Grid (node selection,
// dispatch, node-side agent), Studio-App export bundles and the appstore
// (immutable per-version bundles, pin/rollback history).
//
// Files: contract.go (PluginMeta / manifest), registry.go (discovery +
// validation), appmanifest.go + spawntemplate.go (declarative packages),
// builtin.go (in-tree metas + their Go spawn funcs), config.go, repo.go,
// livedata.go, worker.go, grid.go, export.go + tar.go, appstore.go,
// versions.go, service.go, routes*.go.
package plugins

import (
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Field is one typed config field of a plugin's configSchema. Raw keeps the
// author's object verbatim (key order, extra keys) for the API.
type Field struct {
	Key      string
	Type     string // string | number | boolean | select | secret
	Default  any    // JS value (nil, bool, float64, string)
	Required bool
	Options  []any // select option values (JS values)
	Min, Max *float64
	Raw      *y.Map
}

// NodeInfo identifies the node a worker is (to be) placed on.
type NodeInfo struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	URL    *string `json:"url"`
	Region *string `json:"region"`
}

// WorkerContext is what a spawn builder receives (PluginWorkerContext).
type WorkerContext struct {
	App         string
	Config      *y.Map
	AppDir      string
	DataDir     string
	LivekitURL  string
	Node        *NodeInfo // nil = origin (local)
	OriginURL   string    // "" = undefined (local)
	AppTimezone string
}

// EnvVar is one env entry; spec env keeps the builder's insertion order
// (the export bundle lists it in that order).
type EnvVar struct{ Key, Value string }

// WorkerSpec is exactly what the core spawns.
type WorkerSpec struct {
	Command string
	Args    []string
	Env     []EnvVar
	Cwd     string // "" = undefined (defaults to the app dir)
}

// EnvMap returns the env as a map.
func (s WorkerSpec) EnvMap() map[string]string {
	m := make(map[string]string, len(s.Env))
	for _, e := range s.Env {
		m[e.Key] = e.Value
	}
	return m
}

// GridRequirements are a grid worker's node requirements.
type GridRequirements struct {
	GPU          bool
	MinVramGb    *float64
	Capabilities []string
	Regions      []string
}

// WorkerDescriptor is PluginWorkerDescriptor: Spawn is a pure function of
// the context.
type WorkerDescriptor struct {
	Spawn     func(ctx WorkerContext) WorkerSpec
	Placement string // "" = undefined (local)
	Grid      *GridRequirements
	Edge      bool
}

// Meta is PluginMeta. Optional string fields are pointers where Node
// distinguishes undefined from "".
type Meta struct {
	ID           string
	Name         string
	Description  string
	Category     string
	UI           string
	ConfigSchema []any // raw field objects (*y.Map), verbatim
	Fields       []Field
	NeedsWorker  bool
	Worker       *WorkerDescriptor
	Events       []string
	Version      *string
	Kind         *string
	StorageSet   bool
	StorageDB    *string
	ExportDir    *string // export.workerDir
	ExportSet    bool
	Icon         *string
}

// IsApp reports kind 'app'.
func (m *Meta) IsApp() bool { return m.Kind != nil && *m.Kind == "app" }

// Storage is the manifest's storage block.
type Storage struct {
	DB *string `json:"db,omitempty"`
}

// Manifest is PluginManifest: the serializable catalog view.
type Manifest struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	Category        string   `json:"category"`
	ConfigSchema    []any    `json:"configSchema"`
	UI              string   `json:"ui"`
	NeedsWorker     bool     `json:"needsWorker"`
	WorkerPlacement string   `json:"workerPlacement"`
	Edge            bool     `json:"edge"`
	Events          []string `json:"events"`
	Version         string   `json:"version"`
	Kind            string   `json:"kind"`
	Storage         *Storage `json:"storage"`
	Exportable      bool     `json:"exportable"`
	Icon            *string  `json:"icon,omitempty"`
}

// ToManifest projects a meta (toManifest).
func ToManifest(m *Meta) Manifest {
	out := Manifest{
		ID: m.ID, Name: m.Name, Description: m.Description, Category: m.Category,
		ConfigSchema: m.ConfigSchema, UI: m.UI, NeedsWorker: m.NeedsWorker,
		WorkerPlacement: "local", Events: m.Events, Version: "0.0.0", Kind: "plugin",
		Exportable: m.ExportDir != nil && *m.ExportDir != "", Icon: m.Icon,
	}
	if out.ConfigSchema == nil {
		out.ConfigSchema = []any{}
	}
	if m.Worker != nil {
		if m.Worker.Placement != "" {
			out.WorkerPlacement = m.Worker.Placement
		}
		out.Edge = m.Worker.Edge
	}
	if out.Events == nil {
		out.Events = []string{}
	}
	if m.Version != nil {
		out.Version = *m.Version
	}
	if m.Kind != nil {
		out.Kind = *m.Kind
	}
	if m.StorageSet {
		out.Storage = &Storage{DB: m.StorageDB}
	}
	return out
}

// DataTopic is the LiveKit data topic for a plugin's results.
func DataTopic(pluginID string) string { return "plugin:" + pluginID }
