package livekit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
)

// fakeLK implements RoomAPI, IngressAPI and EgressAPI: it records every
// request (service, method, proto3 JSON) and answers from a queue of proto3
// JSON responses; an "!error:<msg>" entry fails the call with msg.
type fakeLK struct {
	mu        sync.Mutex
	responses []string
	requests  []recorded
	// on, when set, answers instead of the queue.
	on func(method string, req any) (string, bool)
}

type recorded struct {
	Service string          `json:"service"`
	Method  string          `json:"method"`
	Data    json.RawMessage `json:"data"`
	msg     proto.Message
}

func (f *fakeLK) clients() *Clients { return &Clients{Room: f, Ingress: f, Egress: f} }

func (f *fakeLK) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if r.Method == method {
			n++
		}
	}
	return n
}

func do[Res proto.Message](f *fakeLK, service, method string, req proto.Message, res Res) (Res, error) {
	f.mu.Lock()
	b, _ := protojson.Marshal(req)
	var c bytes.Buffer
	_ = json.Compact(&c, b) // protojson randomizes whitespace
	f.requests = append(f.requests, recorded{service, method, c.Bytes(), req})
	var r string
	ok := false
	if f.on != nil {
		r, ok = f.on(method, req)
	}
	if !ok && len(f.responses) > 0 {
		r, f.responses = f.responses[0], f.responses[1:]
	}
	f.mu.Unlock()
	var zero Res
	if len(r) > 7 && r[:7] == "!error:" {
		return zero, errors.New(r[7:])
	}
	if r == "" {
		r = "{}"
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal([]byte(r), res); err != nil {
		panic(err)
	}
	return res, nil
}

func (f *fakeLK) CreateRoom(_ context.Context, r *livekit.CreateRoomRequest) (*livekit.Room, error) {
	return do(f, "RoomService", "CreateRoom", r, &livekit.Room{})
}
func (f *fakeLK) ListRooms(_ context.Context, r *livekit.ListRoomsRequest) (*livekit.ListRoomsResponse, error) {
	return do(f, "RoomService", "ListRooms", r, &livekit.ListRoomsResponse{})
}
func (f *fakeLK) DeleteRoom(_ context.Context, r *livekit.DeleteRoomRequest) (*livekit.DeleteRoomResponse, error) {
	return do(f, "RoomService", "DeleteRoom", r, &livekit.DeleteRoomResponse{})
}
func (f *fakeLK) ListParticipants(_ context.Context, r *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error) {
	return do(f, "RoomService", "ListParticipants", r, &livekit.ListParticipantsResponse{})
}
func (f *fakeLK) GetParticipant(_ context.Context, r *livekit.RoomParticipantIdentity) (*livekit.ParticipantInfo, error) {
	return do(f, "RoomService", "GetParticipant", r, &livekit.ParticipantInfo{})
}
func (f *fakeLK) RemoveParticipant(_ context.Context, r *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error) {
	return do(f, "RoomService", "RemoveParticipant", r, &livekit.RemoveParticipantResponse{})
}
func (f *fakeLK) MutePublishedTrack(_ context.Context, r *livekit.MuteRoomTrackRequest) (*livekit.MuteRoomTrackResponse, error) {
	return do(f, "RoomService", "MutePublishedTrack", r, &livekit.MuteRoomTrackResponse{})
}
func (f *fakeLK) UpdateParticipant(_ context.Context, r *livekit.UpdateParticipantRequest) (*livekit.ParticipantInfo, error) {
	return do(f, "RoomService", "UpdateParticipant", r, &livekit.ParticipantInfo{})
}
func (f *fakeLK) UpdateSubscriptions(_ context.Context, r *livekit.UpdateSubscriptionsRequest) (*livekit.UpdateSubscriptionsResponse, error) {
	return do(f, "RoomService", "UpdateSubscriptions", r, &livekit.UpdateSubscriptionsResponse{})
}
func (f *fakeLK) UpdateRoomMetadata(_ context.Context, r *livekit.UpdateRoomMetadataRequest) (*livekit.Room, error) {
	return do(f, "RoomService", "UpdateRoomMetadata", r, &livekit.Room{})
}
func (f *fakeLK) SendData(_ context.Context, r *livekit.SendDataRequest) (*livekit.SendDataResponse, error) {
	return do(f, "RoomService", "SendData", r, &livekit.SendDataResponse{})
}
func (f *fakeLK) CreateIngress(_ context.Context, r *livekit.CreateIngressRequest) (*livekit.IngressInfo, error) {
	return do(f, "Ingress", "CreateIngress", r, &livekit.IngressInfo{})
}
func (f *fakeLK) ListIngress(_ context.Context, r *livekit.ListIngressRequest) (*livekit.ListIngressResponse, error) {
	return do(f, "Ingress", "ListIngress", r, &livekit.ListIngressResponse{})
}
func (f *fakeLK) DeleteIngress(_ context.Context, r *livekit.DeleteIngressRequest) (*livekit.IngressInfo, error) {
	return do(f, "Ingress", "DeleteIngress", r, &livekit.IngressInfo{})
}
func (f *fakeLK) StartRoomCompositeEgress(_ context.Context, r *livekit.RoomCompositeEgressRequest) (*livekit.EgressInfo, error) {
	return do(f, "Egress", "StartRoomCompositeEgress", r, &livekit.EgressInfo{})
}
func (f *fakeLK) StartParticipantEgress(_ context.Context, r *livekit.ParticipantEgressRequest) (*livekit.EgressInfo, error) {
	return do(f, "Egress", "StartParticipantEgress", r, &livekit.EgressInfo{})
}
func (f *fakeLK) StartTrackCompositeEgress(_ context.Context, r *livekit.TrackCompositeEgressRequest) (*livekit.EgressInfo, error) {
	return do(f, "Egress", "StartTrackCompositeEgress", r, &livekit.EgressInfo{})
}
func (f *fakeLK) ListEgress(_ context.Context, r *livekit.ListEgressRequest) (*livekit.ListEgressResponse, error) {
	return do(f, "Egress", "ListEgress", r, &livekit.ListEgressResponse{})
}
func (f *fakeLK) StopEgress(_ context.Context, r *livekit.StopEgressRequest) (*livekit.EgressInfo, error) {
	return do(f, "Egress", "StopEgress", r, &livekit.EgressInfo{})
}

// testConfig is the vectors' config (gen-vectors.js service()).
func testConfig(profile string) *config.Config {
	return &config.Config{
		LivekitURL: "ws://lk.test:7880", LivekitAPIKey: "APIkey", LivekitAPISecret: "secret-0123456789",
		IngestProfile: profile, RtmpPublicHost: "rtmp.example.com", JWTSecret: "jwt-master",
	}
}

func newTestService(cfg *config.Config, f *fakeLK) *Service {
	return NewService(cfg, f.clients(), nil, Optional{}, func(context.Context, string) ([]string, error) {
		return []string{"93.184.216.34"}, nil
	})
}
