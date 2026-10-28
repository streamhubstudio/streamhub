package livekit

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/security"
)

// Service is the port of LiveKitService: every SDK call is guarded (logged +
// surfaced as 503 "LiveKit <op> failed: <msg>", never a crash). It is the
// "livekit" service later planes (recording, restream, broadcast, HLS,
// live-control, scheduled-live) depend on.
type Service struct {
	cfg     *config.Config
	clients Clients
	log     *slog.Logger
	opt     Optional
	resolve security.HostResolver
	now     func() time.Time
}

// NewService builds the SDK wrapper (clients nil → real server-sdk-go ones).
func NewService(cfg *config.Config, clients *Clients, log *slog.Logger, opt Optional, resolve security.HostResolver) *Service {
	c := NewClients(cfg.LivekitURL, cfg.LivekitAPIKey, cfg.LivekitAPISecret)
	if clients != nil {
		c = *clients
	}
	if resolve == nil {
		resolve = security.DefaultHostResolver
	}
	return &Service{cfg: cfg, clients: c, log: log, opt: opt, resolve: resolve, now: time.Now}
}

// logWrite is logs.write(level, source, msg, meta), slog when the logs
// module is not wired.
func (s *Service) logWrite(level, source, msg string, meta map[string]any) {
	writeLog(s.opt, s.log, level, source, msg, meta)
}

func writeLog(opt Optional, log *slog.Logger, level, source, msg string, meta map[string]any) {
	if l := get(opt.Logs); l != nil {
		var m any
		if meta != nil {
			m = meta
		}
		l.Write(level, source, msg, m, nil)
		return
	}
	if log == nil {
		return
	}
	attrs := []any{"source", source}
	for k, v := range meta {
		attrs = append(attrs, k, v)
	}
	switch level {
	case "error":
		log.Error(msg, attrs...)
	case "warn":
		log.Warn(msg, attrs...)
	default:
		log.Info(msg, attrs...)
	}
}

// guard wraps an SDK error as the 503 every wrapper throws.
func (s *Service) guard(op string, err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	s.logWrite("error", "livekit", op+" failed: "+msg, map[string]any{"op": op})
	return httpx.Unavailable(fmt.Sprintf("LiveKit %s failed: %s", op, msg))
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

// RoomInfo is LiveKitRoomInfo; RoomDetail adds the live metadata.
type RoomInfo struct {
	Name            string `json:"name"`
	Sid             string `json:"sid"`
	NumParticipants int64  `json:"numParticipants"`
	CreationTime    int64  `json:"creationTime"`
	// Metadata is only set by the detail views (absent when empty).
	Metadata string `json:"metadata,omitempty"`
}

func toRoomInfo(r *livekit.Room) RoomInfo {
	return RoomInfo{Name: r.GetName(), Sid: r.GetSid(), NumParticipants: int64(r.GetNumParticipants()), CreationTime: r.GetCreationTime()}
}

func toRoomDetail(r *livekit.Room) RoomInfo {
	info := toRoomInfo(r)
	info.Metadata = r.GetMetadata()
	return info
}

// Participant is the basic participant view (streams/viewer counter).
type Participant struct {
	Identity    string `json:"identity"`
	Name        string `json:"name"`
	Hidden      bool   `json:"hidden"`
	IsPublisher bool   `json:"isPublisher"`
}

// TrackView is one published track of a participant.
type TrackView struct {
	Sid    string `json:"sid"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Muted  bool   `json:"muted"`
}

// Permission is a participant's current grant.
type Permission struct {
	CanPublish     bool `json:"canPublish"`
	CanSubscribe   bool `json:"canSubscribe"`
	CanPublishData bool `json:"canPublishData"`
	Hidden         bool `json:"hidden"`
}

// ParticipantDetail is the rooms/moderation participant view.
type ParticipantDetail struct {
	Identity    string      `json:"identity"`
	Name        string      `json:"name"`
	Sid         string      `json:"sid"`
	Hidden      bool        `json:"hidden"`
	IsPublisher bool        `json:"isPublisher"`
	Metadata    string      `json:"metadata,omitempty"`
	JoinedAt    *string     `json:"joinedAt"`
	Tracks      []TrackView `json:"tracks"`
	Permission  Permission  `json:"permission"`
}

func toParticipantDetail(p *livekit.ParticipantInfo) ParticipantDetail {
	perm := p.GetPermission()
	tracks := make([]TrackView, 0, len(p.GetTracks()))
	for _, t := range p.GetTracks() {
		tracks = append(tracks, TrackView{
			Sid: t.GetSid(), Type: strings.ToLower(t.GetType().String()),
			Source: strings.ToLower(t.GetSource().String()), Muted: t.GetMuted(),
		})
	}
	return ParticipantDetail{
		Identity: p.GetIdentity(), Name: p.GetName(), Sid: p.GetSid(),
		Hidden: perm.GetHidden(), IsPublisher: len(p.GetTracks()) > 0,
		Metadata: p.GetMetadata(), JoinedAt: tsToISO(p.GetJoinedAt()), Tracks: tracks,
		Permission: Permission{perm.GetCanPublish(), perm.GetCanSubscribe(), perm.GetCanPublishData(), perm.GetHidden()},
	}
}

// tsToISO normalizes a LiveKit timestamp (s/ms/µs/ns by magnitude) to an ISO
// string; nil for 0/negative.
func tsToISO(raw int64) *string {
	n := float64(raw)
	if n <= 0 {
		return nil
	}
	var ms float64
	switch {
	case n < 1e11:
		ms = n * 1000
	case n < 1e14:
		ms = n
	case n < 1e17:
		ms = n / 1e3
	default:
		ms = n / 1e6
	}
	s := jsx.ISO(time.UnixMilli(int64(math.Floor(ms))))
	return &s
}

// IngressInfo is the created/listed ingress (contract IngressInfo).
type IngressInfo struct {
	IngressID string `json:"ingressId"`
	URL       string `json:"url"`
	StreamKey string `json:"streamKey,omitempty"`
	RoomName  string `json:"roomName"`
}

// IngressListItem is IngressInfo enriched with the live endpoint state.
type IngressListItem struct {
	IngressInfo
	Name      string  `json:"name,omitempty"`
	InputType string  `json:"inputType"`
	Status    string  `json:"status"`
	Bitrate   *int64  `json:"bitrate,omitempty"`
	Width     *int64  `json:"width,omitempty"`
	Height    *int64  `json:"height,omitempty"`
	StartedAt *string `json:"startedAt"`
}

var ingressStatusNames = map[livekit.IngressState_Status]string{
	livekit.IngressState_ENDPOINT_INACTIVE:   "inactive",
	livekit.IngressState_ENDPOINT_BUFFERING:  "buffering",
	livekit.IngressState_ENDPOINT_PUBLISHING: "publishing",
	livekit.IngressState_ENDPOINT_ERROR:      "error",
	livekit.IngressState_ENDPOINT_COMPLETE:   "complete",
}

var ingressInputNames = map[livekit.IngressInput]string{
	livekit.IngressInput_RTMP_INPUT: "rtmp",
	livekit.IngressInput_WHIP_INPUT: "whip",
	livekit.IngressInput_URL_INPUT:  "url",
}

// EgressInfo is the contract EgressInfo.
type EgressInfo struct {
	EgressID string `json:"egressId"`
	Status   string `json:"status"`
}

// StreamEgressInfo is an RTMP (broadcast/restream) egress.
type StreamEgressInfo struct {
	EgressID string   `json:"egressId"`
	Status   string   `json:"status"`
	RoomName string   `json:"roomName"`
	URLs     []string `json:"urls"`
}

// HlsEgressInfo is a segmented-file (HLS) egress.
type HlsEgressInfo struct {
	EgressID         string `json:"egressId"`
	Status           string `json:"status"`
	RoomName         string `json:"roomName"`
	PlaylistLocation string `json:"playlistLocation,omitempty"`
}

// EgressStatusString is EgressStatus[status] ?? EGRESS_UNKNOWN_<n>.
func EgressStatusString(st livekit.EgressStatus) string {
	if n, ok := livekit.EgressStatus_name[int32(st)]; ok {
		return n
	}
	return "EGRESS_UNKNOWN_" + strconv.Itoa(int(st))
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

// CreateRoom creates (or returns) a room; emptyTimeoutS 0 → 300.
func (s *Service) CreateRoom(ctx context.Context, name string, emptyTimeoutS uint32) (RoomInfo, error) {
	if emptyTimeoutS == 0 {
		emptyTimeoutS = 300
	}
	r, err := s.clients.Room.CreateRoom(ctx, &livekit.CreateRoomRequest{Name: name, EmptyTimeout: emptyTimeoutS})
	if err != nil {
		return RoomInfo{}, s.guard("createRoom", err)
	}
	return toRoomInfo(r), nil
}

// DeleteRoom deletes a room.
func (s *Service) DeleteRoom(ctx context.Context, name string) error {
	_, err := s.clients.Room.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: name})
	return s.guard("deleteRoom", err)
}

func (s *Service) rawRooms(ctx context.Context, names []string) ([]*livekit.Room, error) {
	if names == nil {
		names = []string{}
	}
	res, err := s.clients.Room.ListRooms(ctx, &livekit.ListRoomsRequest{Names: names})
	if err != nil {
		return nil, s.guard("listRooms", err)
	}
	return res.GetRooms(), nil
}

// ListRooms lists rooms (all when names is empty).
func (s *Service) ListRooms(ctx context.Context, names []string) ([]RoomInfo, error) {
	rooms, err := s.rawRooms(ctx, names)
	if err != nil {
		return nil, err
	}
	out := make([]RoomInfo, 0, len(rooms))
	for _, r := range rooms {
		out = append(out, toRoomInfo(r))
	}
	return out, nil
}

// ListRoomsDetailed lists rooms with their metadata.
func (s *Service) ListRoomsDetailed(ctx context.Context, names []string) ([]RoomInfo, error) {
	rooms, err := s.rawRooms(ctx, names)
	if err != nil {
		return nil, err
	}
	out := make([]RoomInfo, 0, len(rooms))
	for _, r := range rooms {
		out = append(out, toRoomDetail(r))
	}
	return out, nil
}

// GetRoom is one live room with metadata, nil when not live.
func (s *Service) GetRoom(ctx context.Context, name string) (*RoomInfo, error) {
	rooms, err := s.rawRooms(ctx, []string{name})
	if err != nil {
		return nil, err
	}
	for _, r := range rooms {
		if r.GetName() == name {
			d := toRoomDetail(r)
			return &d, nil
		}
	}
	return nil, nil
}

func (s *Service) rawParticipants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	res, err := s.clients.Room.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		return nil, s.guard("listParticipants", err)
	}
	return res.GetParticipants(), nil
}

// ListParticipants is the basic participant listing.
func (s *Service) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	parts, err := s.rawParticipants(ctx, room)
	if err != nil {
		return nil, err
	}
	out := make([]Participant, 0, len(parts))
	for _, p := range parts {
		out = append(out, Participant{p.GetIdentity(), p.GetName(), p.GetPermission().GetHidden(), len(p.GetTracks()) > 0})
	}
	return out, nil
}

// ListParticipantsDetailed lists participants with tracks and permissions.
func (s *Service) ListParticipantsDetailed(ctx context.Context, room string) ([]ParticipantDetail, error) {
	parts, err := s.rawParticipants(ctx, room)
	if err != nil {
		return nil, err
	}
	out := make([]ParticipantDetail, 0, len(parts))
	for _, p := range parts {
		out = append(out, toParticipantDetail(p))
	}
	return out, nil
}

// GetParticipant is one participant (503 on any LiveKit error).
func (s *Service) GetParticipant(ctx context.Context, room, identity string) (ParticipantDetail, error) {
	p, err := s.clients.Room.GetParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity})
	if err != nil {
		return ParticipantDetail{}, s.guard("getParticipant", err)
	}
	return toParticipantDetail(p), nil
}

// RemoveParticipant disconnects a participant.
func (s *Service) RemoveParticipant(ctx context.Context, room, identity string) error {
	_, err := s.clients.Room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity})
	return s.guard("removeParticipant", err)
}

// MutedTrack is the result of a server-side mute.
type MutedTrack struct {
	TrackSid string `json:"trackSid"`
	Muted    bool   `json:"muted"`
}

// MutePublishedTrack mutes/unmutes one published track.
func (s *Service) MutePublishedTrack(ctx context.Context, room, identity, trackSid string, muted bool) (MutedTrack, error) {
	res, err := s.clients.Room.MutePublishedTrack(ctx, &livekit.MuteRoomTrackRequest{Room: room, Identity: identity, TrackSid: trackSid, Muted: muted})
	if err != nil {
		return MutedTrack{}, s.guard("mutePublishedTrack", err)
	}
	out := MutedTrack{TrackSid: trackSid, Muted: muted}
	if t := res.GetTrack(); t != nil {
		if t.GetSid() != "" {
			out.TrackSid = t.GetSid()
		}
		out.Muted = t.GetMuted()
	}
	return out, nil
}

// PermissionPatch is a (merged) participant permission set; nil = omitted.
type PermissionPatch struct {
	CanPublish     *bool
	CanSubscribe   *bool
	CanPublishData *bool
	Hidden         *bool
}

// UpdateParticipantOptions: nil fields are not sent.
type UpdateParticipantOptions struct {
	Metadata   *string
	Name       *string
	Permission *PermissionPatch
}

// UpdateParticipant updates metadata / name / (atomic) permissions.
func (s *Service) UpdateParticipant(ctx context.Context, room, identity string, o UpdateParticipantOptions) (ParticipantDetail, error) {
	req := &livekit.UpdateParticipantRequest{Room: room, Identity: identity}
	if o.Metadata != nil {
		req.Metadata = *o.Metadata
	}
	if o.Name != nil {
		req.Name = *o.Name
	}
	if p := o.Permission; p != nil {
		req.Permission = &livekit.ParticipantPermission{
			CanPublish: deref(p.CanPublish), CanSubscribe: deref(p.CanSubscribe),
			CanPublishData: deref(p.CanPublishData), Hidden: deref(p.Hidden),
		}
	}
	info, err := s.clients.Room.UpdateParticipant(ctx, req)
	if err != nil {
		return ParticipantDetail{}, s.guard("updateParticipant", err)
	}
	return toParticipantDetail(info), nil
}

func deref(b *bool) bool { return b != nil && *b }

// UpdateSubscriptions force-(un)subscribes a participant to tracks.
func (s *Service) UpdateSubscriptions(ctx context.Context, room, identity string, trackSids []string, subscribe bool) error {
	_, err := s.clients.Room.UpdateSubscriptions(ctx, &livekit.UpdateSubscriptionsRequest{
		Room: room, Identity: identity, TrackSids: trackSids, Subscribe: subscribe,
	})
	return s.guard("updateSubscriptions", err)
}

// UpdateRoomMetadata sets a room's live metadata.
func (s *Service) UpdateRoomMetadata(ctx context.Context, room, metadata string) (RoomInfo, error) {
	r, err := s.clients.Room.UpdateRoomMetadata(ctx, &livekit.UpdateRoomMetadataRequest{Room: room, Metadata: metadata})
	if err != nil {
		return RoomInfo{}, s.guard("updateRoomMetadata", err)
	}
	return toRoomDetail(r), nil
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// MintToken mints a join token (canPublish/canSubscribe/canPublishData
// default true). 503 when the API credentials are not configured.
func (s *Service) MintToken(opts MintTokenOptions) (string, error) {
	if s.cfg.LivekitAPIKey == "" || s.cfg.LivekitAPISecret == "" {
		return "", httpx.Unavailable("LiveKit API credentials not configured")
	}
	tok, err := signToken(s.cfg.LivekitAPIKey, s.cfg.LivekitAPISecret, opts, s.now())
	if err != nil {
		s.logWrite("error", "livekit", "mintToken failed: "+err.Error(), nil)
		return "", httpx.Unavailable("LiveKit mintToken failed: " + err.Error())
	}
	return tok, nil
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

// CreateIngressInput is the contract CreateIngressInput.
type CreateIngressInput struct {
	AppName             string
	RoomName            string
	InputType           string // rtmp | whip | url
	ParticipantIdentity string
	ParticipantName     string
	URL                 string
	EnableTranscoding   *bool
	// Simulcast: the app explicitly enabled the adaptive ladder.
	Simulcast bool
	MaxHeight *float64
	AudioOnly bool
}

func ingressInputEnum(t string) livekit.IngressInput {
	switch t {
	case "whip":
		return livekit.IngressInput_WHIP_INPUT
	case "url":
		return livekit.IngressInput_URL_INPUT
	}
	return livekit.IngressInput_RTMP_INPUT
}

var rtmpURLPattern = regexp.MustCompile(`(?i)^(rtmps?://)([^/:]+)(:\d+)?(/.*)?$`)

// publicizeRtmpURL swaps an RTMP push URL's host for RTMP_PUBLIC_HOST.
func (s *Service) publicizeRtmpURL(u string) string {
	host := s.cfg.RtmpPublicHost
	if host == "" || u == "" {
		return u
	}
	m := rtmpURLPattern.FindStringSubmatch(u)
	if m == nil {
		return u
	}
	return m[1] + host + m[3] + m[4]
}

func (s *Service) ingressHw(ctx context.Context, app string) *livekit.IngressVideoOptions {
	hw := get(s.opt.HwAccel)
	if hw == nil {
		return nil
	}
	v, err := hw.IngressVideo(ctx, app)
	if err != nil {
		s.logWrite("warn", "livekit", "ingress hwaccel skipped — CPU", map[string]any{"app": app, "error": err.Error()})
		return nil
	}
	return v
}

func (s *Service) egressHw(ctx context.Context, app string) *livekit.EncodingOptions {
	hw := get(s.opt.HwAccel)
	if hw == nil {
		return nil
	}
	o, err := hw.EgressEncoding(ctx, app)
	if err != nil {
		s.logWrite("warn", "livekit", "egress hwaccel skipped — CPU", map[string]any{"app": app, "error": err.Error()})
		return nil
	}
	return o
}

// BuildCreateIngressRequest builds the CreateIngress request(s): the request
// with our encoding opinions and the opinion-free fallback (nil when no
// opinions were attached). Exposed for the cross-runtime request vectors.
func (s *Service) BuildCreateIngressRequest(ctx context.Context, in CreateIngressInput) (req, fallback *livekit.CreateIngressRequest) {
	// Transcoding bypass is only valid for WHIP; RTMP/URL leave it unset.
	var enableTranscoding *bool
	if in.InputType == "whip" {
		enableTranscoding = in.EnableTranscoding
	}
	efficient := s.cfg.IngestProfile == "efficient"
	audioOnly := efficient && in.AudioOnly
	var video *livekit.IngressVideoOptions
	if enableTranscoding == nil || *enableTranscoding {
		if efficient {
			if in.Simulcast {
				video = s.ingressHw(ctx, in.AppName)
				if video == nil {
					video = BuildIngressVideoOptions(in.MaxHeight, true)
				}
			} else {
				video = BuildIngressVideoOptions(in.MaxHeight, false)
			}
		} else {
			video = s.ingressHw(ctx, in.AppName)
		}
	}
	identity := in.ParticipantIdentity
	if identity == "" {
		identity = "ingress-" + uuid.NewString()
	}
	base := func() *livekit.CreateIngressRequest {
		return &livekit.CreateIngressRequest{
			InputType:           ingressInputEnum(in.InputType),
			Name:                in.AppName + "-" + in.RoomName,
			RoomName:            in.RoomName,
			ParticipantIdentity: identity,
			ParticipantName:     in.ParticipantName,
			Url:                 in.URL,
			EnableTranscoding:   enableTranscoding,
		}
	}
	req = base()
	// audioOnly has no CreateIngressRequest field: livekit-server-sdk drops it
	// on the wire (it only arms the fallback below), and so do we.
	req.Video = video
	if video != nil || audioOnly {
		fallback = base()
	}
	return req, fallback
}

// CreateIngress creates an RTMP/WHIP/URL ingress (URL pulls pass the SSRF
// guard first). Rejected encoding opinions are retried once without them.
func (s *Service) CreateIngress(ctx context.Context, in CreateIngressInput) (IngressInfo, error) {
	if in.InputType == "url" {
		if in.URL == "" {
			return IngressInfo{}, httpx.Unavailable(`createIngress: url is required for inputType "url"`)
		}
		if err := AssertSafePullURL(ctx, in.URL, s.resolve); err != nil {
			return IngressInfo{}, err
		}
	}
	req, fallback := s.BuildCreateIngressRequest(ctx, in)
	info, err := s.clients.Ingress.CreateIngress(ctx, req)
	if err != nil {
		gerr := s.guard("createIngress", err)
		if fallback == nil {
			return IngressInfo{}, gerr
		}
		s.logWrite("warn", "livekit", "ingress options rejected — retrying with LiveKit defaults",
			map[string]any{"app": in.AppName, "room": in.RoomName, "error": gerr.Error()})
		info, err = s.clients.Ingress.CreateIngress(ctx, fallback)
		if err != nil {
			return IngressInfo{}, s.guard("createIngress", err)
		}
	}
	u := info.GetUrl()
	if in.InputType == "rtmp" {
		u = s.publicizeRtmpURL(u)
	}
	room := info.GetRoomName()
	if room == "" {
		room = in.RoomName
	}
	return IngressInfo{IngressID: info.GetIngressId(), URL: u, StreamKey: info.GetStreamKey(), RoomName: room}, nil
}

// DeleteIngress deletes an ingress.
func (s *Service) DeleteIngress(ctx context.Context, ingressID string) error {
	_, err := s.clients.Ingress.DeleteIngress(ctx, &livekit.DeleteIngressRequest{IngressId: ingressID})
	return s.guard("deleteIngress", err)
}

// ListIngress lists ingresses (optionally of one room) with live state.
func (s *Service) ListIngress(ctx context.Context, roomName string) ([]IngressListItem, error) {
	res, err := s.clients.Ingress.ListIngress(ctx, &livekit.ListIngressRequest{RoomName: roomName})
	if err != nil {
		return nil, s.guard("listIngress", err)
	}
	out := make([]IngressListItem, 0, len(res.GetItems()))
	for _, info := range res.GetItems() {
		u := info.GetUrl()
		if info.GetInputType() == livekit.IngressInput_RTMP_INPUT {
			u = s.publicizeRtmpURL(u)
		}
		it := IngressListItem{
			IngressInfo: IngressInfo{IngressID: info.GetIngressId(), URL: u, StreamKey: info.GetStreamKey(), RoomName: info.GetRoomName()},
			Name:        info.GetName(),
			InputType:   "rtmp",
			Status:      "inactive",
		}
		if n, ok := ingressInputNames[info.GetInputType()]; ok {
			it.InputType = n
		}
		st := info.GetState()
		if st != nil {
			if n, ok := ingressStatusNames[st.GetStatus()]; ok {
				it.Status = n
			}
			if v := st.GetVideo(); v != nil {
				it.Bitrate = positive(int64(v.GetAverageBitrate()))
				it.Width = positive(int64(v.GetWidth()))
				it.Height = positive(int64(v.GetHeight()))
			}
		}
		it.StartedAt = tsToISO(st.GetStartedAt())
		out = append(out, it)
	}
	return out, nil
}

func positive(n int64) *int64 {
	if n == 0 {
		return nil
	}
	return &n
}

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

// StartEgressInput is the contract StartEgressInput (file recording).
type StartEgressInput struct {
	AppName             string
	RoomName            string
	Mode                string // room-composite | participant
	ParticipantIdentity string
	Layout              string
	OutputFilepath      string
	SnapshotIntervalS   float64
	SnapshotFilePrefix  string
}

// BuildStartEgressRequest returns the RoomComposite or Participant request.
func BuildStartEgressRequest(in StartEgressInput, enc *livekit.EncodingOptions) (*livekit.RoomCompositeEgressRequest, *livekit.ParticipantEgressRequest) {
	file := &livekit.EncodedFileOutput{FileType: livekit.EncodedFileType_MP4, Filepath: in.OutputFilepath}
	var images []*livekit.ImageOutput
	if in.SnapshotIntervalS > 0 && in.SnapshotFilePrefix != "" {
		images = []*livekit.ImageOutput{{
			CaptureInterval: uint32(math.Floor(in.SnapshotIntervalS)),
			FilenamePrefix:  in.SnapshotFilePrefix,
			FilenameSuffix:  livekit.ImageFileSuffix_IMAGE_SUFFIX_INDEX,
			DisableManifest: true,
		}}
	}
	if in.Mode == "participant" {
		req := &livekit.ParticipantEgressRequest{
			RoomName: in.RoomName, Identity: in.ParticipantIdentity,
			FileOutputs: []*livekit.EncodedFileOutput{file}, ImageOutputs: images,
		}
		if enc != nil {
			req.Options = &livekit.ParticipantEgressRequest_Advanced{Advanced: enc}
		}
		return nil, req
	}
	req := &livekit.RoomCompositeEgressRequest{
		RoomName: in.RoomName, Layout: in.Layout,
		FileOutputs: []*livekit.EncodedFileOutput{file}, ImageOutputs: images,
	}
	if enc != nil {
		req.Options = &livekit.RoomCompositeEgressRequest_Advanced{Advanced: enc}
	}
	return req, nil
}

// StartEgress starts a file recording (room-composite or participant).
func (s *Service) StartEgress(ctx context.Context, in StartEgressInput) (EgressInfo, error) {
	enc := s.egressHw(ctx, in.AppName)
	var info *livekit.EgressInfo
	var err error
	if in.Mode == "participant" && in.ParticipantIdentity == "" {
		err = errors.New("participantIdentity required for participant egress")
	} else {
		rc, pr := BuildStartEgressRequest(in, enc)
		if pr != nil {
			info, err = s.clients.Egress.StartParticipantEgress(ctx, pr)
		} else {
			info, err = s.clients.Egress.StartRoomCompositeEgress(ctx, rc)
		}
	}
	if err != nil {
		return EgressInfo{}, s.guard("startEgress", err)
	}
	return EgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus())}, nil
}

// TrackCompositeInput records one participant's tracks (no headless Chrome).
type TrackCompositeInput struct {
	AppName             string
	RoomName            string
	ParticipantIdentity string
	OutputFilepath      string
	AudioOnly           bool
}

// StartTrackCompositeEgress resolves the participant's first audio (+ first
// video unless AudioOnly) track and starts a file TrackComposite egress.
func (s *Service) StartTrackCompositeEgress(ctx context.Context, in TrackCompositeInput) (EgressInfo, error) {
	enc := s.egressHw(ctx, in.AppName)
	info, err := func() (*livekit.EgressInfo, error) {
		p, err := s.clients.Room.GetParticipant(ctx, &livekit.RoomParticipantIdentity{Room: in.RoomName, Identity: in.ParticipantIdentity})
		if err != nil {
			return nil, err
		}
		var audio, video string
		for _, t := range p.GetTracks() {
			if audio == "" && t.GetType() == livekit.TrackType_AUDIO {
				audio = t.GetSid()
			}
			if video == "" && t.GetType() == livekit.TrackType_VIDEO {
				video = t.GetSid()
			}
		}
		if in.AudioOnly {
			video = ""
			if audio == "" {
				return nil, fmt.Errorf("participant '%s' publishes no audio track", in.ParticipantIdentity)
			}
		}
		if audio == "" && video == "" {
			return nil, fmt.Errorf("participant '%s' publishes no tracks", in.ParticipantIdentity)
		}
		req := &livekit.TrackCompositeEgressRequest{
			RoomName: in.RoomName, AudioTrackId: audio, VideoTrackId: video,
			FileOutputs: []*livekit.EncodedFileOutput{{FileType: livekit.EncodedFileType_MP4, Filepath: in.OutputFilepath}},
		}
		if enc != nil {
			req.Options = &livekit.TrackCompositeEgressRequest_Advanced{Advanced: enc}
		}
		return s.clients.Egress.StartTrackCompositeEgress(ctx, req)
	}()
	if err != nil {
		return EgressInfo{}, s.guard("startTrackCompositeEgress", err)
	}
	return EgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus())}, nil
}

// StartStreamEgressInput pushes a room composite to an RTMP target.
type StartStreamEgressInput struct {
	AppName  string
	RoomName string
	RtmpURL  string
	Layout   string
}

// StartStreamEgress starts a RoomComposite → RTMP egress ("broadcast").
func (s *Service) StartStreamEgress(ctx context.Context, in StartStreamEgressInput) (StreamEgressInfo, error) {
	enc := s.egressHw(ctx, in.AppName)
	req := &livekit.RoomCompositeEgressRequest{
		RoomName: in.RoomName, Layout: in.Layout,
		StreamOutputs: []*livekit.StreamOutput{{Protocol: livekit.StreamProtocol_RTMP, Urls: []string{in.RtmpURL}}},
	}
	if enc != nil {
		req.Options = &livekit.RoomCompositeEgressRequest_Advanced{Advanced: enc}
	}
	info, err := s.clients.Egress.StartRoomCompositeEgress(ctx, req)
	if err != nil {
		return StreamEgressInfo{}, s.guard("startStreamEgress", err)
	}
	urls := extractStreamURLs(info)
	if len(urls) == 0 {
		urls = []string{in.RtmpURL}
	}
	room := info.GetRoomName()
	if room == "" {
		room = in.RoomName
	}
	return StreamEgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus()), room, urls}, nil
}

func (s *Service) activeEgress(ctx context.Context, op string) ([]*livekit.EgressInfo, error) {
	res, err := s.clients.Egress.ListEgress(ctx, &livekit.ListEgressRequest{Active: true})
	if err != nil {
		return nil, s.guard(op, err)
	}
	return res.GetItems(), nil
}

// ListStreamEgress lists active RTMP egresses of rooms under roomPrefix.
func (s *Service) ListStreamEgress(ctx context.Context, roomPrefix string) ([]StreamEgressInfo, error) {
	list, err := s.activeEgress(ctx, "listStreamEgress")
	if err != nil {
		return nil, err
	}
	out := []StreamEgressInfo{}
	for _, info := range list {
		if isStreamEgress(info) && roomBelongsToPrefix(info.GetRoomName(), roomPrefix) {
			out = append(out, StreamEgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus()), info.GetRoomName(), extractStreamURLs(info)})
		}
	}
	return out, nil
}

func isStreamEgress(info *livekit.EgressInfo) bool {
	if len(info.GetStreamResults()) > 0 {
		return true
	}
	if rc := info.GetRoomComposite(); rc != nil {
		return len(rc.GetStreamOutputs()) > 0
	}
	return false
}

func extractStreamURLs(info *livekit.EgressInfo) []string {
	live := []string{}
	for _, r := range info.GetStreamResults() {
		if r.GetUrl() != "" {
			live = append(live, r.GetUrl())
		}
	}
	if len(live) > 0 {
		return live
	}
	if rc := info.GetRoomComposite(); rc != nil {
		var urls []string
		for _, o := range rc.GetStreamOutputs() {
			urls = append(urls, o.GetUrls()...)
		}
		if len(urls) > 0 {
			return urls
		}
	}
	return []string{}
}

func roomBelongsToPrefix(room, prefix string) bool {
	if room == "" || prefix == "" {
		return false
	}
	return room == prefix || strings.HasPrefix(room, prefix+"-")
}

// StartHlsEgressInput writes a live HLS playlist + segments to a local dir.
type StartHlsEgressInput struct {
	AppName          string
	RoomName         string
	OutputDir        string
	PlaylistName     string
	LivePlaylistName string
	SegmentDurationS float64
	Layout           string
}

// BuildHlsEgressRequest builds the RoomComposite segments request.
func BuildHlsEgressRequest(in StartHlsEgressInput, enc *livekit.EncodingOptions) *livekit.RoomCompositeEgressRequest {
	dur := uint32(4)
	if in.SegmentDurationS > 0 {
		dur = uint32(math.Floor(in.SegmentDurationS))
	}
	seg := &livekit.SegmentedFileOutput{
		Protocol:        livekit.SegmentedFileProtocol_HLS_PROTOCOL,
		FilenamePrefix:  filepath.Join(in.OutputDir, "segment_"),
		PlaylistName:    filepath.Join(in.OutputDir, in.PlaylistName),
		SegmentDuration: dur,
		FilenameSuffix:  livekit.SegmentedFileSuffix_INDEX,
		DisableManifest: true,
	}
	if in.LivePlaylistName != "" {
		seg.LivePlaylistName = filepath.Join(in.OutputDir, in.LivePlaylistName)
	}
	req := &livekit.RoomCompositeEgressRequest{
		RoomName: in.RoomName, Layout: in.Layout,
		SegmentOutputs: []*livekit.SegmentedFileOutput{seg},
	}
	if enc != nil {
		req.Options = &livekit.RoomCompositeEgressRequest_Advanced{Advanced: enc}
	}
	return req
}

// StartHlsEgress starts a RoomComposite → local HLS egress.
func (s *Service) StartHlsEgress(ctx context.Context, in StartHlsEgressInput) (HlsEgressInfo, error) {
	enc := s.egressHw(ctx, in.AppName)
	info, err := s.clients.Egress.StartRoomCompositeEgress(ctx, BuildHlsEgressRequest(in, enc))
	if err != nil {
		return HlsEgressInfo{}, s.guard("startHlsEgress", err)
	}
	room := info.GetRoomName()
	if room == "" {
		room = in.RoomName
	}
	return HlsEgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus()), room, extractPlaylistLocation(info)}, nil
}

// ListHlsEgress lists active HLS egresses of rooms under roomPrefix.
func (s *Service) ListHlsEgress(ctx context.Context, roomPrefix string) ([]HlsEgressInfo, error) {
	list, err := s.activeEgress(ctx, "listHlsEgress")
	if err != nil {
		return nil, err
	}
	out := []HlsEgressInfo{}
	for _, info := range list {
		if isHlsEgress(info) && roomBelongsToPrefix(info.GetRoomName(), roomPrefix) {
			out = append(out, HlsEgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus()), info.GetRoomName(), extractPlaylistLocation(info)})
		}
	}
	return out, nil
}

func isHlsEgress(info *livekit.EgressInfo) bool {
	if len(info.GetSegmentResults()) > 0 {
		return true
	}
	if rc := info.GetRoomComposite(); rc != nil {
		return len(rc.GetSegmentOutputs()) > 0
	}
	return false
}

func extractPlaylistLocation(info *livekit.EgressInfo) string {
	if res := info.GetSegmentResults(); len(res) > 0 {
		if res[0].GetPlaylistLocation() != "" {
			return res[0].GetPlaylistLocation()
		}
		if res[0].GetPlaylistName() != "" {
			return res[0].GetPlaylistName()
		}
	}
	if rc := info.GetRoomComposite(); rc != nil {
		if outs := rc.GetSegmentOutputs(); len(outs) > 0 {
			return outs[0].GetPlaylistName()
		}
	}
	return ""
}

// StopEgress stops an egress.
func (s *Service) StopEgress(ctx context.Context, egressID string) (EgressInfo, error) {
	info, err := s.clients.Egress.StopEgress(ctx, &livekit.StopEgressRequest{EgressId: egressID})
	if err != nil {
		return EgressInfo{}, s.guard("stopEgress", err)
	}
	return EgressInfo{info.GetEgressId(), EgressStatusString(info.GetStatus())}, nil
}

// ---------------------------------------------------------------------------
// Data channels
// ---------------------------------------------------------------------------

// SendDataOptions: Reliable nil → reliable.
type SendDataOptions struct {
	Topic                 *string
	DestinationIdentities []string
	Reliable              *bool
}

// SendData pushes a server-side data message to a room.
func (s *Service) SendData(ctx context.Context, room, payload string, o SendDataOptions) error {
	kind := livekit.DataPacket_RELIABLE
	if o.Reliable != nil && !*o.Reliable {
		kind = livekit.DataPacket_LOSSY
	}
	req := &livekit.SendDataRequest{Room: room, Data: []byte(payload), Kind: kind, DestinationSids: []string{}, DestinationIdentities: o.DestinationIdentities, Topic: o.Topic}
	_, err := s.clients.Room.SendData(ctx, req)
	return s.guard("sendData", err)
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// IsReachable reports whether LiveKit answers ListRooms.
func (s *Service) IsReachable(ctx context.Context) bool {
	if _, err := s.clients.Room.ListRooms(ctx, &livekit.ListRoomsRequest{Names: []string{}}); err != nil {
		s.logWrite("warn", "livekit", "isReachable: "+err.Error(), nil)
		return false
	}
	return true
}
