package streams

import (
	"context"
	"strings"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// RoomServiceAPI / IngressServiceAPI are the SDK client methods LKRooms
// needs (satisfied by the livekit package's Clients.Room / Clients.Ingress).
type RoomServiceAPI interface {
	ListRooms(ctx context.Context, req *livekit.ListRoomsRequest) (*livekit.ListRoomsResponse, error)
	DeleteRoom(ctx context.Context, req *livekit.DeleteRoomRequest) (*livekit.DeleteRoomResponse, error)
	ListParticipants(ctx context.Context, req *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error)
	RemoveParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error)
}

// IngressServiceAPI is the ingress slice of the SDK.
type IngressServiceAPI interface {
	ListIngress(ctx context.Context, req *livekit.ListIngressRequest) (*livekit.ListIngressResponse, error)
	DeleteIngress(ctx context.Context, req *livekit.DeleteIngressRequest) (*livekit.IngressInfo, error)
}

// LKRooms adapts the LiveKit SDK clients to Rooms.
type LKRooms struct {
	Room    RoomServiceAPI
	Ingress IngressServiceAPI
}

// ListRooms implements Rooms.
func (l LKRooms) ListRooms(ctx context.Context) ([]string, error) {
	res, err := l.Room.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(res.GetRooms()))
	for _, r := range res.GetRooms() {
		out = append(out, r.GetName())
	}
	return out, nil
}

// ListParticipants implements Rooms.
func (l LKRooms) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	res, err := l.Room.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		return nil, err
	}
	out := make([]Participant, 0, len(res.GetParticipants()))
	for _, p := range res.GetParticipants() {
		out = append(out, Participant{
			Identity: p.GetIdentity(),
			Tracks:   len(p.GetTracks()),
			Hidden:   p.GetPermission().GetHidden(),
			Ingress:  p.GetKind() == livekit.ParticipantInfo_INGRESS,
		})
	}
	return out, nil
}

// RemoveParticipant implements Rooms.
func (l LKRooms) RemoveParticipant(ctx context.Context, room, identity string) error {
	_, err := l.Room.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity})
	return err
}

// DeleteRoom implements Rooms.
func (l LKRooms) DeleteRoom(ctx context.Context, room string) error {
	_, err := l.Room.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room})
	return err
}

// ListIngress implements Rooms.
func (l LKRooms) ListIngress(ctx context.Context, room string) ([]Ingress, error) {
	res, err := l.Ingress.ListIngress(ctx, &livekit.ListIngressRequest{RoomName: room})
	if err != nil {
		return nil, err
	}
	out := make([]Ingress, 0, len(res.GetItems()))
	for _, i := range res.GetItems() {
		out = append(out, Ingress{i.GetIngressId(), i.GetRoomName(), i.GetParticipantIdentity()})
	}
	return out, nil
}

// DeleteIngress implements Rooms.
func (l LKRooms) DeleteIngress(ctx context.Context, id string) error {
	_, err := l.Ingress.DeleteIngress(ctx, &livekit.DeleteIngressRequest{IngressId: id})
	return err
}

// NewLKRooms builds the SDK clients like StreamsService's constructor
// (ws:/wss: → http:/https:, case-insensitive).
func NewLKRooms(rawURL, apiKey, apiSecret string) LKRooms {
	host := rawURL
	switch {
	case len(host) >= 3 && strings.EqualFold(host[:3], "ws:"):
		host = "http:" + host[3:]
	case len(host) >= 4 && strings.EqualFold(host[:4], "wss:"):
		host = "https:" + host[4:]
	}
	return LKRooms{
		Room:    lksdk.NewRoomServiceClient(host, apiKey, apiSecret),
		Ingress: lksdk.NewIngressClient(host, apiKey, apiSecret),
	}
}
