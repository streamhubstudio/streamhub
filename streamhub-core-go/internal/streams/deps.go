package streams

import "context"

// Narrow views of the collaborators this package calls. Each is optional in
// Node (@Optional / best-effort); a nil getter or nil value means "absent"
// and the code path degrades exactly as Node does without that provider.

// Participant is the slice of a LiveKit ParticipantInfo the streams logic reads.
type Participant struct {
	Identity string
	// Tracks is len(participant.tracks).
	Tracks int
	// Hidden is participant.permission?.hidden (hidden/QC viewers).
	Hidden bool
	// Ingress is kind === ParticipantInfo_Kind.INGRESS.
	Ingress bool
}

// Ingress is the slice of a LiveKit IngressInfo used to resolve teardown.
type Ingress struct {
	IngressID           string
	RoomName            string
	ParticipantIdentity string
}

// Rooms is the LiveKit RoomServiceClient + IngressClient surface the streams
// service uses directly (Node builds its own SDK clients only when
// LIVEKIT_URL + key + secret are all set; nil otherwise).
type Rooms interface {
	ListRooms(ctx context.Context) ([]string, error)
	ListParticipants(ctx context.Context, room string) ([]Participant, error)
	RemoveParticipant(ctx context.Context, room, identity string) error
	DeleteRoom(ctx context.Context, room string) error
	// ListIngress lists ingresses filtered by room (listIngress({roomName})).
	ListIngress(ctx context.Context, room string) ([]Ingress, error)
	DeleteIngress(ctx context.Context, ingressID string) error
}

// HlsEgressInfo is the contract HlsEgressInfo.
type HlsEgressInfo struct {
	EgressID string
	Status   string
	RoomName string
}

// StartHlsEgressInput is the contract StartHlsEgressInput.
type StartHlsEgressInput struct {
	AppName          string
	RoomName         string
	OutputDir        string
	PlaylistName     string
	LivePlaylistName string // "" = omitted
	SegmentDurationS int
}

// EgressInfo is the contract EgressInfo (stopEgress result).
type EgressInfo struct {
	EgressID string
	Status   string
}

// Egress is the LiveKitServiceContract HLS slice (guarded wrapper: errors
// already carry the "LiveKit <op> failed: …" text).
type Egress interface {
	StartHlsEgress(ctx context.Context, in StartHlsEgressInput) (*HlsEgressInfo, error)
	ListHlsEgress(ctx context.Context, roomPrefix string) ([]HlsEgressInfo, error)
	StopEgress(ctx context.Context, egressID string) (*EgressInfo, error)
}

// Callbacks is CallbacksServiceContract.dispatch (signed app webhooks).
// payload is a JSON-marshalable value whose field order matches Node's.
type Callbacks interface {
	Dispatch(ctx context.Context, app, event string, payload any) error
}

// Logs is LogsServiceContract.write (logs.Service.Write).
type Logs interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Metrics is the MetricsService slice (Prometheus counters/gauges).
type Metrics interface {
	StreamStopped(app string)
	SnapshotTaken(app string)
	SetViewers(app, room string, viewers float64)
}

// Optional are the lazily resolved collaborators: getters are called at use
// time so planes wired after this one are picked up. nil getter = absent.
type Optional struct {
	Rooms     func() Rooms
	Egress    func() Egress
	Callbacks func() Callbacks
	Logs      func() Logs
	Metrics   func() Metrics
}

func get[T any](f func() T) T {
	var zero T
	if f == nil {
		return zero
	}
	return f()
}
