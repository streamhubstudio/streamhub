// Package livekit is the port of src/modules/livekit: the LiveKit SDK wrapper
// (rooms, participants, ingress, egress, data, tokens, webhooks), the RTMP
// ingress key/password store, the primary+backup ingress pairing, the per-app
// token/ingress/playback routes, the rooms/moderation routes, the LiveKit
// webhook sink and GET /stats (modules/health stats(), which needs the same
// room/egress/ingress clients).
//
// The SDK clients sit behind RoomAPI / IngressAPI / EgressAPI so tests run
// on fakes (no network). Production uses server-sdk-go v2.19.0 against
// LiveKit server 1.13 / ingress 1.5 / egress 1.15.
package livekit

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/twitchtv/twirp"
)

// RoomAPI is the RoomService surface the core uses (lksdk.RoomServiceClient).
type RoomAPI interface {
	CreateRoom(ctx context.Context, req *livekit.CreateRoomRequest) (*livekit.Room, error)
	ListRooms(ctx context.Context, req *livekit.ListRoomsRequest) (*livekit.ListRoomsResponse, error)
	DeleteRoom(ctx context.Context, req *livekit.DeleteRoomRequest) (*livekit.DeleteRoomResponse, error)
	ListParticipants(ctx context.Context, req *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error)
	GetParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.ParticipantInfo, error)
	RemoveParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error)
	MutePublishedTrack(ctx context.Context, req *livekit.MuteRoomTrackRequest) (*livekit.MuteRoomTrackResponse, error)
	UpdateParticipant(ctx context.Context, req *livekit.UpdateParticipantRequest) (*livekit.ParticipantInfo, error)
	UpdateSubscriptions(ctx context.Context, req *livekit.UpdateSubscriptionsRequest) (*livekit.UpdateSubscriptionsResponse, error)
	UpdateRoomMetadata(ctx context.Context, req *livekit.UpdateRoomMetadataRequest) (*livekit.Room, error)
	SendData(ctx context.Context, req *livekit.SendDataRequest) (*livekit.SendDataResponse, error)
}

// IngressAPI is the IngressService surface (lksdk.IngressClient).
type IngressAPI interface {
	CreateIngress(ctx context.Context, req *livekit.CreateIngressRequest) (*livekit.IngressInfo, error)
	ListIngress(ctx context.Context, req *livekit.ListIngressRequest) (*livekit.ListIngressResponse, error)
	DeleteIngress(ctx context.Context, req *livekit.DeleteIngressRequest) (*livekit.IngressInfo, error)
}

// EgressAPI is the Egress surface (lksdk.EgressClient).
type EgressAPI interface {
	StartRoomCompositeEgress(ctx context.Context, req *livekit.RoomCompositeEgressRequest) (*livekit.EgressInfo, error)
	StartParticipantEgress(ctx context.Context, req *livekit.ParticipantEgressRequest) (*livekit.EgressInfo, error)
	StartTrackCompositeEgress(ctx context.Context, req *livekit.TrackCompositeEgressRequest) (*livekit.EgressInfo, error)
	ListEgress(ctx context.Context, req *livekit.ListEgressRequest) (*livekit.ListEgressResponse, error)
	StopEgress(ctx context.Context, req *livekit.StopEgressRequest) (*livekit.EgressInfo, error)
}

// Clients bundles the three SDK clients.
type Clients struct {
	Room    RoomAPI
	Ingress IngressAPI
	Egress  EgressAPI
}

// HTTPURL is the LiveKit HTTP API base: ws:// → http://, wss:// → https://
// (LiveKitService.httpUrl; an empty URL means the local default).
func HTTPURL(u string) string {
	if u == "" {
		u = "ws://127.0.0.1:7880"
	}
	if strings.HasPrefix(u, "wss://") {
		return "https://" + u[len("wss://"):]
	}
	if strings.HasPrefix(u, "ws://") {
		return "http://" + u[len("ws://"):]
	}
	return u
}

// NewClients builds the real server-sdk-go clients. Every call goes through
// sdkCall, which reproduces livekit-server-sdk (Node) failure semantics: no
// key/secret → "api-key and api-secret must be set" before any I/O, a 60 s
// request timeout, transport failures read "fetch failed" and server errors
// carry the Twirp msg.
func NewClients(rawURL, apiKey, apiSecret string) Clients {
	host := HTTPURL(rawURL)
	gate := creds{key: apiKey, secret: apiSecret}
	return Clients{
		Room:    roomClient{lksdk.NewRoomServiceClient(host, apiKey, apiSecret), gate},
		Ingress: ingressClient{lksdk.NewIngressClient(host, apiKey, apiSecret), gate},
		Egress:  egressClient{lksdk.NewEgressClient(host, apiKey, apiSecret), gate},
	}
}

// errNoCredentials is the Node SDK's AccessToken constructor error.
var errNoCredentials = errors.New("api-key and api-secret must be set")

// requestTimeout is TwirpRpc's defaultTimeoutSeconds.
const requestTimeout = 60 * time.Second

type creds struct{ key, secret string }

func call[Req, Res any](ctx context.Context, c creds, fn func(context.Context, Req) (Res, error), req Req) (Res, error) {
	var zero Res
	if c.key == "" || c.secret == "" {
		return zero, errNoCredentials
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	res, err := fn(ctx, req)
	if err != nil {
		return zero, sdkError(err)
	}
	return res, nil
}

// sdkError maps a Go SDK error to the message the Node SDK would surface.
func sdkError(err error) error {
	var te twirp.Error
	if errors.As(err, &te) {
		// Client-side failures (dial, TLS, timeout) carry the wrapped cause;
		// in Node they are fetch() rejections.
		if te.Meta("cause") != "" || isTransport(err) {
			return errors.New("fetch failed")
		}
		return errors.New(te.Msg())
	}
	if isTransport(err) {
		return errors.New("fetch failed")
	}
	return err
}

func isTransport(err error) bool {
	var ue *url.Error
	return errors.As(err, &ue) || errors.Is(err, context.DeadlineExceeded)
}

type roomClient struct {
	c *lksdk.RoomServiceClient
	creds
}

func (r roomClient) CreateRoom(ctx context.Context, req *livekit.CreateRoomRequest) (*livekit.Room, error) {
	return call(ctx, r.creds, r.c.CreateRoom, req)
}
func (r roomClient) ListRooms(ctx context.Context, req *livekit.ListRoomsRequest) (*livekit.ListRoomsResponse, error) {
	return call(ctx, r.creds, r.c.ListRooms, req)
}
func (r roomClient) DeleteRoom(ctx context.Context, req *livekit.DeleteRoomRequest) (*livekit.DeleteRoomResponse, error) {
	return call(ctx, r.creds, r.c.DeleteRoom, req)
}
func (r roomClient) ListParticipants(ctx context.Context, req *livekit.ListParticipantsRequest) (*livekit.ListParticipantsResponse, error) {
	return call(ctx, r.creds, r.c.ListParticipants, req)
}
func (r roomClient) GetParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.ParticipantInfo, error) {
	return call(ctx, r.creds, r.c.GetParticipant, req)
}
func (r roomClient) RemoveParticipant(ctx context.Context, req *livekit.RoomParticipantIdentity) (*livekit.RemoveParticipantResponse, error) {
	return call(ctx, r.creds, r.c.RemoveParticipant, req)
}
func (r roomClient) MutePublishedTrack(ctx context.Context, req *livekit.MuteRoomTrackRequest) (*livekit.MuteRoomTrackResponse, error) {
	return call(ctx, r.creds, r.c.MutePublishedTrack, req)
}
func (r roomClient) UpdateParticipant(ctx context.Context, req *livekit.UpdateParticipantRequest) (*livekit.ParticipantInfo, error) {
	return call(ctx, r.creds, r.c.UpdateParticipant, req)
}
func (r roomClient) UpdateSubscriptions(ctx context.Context, req *livekit.UpdateSubscriptionsRequest) (*livekit.UpdateSubscriptionsResponse, error) {
	return call(ctx, r.creds, r.c.UpdateSubscriptions, req)
}
func (r roomClient) UpdateRoomMetadata(ctx context.Context, req *livekit.UpdateRoomMetadataRequest) (*livekit.Room, error) {
	return call(ctx, r.creds, r.c.UpdateRoomMetadata, req)
}
func (r roomClient) SendData(ctx context.Context, req *livekit.SendDataRequest) (*livekit.SendDataResponse, error) {
	return call(ctx, r.creds, r.c.SendData, req)
}

type ingressClient struct {
	c *lksdk.IngressClient
	creds
}

func (i ingressClient) CreateIngress(ctx context.Context, req *livekit.CreateIngressRequest) (*livekit.IngressInfo, error) {
	return call(ctx, i.creds, i.c.CreateIngress, req)
}
func (i ingressClient) ListIngress(ctx context.Context, req *livekit.ListIngressRequest) (*livekit.ListIngressResponse, error) {
	return call(ctx, i.creds, i.c.ListIngress, req)
}
func (i ingressClient) DeleteIngress(ctx context.Context, req *livekit.DeleteIngressRequest) (*livekit.IngressInfo, error) {
	return call(ctx, i.creds, i.c.DeleteIngress, req)
}

type egressClient struct {
	c *lksdk.EgressClient
	creds
}

func (e egressClient) StartRoomCompositeEgress(ctx context.Context, req *livekit.RoomCompositeEgressRequest) (*livekit.EgressInfo, error) {
	return call(ctx, e.creds, e.c.StartRoomCompositeEgress, req)
}
func (e egressClient) StartParticipantEgress(ctx context.Context, req *livekit.ParticipantEgressRequest) (*livekit.EgressInfo, error) {
	return call(ctx, e.creds, e.c.StartParticipantEgress, req)
}
func (e egressClient) StartTrackCompositeEgress(ctx context.Context, req *livekit.TrackCompositeEgressRequest) (*livekit.EgressInfo, error) {
	return call(ctx, e.creds, e.c.StartTrackCompositeEgress, req)
}
func (e egressClient) ListEgress(ctx context.Context, req *livekit.ListEgressRequest) (*livekit.ListEgressResponse, error) {
	return call(ctx, e.creds, e.c.ListEgress, req)
}
func (e egressClient) StopEgress(ctx context.Context, req *livekit.StopEgressRequest) (*livekit.EgressInfo, error) {
	return call(ctx, e.creds, e.c.StopEgress, req)
}
