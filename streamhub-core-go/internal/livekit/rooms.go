package livekit

import (
	"context"
	"net/http"
	"regexp"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
)

// ---------------------------------------------------------------------------
// Data channels: POST /apps/:app/streams/:id/data and /rooms/:room/data
// ---------------------------------------------------------------------------

func sendDataRules(b *validate.Body) {
	b.Field("topic").MaxLength(64).IsString()
	optStr(b, "message", 4000)
	optStr(b, "reaction", 64)
	optStr(b, "payload", 8000)
	optStr(b, "from", 120)
	b.Optional("destinationIdentities").EachIsString().IsArray()
	optBool(b, "reliable")
}

// dataEnvelope is the default data payload (JSON.stringify drops undefined).
type dataEnvelope struct {
	Topic    string  `json:"topic"`
	From     *string `json:"from,omitempty"`
	Message  *string `json:"message,omitempty"`
	Reaction *string `json:"reaction,omitempty"`
	Ts       string  `json:"ts"`
}

// dataCallback is the chat_message / reaction callback payload.
type dataCallback struct {
	Room     string `json:"room"`
	StreamID string `json:"streamId"`
	dataEnvelope
}

// SentData is the data-push response.
type SentData struct {
	Sent  bool   `json:"sent"`
	Room  string `json:"room"`
	Topic string `json:"topic"`
}

func featureGate(cfg *contracts.AppConfig, topic string) error {
	if cfg == nil {
		return nil
	}
	if topic == "chat" && !cfg.Features.Chat {
		return httpx.NotFound("chat is disabled for this app")
	}
	if topic == "reaction" && !cfg.Features.Reactions {
		return httpx.NotFound("reactions are disabled for this app")
	}
	return nil
}

// sendData pushes the payload (or the default envelope) to room.
func (m *Module) sendData(ctx context.Context, room string, b *validate.Body) (dataEnvelope, error) {
	env := dataEnvelope{
		Topic: b.String("topic"), From: b.StringPtr("from"), Message: b.StringPtr("message"),
		Reaction: b.StringPtr("reaction"), Ts: jsx.ISO(m.now()),
	}
	payload := b.StringPtr("payload")
	if payload == nil {
		s, _ := jsx.Stringify(env)
		payload = &s
	}
	topic := b.String("topic")
	err := m.svc.SendData(ctx, room, *payload, SendDataOptions{
		Topic: &topic, DestinationIdentities: b.Strings("destinationIdentities"), Reliable: b.Bool("reliable"),
	})
	return env, err
}

type streamDataIn struct {
	App     string `path:"app"`
	ID      string `path:"id"`
	RawBody []byte
}

func (m *Module) registerData(a huma.API) {
	huma.Register(a, *authz.Require(op("LiveKitController_sendData", http.MethodPost, "/apps/{app}/streams/{id}/data",
		"Send a server-side data message to a stream room (chat/reaction) and fire callbacks.", "livekit", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *streamDataIn) (*api.Out[api.Data[SentData]], error) {
			b, err := parseBody(in.RawBody, sendDataRules)
			if err != nil {
				return nil, err
			}
			cfg := m.appConfig(ctx, in.App)
			topic := b.String("topic")
			if err := featureGate(cfg, topic); err != nil {
				return nil, err
			}
			room := m.roomForStream(ctx, in.App, in.ID)
			env, err := m.sendData(ctx, room, b)
			if err != nil {
				return nil, err
			}
			if topic == "chat" || topic == "reaction" {
				if cb := get(m.opt.Callbacks); cb != nil {
					event := "reaction"
					if topic == "chat" {
						event = "chat_message"
					}
					_ = cb.Dispatch(ctx, in.App, event, dataCallback{Room: room, StreamID: in.ID, dataEnvelope: env})
				}
			}
			return api.JSON(api.Data[SentData]{Data: SentData{true, room, topic}}), nil
		})
}

// roomForStream resolves a stream id's room, falling back to treating the
// id as a room name.
func (m *Module) roomForStream(ctx context.Context, app, id string) string {
	if st := get(m.opt.Streams); st != nil {
		if room, err := st.StreamRoom(ctx, app, id); err == nil && room != "" {
			return room
		}
	}
	return m.resolveRoom(ctx, app, id)
}

// ---------------------------------------------------------------------------
// Rooms API (rooms.controller.ts): metadata, moderation, data push
// ---------------------------------------------------------------------------

type roomIn struct {
	App  string `path:"app"`
	Room string `path:"room"`
}

type participantIn struct {
	App      string `path:"app"`
	Room     string `path:"room"`
	Identity string `path:"identity"`
}

type participantBodyIn struct {
	App      string `path:"app"`
	Room     string `path:"room"`
	Identity string `path:"identity"`
	RawBody  []byte
}

// KickResult is DELETE .../participants/:identity.data.
type KickResult struct {
	Room     string `json:"room"`
	Identity string `json:"identity"`
	Removed  bool   `json:"removed"`
}

// MuteResult is POST .../mute.data.
type MuteResult struct {
	Room     string       `json:"room"`
	Identity string       `json:"identity"`
	Muted    bool         `json:"muted"`
	Tracks   []MutedTrack `json:"tracks"`
}

// SubscriptionsResult is POST .../subscriptions.data.
type SubscriptionsResult struct {
	Room      string   `json:"room"`
	Identity  string   `json:"identity"`
	TrackSids []string `json:"trackSids"`
	Subscribe bool     `json:"subscribe"`
}

type kickMeta struct {
	App      string `json:"app"`
	Room     string `json:"room"`
	Identity string `json:"identity"`
}

type muteMeta struct {
	App      string   `json:"app"`
	Room     string   `json:"room"`
	Identity string   `json:"identity"`
	Muted    bool     `json:"muted"`
	Tracks   []string `json:"tracks"`
}

var nonAlnum = regexp.MustCompile(`(?i)[^a-z0-9]+`)

// moderationAudit logs + appends a moderation entry (never fails).
func (m *Module) moderationAudit(ctx context.Context, action, room string, meta any, logMeta map[string]any) {
	m.logWrite("info", "livekit-moderation", action, logMeta)
	if m.audit != nil {
		m.audit.Record(ctx, audit.Event{
			Action: "moderation." + nonAlnum.ReplaceAllString(action, "_"), ActorType: audit.ActorSystem,
			TargetType: audit.Str("room"), TargetID: audit.Str(room), Meta: meta,
		})
	}
}

func (m *Module) registerRooms(a huma.API) {
	huma.Register(a, *authz.Require(op("RoomsController_listRooms", http.MethodGet, "/apps/{app}/rooms",
		"List the app's live rooms (name, participants, metadata).", "rooms", 0), "stream", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[api.Data[[]RoomInfo]], error) {
			prefix := prefixOf(m.appConfig(ctx, in.App), in.App)
			rooms, err := m.svc.ListRoomsDetailed(ctx, nil)
			if err != nil {
				return nil, err
			}
			data := []RoomInfo{}
			for _, r := range rooms {
				if roomBelongsToPrefix(r.Name, prefix) {
					data = append(data, r)
				}
			}
			return api.JSON(api.Data[[]RoomInfo]{Data: data}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_getRoom", http.MethodGet, "/apps/{app}/rooms/{room}",
		"Get one live room (with its metadata).", "rooms", 0), "stream", "read"),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Data[RoomInfo]], error) {
			room := m.resolveRoom(ctx, in.App, in.Room)
			info, err := m.svc.GetRoom(ctx, room)
			if err != nil {
				return nil, err
			}
			if info == nil {
				return nil, httpx.NotFound("room '" + room + "' is not live")
			}
			return api.JSON(api.Data[RoomInfo]{Data: *info}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_updateRoomMetadata", http.MethodPatch, "/apps/{app}/rooms/{room}/metadata",
		"Set the room's live metadata (clients receive roomMetadataChanged).", "rooms", 0), "stream", "write"),
		func(ctx context.Context, in *roomBodyIn) (*api.Out[api.Data[RoomInfo]], error) {
			b, err := parseBody(in.RawBody, func(b *validate.Body) { b.Field("metadata").MaxLength(10_000).IsString() })
			if err != nil {
				return nil, err
			}
			info, err := m.svc.UpdateRoomMetadata(ctx, m.resolveRoom(ctx, in.App, in.Room), b.String("metadata"))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[RoomInfo]{Data: info}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_listParticipants", http.MethodGet, "/apps/{app}/rooms/{room}/participants",
		"List the room's participants with their published tracks (sids) — feeds the moderation actions.", "rooms", 0), "stream", "read"),
		func(ctx context.Context, in *roomIn) (*api.Out[api.Data[[]ParticipantDetail]], error) {
			data, err := m.svc.ListParticipantsDetailed(ctx, m.resolveRoom(ctx, in.App, in.Room))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[[]ParticipantDetail]{Data: data}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_kickParticipant", http.MethodDelete, "/apps/{app}/rooms/{room}/participants/{identity}",
		"Kick a participant out of the room (removeParticipant).", "rooms", 0), "stream", "write"),
		func(ctx context.Context, in *participantIn) (*api.Out[api.Data[KickResult]], error) {
			room := m.resolveRoom(ctx, in.App, in.Room)
			if err := m.svc.RemoveParticipant(ctx, room, in.Identity); err != nil {
				return nil, err
			}
			m.moderationAudit(ctx, "participant kicked", room, kickMeta{in.App, room, in.Identity},
				map[string]any{"app": in.App, "room": room, "identity": in.Identity})
			return api.JSON(api.Data[KickResult]{Data: KickResult{room, in.Identity, true}}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_muteParticipant", http.MethodPost, "/apps/{app}/rooms/{room}/participants/{identity}/mute",
		"Server-side mute/unmute of a participant's published track(s) (mutePublishedTrack). Pass trackSid, or kind=audio|video|all.", "rooms", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *participantBodyIn) (*api.Out[api.Data[MuteResult]], error) {
			b, err := parseBody(in.RawBody, func(b *validate.Body) {
				optStr(b, "trackSid", 120)
				b.Optional("kind").IsIn("audio", "video", "all")
				optBool(b, "muted")
			})
			if err != nil {
				return nil, err
			}
			res, err := m.MuteParticipant(ctx, in.App, in.Room, in.Identity, b.StringPtr("trackSid"), b.String("kind"), boolOr(b.Bool("muted"), true))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[MuteResult]{Data: *res}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_updateParticipant", http.MethodPatch, "/apps/{app}/rooms/{room}/participants/{identity}",
		"Update a participant's metadata / name / permissions (updateParticipant). Clients receive participantMetadataChanged.", "rooms", 0), "stream", "write"),
		func(ctx context.Context, in *participantBodyIn) (*api.Out[api.Data[ParticipantDetail]], error) {
			b, err := parseBody(in.RawBody, func(b *validate.Body) {
				optStr(b, "metadata", 10_000)
				optStr(b, "name", 120)
				optBool(b, "canPublish", "canSubscribe", "canPublishData")
			})
			if err != nil {
				return nil, err
			}
			room := m.resolveRoom(ctx, in.App, in.Room)
			opts := UpdateParticipantOptions{Metadata: b.StringPtr("metadata"), Name: b.StringPtr("name")}
			cp, cs, cd := b.Bool("canPublish"), b.Bool("canSubscribe"), b.Bool("canPublishData")
			if cp != nil || cs != nil || cd != nil {
				// LiveKit applies permissions atomically: merge over the current
				// grant (LiveKit hiccup → {} so the overrides form the set).
				perm := &PermissionPatch{}
				if p, err := m.svc.GetParticipant(ctx, room, in.Identity); err == nil {
					c := p.Permission
					perm = &PermissionPatch{&c.CanPublish, &c.CanSubscribe, &c.CanPublishData, &c.Hidden}
				}
				if cp != nil {
					perm.CanPublish = cp
				}
				if cs != nil {
					perm.CanSubscribe = cs
				}
				if cd != nil {
					perm.CanPublishData = cd
				}
				opts.Permission = perm
			}
			data, err := m.svc.UpdateParticipant(ctx, room, in.Identity, opts)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[ParticipantDetail]{Data: data}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_updateSubscriptions", http.MethodPost, "/apps/{app}/rooms/{room}/participants/{identity}/subscriptions",
		"Force-subscribe / force-unsubscribe a participant to specific tracks (updateSubscriptions).", "rooms", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *participantBodyIn) (*api.Out[api.Data[SubscriptionsResult]], error) {
			b, err := parseBody(in.RawBody, func(b *validate.Body) {
				r := b.Field("trackSids").EachIsString()
				arr, isArr := b.Raw("trackSids").([]any)
				r.Check(isArr && len(arr) <= 100, "trackSids must contain no more than 100 elements")
				r.IsArray()
				b.Field("subscribe").IsBoolean()
			})
			if err != nil {
				return nil, err
			}
			room := m.resolveRoom(ctx, in.App, in.Room)
			sids, sub := b.Strings("trackSids"), boolOr(b.Bool("subscribe"), false)
			if err := m.svc.UpdateSubscriptions(ctx, room, in.Identity, sids, sub); err != nil {
				return nil, err
			}
			return api.JSON(api.Data[SubscriptionsResult]{Data: SubscriptionsResult{room, in.Identity, sids, sub}}), nil
		})

	huma.Register(a, *authz.Require(op("RoomsController_sendData", http.MethodPost, "/apps/{app}/rooms/{room}/data",
		"Push a server-side data message to every subscriber of the room over LiveKit data channels (RoomServiceClient.sendData).", "rooms", http.StatusCreated), "stream", "write"),
		func(ctx context.Context, in *roomBodyIn) (*api.Out[api.Data[SentData]], error) {
			b, err := parseBody(in.RawBody, sendDataRules)
			if err != nil {
				return nil, err
			}
			cfg := m.appConfig(ctx, in.App)
			if err := featureGate(cfg, b.String("topic")); err != nil {
				return nil, err
			}
			room := namespaceRoom(prefixOf(cfg, in.App), in.Room)
			if _, err := m.sendData(ctx, room, b); err != nil {
				return nil, err
			}
			return api.JSON(api.Data[SentData]{Data: SentData{true, room, b.String("topic")}}), nil
		})
}

// MuteParticipant mutes trackSid, or every track of kind (audio|video|all).
func (m *Module) MuteParticipant(ctx context.Context, app, roomParam, identity string, trackSid *string, kind string, muted bool) (*MuteResult, error) {
	room := m.resolveRoom(ctx, app, roomParam)
	var sids []string
	if trackSid != nil && *trackSid != "" {
		sids = []string{*trackSid}
	} else {
		p, err := m.svc.GetParticipant(ctx, room, identity)
		if err != nil {
			return nil, err
		}
		if kind == "" {
			kind = "all"
		}
		for _, t := range p.Tracks {
			if kind == "all" || t.Type == kind {
				sids = append(sids, t.Sid)
			}
		}
		if len(sids) == 0 {
			what := ""
			if kind != "all" {
				what = kind + " "
			}
			verb := "unmute"
			if muted {
				verb = "mute"
			}
			return nil, httpx.NotFound("participant '" + identity + "' has no " + what + "tracks to " + verb)
		}
	}
	results := []MutedTrack{}
	tracks := []string{}
	for _, sid := range sids {
		r, err := m.svc.MutePublishedTrack(ctx, room, identity, sid, muted)
		if err != nil {
			return nil, err
		}
		results = append(results, r)
		tracks = append(tracks, r.TrackSid)
	}
	m.moderationAudit(ctx, "participant track(s) muted", room, muteMeta{app, room, identity, muted, tracks},
		map[string]any{"app": app, "room": room, "identity": identity, "muted": muted, "tracks": tracks})
	return &MuteResult{room, identity, muted, results}, nil
}
