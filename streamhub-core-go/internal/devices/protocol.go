// Package devices is the field-device plane (E4 of the software-encoder
// plan): zero-touch pairing of hardware/software encoders by a short code
// (device-code flow), a device-only credential (`dk_…`, stored hashed), and
// an outbound WebSocket control channel (`/api/v1/devices/ws`) over which
// the core pushes the device's configuration (channels with their publish
// URL + key) and commands, and the device reports its status.
//
// It is NEW surface (no Node counterpart): nothing here is parity-bound.
// Off by default (STREAMHUB_DEVICES_ENABLE). Wire contract:
// streamhub-docs/features/devices.md — the encoder (streamhub-encoder/)
// speaks it; change both together.
package devices

import (
	"encoding/json"
	"time"
)

// WSPath is the device control WebSocket.
const WSPath = "/api/v1/devices/ws"

// EnableEnv is the master switch (default off: every route answers 503).
const EnableEnv = "STREAMHUB_DEVICES_ENABLE"

const (
	// CodeLength is the pairing code length (alphabet below, no 0/O/1/I/L).
	CodeLength = 8
	// CodeTTL is how long an unclaimed pairing code lives.
	CodeTTL = 10 * time.Minute
	// DeliveryGrace is how long a CLAIMED pairing waits for the device's
	// poll to pick up the credential (from the claim).
	DeliveryGrace = 10 * time.Minute
	// PollInterval is the advised poll cadence (seconds) for the device.
	PollInterval = 5
	// MaxPollFailures wrong poll tokens burn the pairing.
	MaxPollFailures = 5
	// MaxPendingPairings caps the table (a flood of pair/start).
	MaxPendingPairings = 1000
	// MaxPendingPerIP caps the live pairings one source address holds.
	MaxPendingPerIP = 5

	// PingInterval is the WS keepalive cadence; MaxMissedPings in a row
	// close the socket.
	PingInterval   = 15 * time.Second
	MaxMissedPings = 3
	// CommandTimeout bounds a command → command_result round trip.
	CommandTimeout = 10 * time.Second
	// readLimit caps one inbound frame.
	readLimit = 1 << 20
)

// CodeAlphabet: 31 unambiguous symbols → 31^8 ≈ 8.5e11 codes.
const CodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// Credential / id prefixes.
const (
	CredentialPrefix = "dk_"
	DeviceIDPrefix   = "dev_"
	// AuthScheme is the Authorization scheme of the WS upgrade.
	AuthScheme = "Device"
)

// WS close codes.
const (
	CloseRevoked  = 4401 // credential revoked (device deleted)
	CloseReplaced = 4409 // a newer connection of the same device won
)

// Frame types.
const (
	FrameHello         = "hello"          // device → core
	FrameStatus        = "status"         // device → core
	FrameCommandResult = "command_result" // device → core
	FramePing          = "ping"           // either way (JSON keepalive, optional)
	FramePong          = "pong"
	FrameConfig        = "config"  // core → device
	FrameCommand       = "command" // core → device
	FrameError         = "error"   // core → device (bad frame)
)

// Command actions.
const (
	ActionStart       = "start"
	ActionStop        = "stop"
	ActionRestart     = "restart"
	ActionApplyPreset = "apply_preset"
	ActionReboot      = "reboot"
)

// Actions is every accepted command action.
var Actions = []string{ActionStart, ActionStop, ActionRestart, ActionApplyPreset, ActionReboot}

// channelActions need a channel id.
var channelActions = map[string]bool{ActionStart: true, ActionStop: true, ActionRestart: true, ActionApplyPreset: true}

// inFrame is any device → core frame (fields by type).
type inFrame struct {
	Type string `json:"type"`
	// hello
	Model        string          `json:"model,omitempty"`
	Version      string          `json:"version,omitempty"`
	Serial       string          `json:"serial,omitempty"`
	Capabilities json.RawMessage `json:"capabilities,omitempty"`
	// status: the whole frame is persisted (minus type)
	// command_result
	ID      string `json:"id,omitempty"`
	OK      bool   `json:"ok,omitempty"`
	Message string `json:"message,omitempty"`
}

// ConfigFrame is core → device: the desired configuration.
type ConfigFrame struct {
	Type     string          `json:"type"`
	Rev      int64           `json:"rev"`
	Device   ConfigDevice    `json:"device"`
	Channels []ConfigChannel `json:"channels"`
}

// ConfigDevice identifies the device to itself.
type ConfigDevice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	App  string `json:"app"`
}

// ConfigChannel is one linked channel: where to publish it.
type ConfigChannel struct {
	ID         string `json:"id"`
	Name       string `json:"name,omitempty"`
	Room       string `json:"room"`
	Protocol   string `json:"protocol"`
	PublishURL string `json:"publishUrl"`
	StreamKey  string `json:"streamKey"`
	IngressID  string `json:"ingressId,omitempty"`
}

// CommandFrame is core → device.
type CommandFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Action  string `json:"action"`
	Channel string `json:"channel,omitempty"`
	Preset  string `json:"preset,omitempty"`
}

// DeviceCommandResult is the device's answer to a command.
type DeviceCommandResult struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

type errorFrame struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

type pongFrame struct {
	Type string `json:"type"`
}
