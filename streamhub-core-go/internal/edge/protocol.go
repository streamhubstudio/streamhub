// Package edge ports modules/edge — the cluster's processing plane: the
// outbound edge WebSocket control channel (gateway), the edge_assignments
// store, the round-robin / weighted scheduler, the liveness + failover
// watchdog, the per-stream reconcile, the capacity alerter, the node-event
// notifier and the REST surfaces (/edge/*, /apps/:app/edge/assignments).
//
// WIRE CONTRACT: the deployed edge runtime (Python, streamhub-app-vision)
// speaks this protocol; frame shapes and key order are byte-compatible with
// the Node core (edge.protocol.ts) and must not change.
package edge

import (
	"time"

	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// WSPath is the edge control WebSocket path.
const WSPath = "/api/v1/edge/ws"

const (
	// PingInterval is the server → edge JSON ping cadence.
	PingInterval = 15 * time.Second
	// MaxMissedPongs tolerated before the connection is terminated.
	MaxMissedPongs = 3
)

// Statuses of an assignment.
const (
	StatusPending = "pending"
	StatusOffered = "offered"
	StatusRunning = "running"
	StatusStopped = "stopped"
	StatusFailed  = "failed"
	StatusRevoked = "revoked"
)

// Policies.
const (
	PolicyRoundRobin = "round_robin"
	PolicyWeighted   = "weighted"
)

// Assignment is one edge_assignments row, enriched.
type Assignment struct {
	ID        string  `json:"id"`
	NodeID    string  `json:"nodeId"`
	App       string  `json:"app"`
	PluginID  string  `json:"pluginId"`
	StreamID  *string `json:"streamId"`
	Config    *y.Map  `json:"config"`
	Status    string  `json:"status"`
	Detail    *string `json:"detail"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

// SpawnSpec is the resolved worker the edge runtime executes. Env keeps
// insertion order (framework env first, then the plugin's).
type SpawnSpec struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Env     *y.Map   `json:"env"`
}

// EmptySpec is the foundation default (no resolver / unknown plugin).
func EmptySpec() SpawnSpec { return SpawnSpec{Args: []string{}, Env: y.NewMap()} }

// BundleRef pins an appstore version on an assign frame.
type BundleRef struct {
	PluginID string `json:"pluginId"`
	Version  string `json:"version"`
	Sha256   string `json:"sha256"`
	URL      string `json:"url"`
}

// AssignPayload is the `assignment` of an assign frame.
type AssignPayload struct {
	ID       string     `json:"id"`
	App      string     `json:"app"`
	PluginID string     `json:"pluginId"`
	StreamID *string    `json:"streamId"`
	Config   *y.Map     `json:"config"`
	Spawn    SpawnSpec  `json:"spawn"`
	Bundle   *BundleRef `json:"bundle,omitempty"`
}

// AssignFrame is master → edge `assign`.
type AssignFrame struct {
	Type       string        `json:"type"`
	Assignment AssignPayload `json:"assignment"`
}

// SpawnResolver is the spawn-resolution seam (GenericSpawnResolver).
type SpawnResolver interface {
	Resolve(app, pluginID string, config *y.Map) SpawnSpec
	// ResolveBundle is the pinned bundle, or nil.
	ResolveBundle(app, pluginID string) *BundleRef
}

// Framer builds assign frames with the active resolver (nil = foundation:
// empty spec, no bundle). Resolver panics degrade the same way.
type Framer struct{ Resolver SpawnResolver }

// AssignFrame is toAssignFrame.
func (f *Framer) AssignFrame(a Assignment) AssignFrame {
	cfg := a.Config
	if cfg == nil {
		cfg = y.NewMap()
	}
	return AssignFrame{Type: "assign", Assignment: AssignPayload{
		ID: a.ID, App: a.App, PluginID: a.PluginID, StreamID: a.StreamID, Config: cfg,
		Spawn: f.spawn(a.App, a.PluginID, cfg), Bundle: f.bundle(a.App, a.PluginID),
	}}
}

func (f *Framer) spawn(app, pluginID string, cfg *y.Map) (spec SpawnSpec) {
	spec = EmptySpec()
	if f == nil || f.Resolver == nil {
		return spec
	}
	defer func() {
		if recover() != nil {
			spec = EmptySpec()
		}
	}()
	return f.Resolver.Resolve(app, pluginID, cfg)
}

func (f *Framer) bundle(app, pluginID string) (b *BundleRef) {
	if f == nil || f.Resolver == nil {
		return nil
	}
	defer func() {
		if recover() != nil {
			b = nil
		}
	}()
	return f.Resolver.ResolveBundle(app, pluginID)
}

// Frame is a parsed inbound frame: JSON object with a non-empty string type.
type Frame struct {
	Type string
	obj  *y.Map
}

// ParseFrame parses a WS message (nil when not an object with a string type).
func ParseFrame(data []byte) *Frame {
	v, err := y.ParseJSON(data)
	if err != nil {
		return nil
	}
	obj, ok := v.(*y.Map)
	if !ok {
		return nil
	}
	t, ok := obj.Get("type").(string)
	if !ok || t == "" {
		return nil
	}
	return &Frame{Type: t, obj: obj}
}

// Str reads a string field ("" + false when absent / not a string).
func (f *Frame) Str(key string) (string, bool) {
	s, ok := f.obj.Get(key).(string)
	return s, ok
}

// Get reads a raw field (yamljs value model).
func (f *Frame) Get(key string) any { return f.obj.Get(key) }
