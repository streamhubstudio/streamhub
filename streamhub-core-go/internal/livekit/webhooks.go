package livekit

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of webhooks.controller.ts: the LiveKit webhook sink. Public route —
// authenticity is the LiveKit signature (Authorization: <jwt> whose sha256
// claim is base64(sha256(raw body))), verified over the exact raw bytes.
// Every downstream dispatch is guarded; the sink always acks 200.

// ReceiveWebhook verifies and decodes a raw LiveKit webhook body
// (WebhookReceiver.receive): the token must be signed with the API secret,
// issued by the API key, unexpired, and carry the body's sha256.
func (s *Service) ReceiveWebhook(body []byte, authHeader string) (*livekit.WebhookEvent, error) {
	if authHeader == "" {
		return nil, errors.New("authorization header is empty")
	}
	if s.cfg.LivekitAPISecret == "" {
		// The Node verifier would HMAC-check against an empty key; refuse
		// instead of accepting tokens anyone can forge.
		return nil, errors.New("api-key and api-secret must be set")
	}
	v, err := lkauth.ParseAPIToken(authHeader)
	if err != nil {
		return nil, err
	}
	if v.APIKey() != s.cfg.LivekitAPIKey {
		return nil, errors.New(`unexpected "iss" claim value`)
	}
	_, claims, err := v.Verify(s.cfg.LivekitAPISecret)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(body)
	if claims.Sha256 != base64.StdEncoding.EncodeToString(sum[:]) {
		return nil, errors.New("sha256 checksum of body does not match")
	}
	ev := &livekit.WebhookEvent{}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, ev); err != nil {
		return nil, err
	}
	return ev, nil
}

// webhookBody is the string Node verifies: the raw bytes of a JSON /
// webhook+json body, else JSON.stringify(req.body ?? {}) = "{}".
func webhookBody(r *http.Request, raw []byte) []byte {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if (mt == "application/json" || mt == "application/webhook+json") && len(raw) > 0 {
		return raw
	}
	return []byte("{}")
}

type webhookIn struct {
	Authorization string `header:"Authorization"`
	RawBody       []byte
}

type received struct {
	Received bool `json:"received"`
}

func (m *Module) registerWebhooks(a huma.API) {
	o := api.Public(&huma.Operation{
		OperationID: "WebhooksController_receive", Method: http.MethodPost, Path: api.Prefix + "/webhooks/livekit",
		Summary: "LiveKit webhook sink", Tags: []string{"webhooks"}, Hidden: true, DefaultStatus: http.StatusOK,
	})
	// Hidden ops are not in the OpenAPI paths Register() relaxes: keep the
	// body pointer to drop huma's "request body is required" (an empty
	// body verifies as "{}" and answers the signature 401).
	rb := &huma.RequestBody{}
	o.RequestBody = rb
	huma.Register(a, *o, func(ctx context.Context, in *webhookIn) (*api.Out[api.Data[received]], error) {
		if err := m.ReceiveHTTP(ctx, webhookBody(api.Request(ctx), in.RawBody), in.Authorization); err != nil {
			return nil, err
		}
		return api.JSON(api.Data[received]{Data: received{true}}), nil
	})
	rb.Required = false
}

// ReceiveHTTP verifies + routes one webhook (401 on a bad signature; any
// processing failure is logged and acked).
func (m *Module) ReceiveHTTP(ctx context.Context, body []byte, authHeader string) error {
	ev, err := m.svc.ReceiveWebhook(body, authHeader)
	if err != nil {
		m.whLog("warn", "webhook signature rejected: "+err.Error(), nil)
		return httpx.Unauthorized("invalid LiveKit webhook signature")
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				m.whLog("error", fmt.Sprintf("webhook handler error: %v", r), map[string]any{"event": ev.GetEvent()})
			}
		}()
		m.HandleEvent(ctx, ev)
	}()
	return nil
}

func (m *Module) whLog(level, msg string, meta map[string]any) {
	m.logWrite(level, "livekit-webhook", msg, meta)
}

// forwarded are the LiveKit events relayed verbatim to the app callback.
var forwarded = map[string]bool{
	"room_started": true, "room_finished": true, "participant_joined": true, "participant_left": true,
	"track_published": true, "track_unpublished": true, "ingress_started": true, "ingress_ended": true,
	"egress_started": true, "egress_updated": true, "egress_ended": true,
}

// HandleEvent is the business routing + raw forward of one event.
func (m *Module) HandleEvent(ctx context.Context, ev *livekit.WebhookEvent) {
	name := ev.GetEvent()
	roomName := ""
	if ev.Room != nil {
		roomName = ev.Room.GetName()
	} else if ev.IngressInfo != nil {
		roomName = ev.IngressInfo.GetRoomName()
	}
	app := m.resolveApp(ctx, roomName)
	meta := map[string]any{"room": roomName}
	if app != "" {
		meta["app"] = app
	}
	m.whLog("info", "event "+name, meta)

	switch name {
	case "egress_started", "egress_updated", "egress_ended":
		m.onEgress(ctx, ev, app)
	case "ingress_started", "ingress_updated":
		m.onIngressStarted(ctx, ev, app)
	case "ingress_ended":
		m.onIngressEnded(ctx, ev, app)
	case "track_published":
		m.onTrackPublished(ctx, ev, app)
	case "track_unpublished", "participant_left":
		m.onPublisherGone(ctx, ev, app)
	case "room_started":
		m.onRoomStarted(ctx, ev, app)
	}
	if app != "" && forwarded[name] {
		m.dispatch(ctx, app, name, buildEventData(roomName, ev))
	}
}

// EventData is the flat, JSON-safe callback payload of a forwarded event.
type EventData struct {
	Room        string            `json:"room"`
	Participant *eventParticipant `json:"participant,omitempty"`
	Track       *eventTrack       `json:"track,omitempty"`
	Ingress     *eventIngress     `json:"ingress,omitempty"`
	Egress      *eventEgress      `json:"egress,omitempty"`
	EventID     string            `json:"eventId,omitempty"`
	CreatedAt   int64             `json:"createdAt,omitempty"`
}

type eventParticipant struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	Sid      string `json:"sid"`
	Hidden   bool   `json:"hidden"`
}

// eventTrack: type/source are String(<enum number>) as in Node.
type eventTrack struct {
	Sid    string `json:"sid"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Muted  bool   `json:"muted"`
}

type eventIngress struct {
	IngressID string `json:"ingressId"`
	InputType string `json:"inputType"`
	RoomName  string `json:"roomName"`
}

type eventEgress struct {
	EgressID string `json:"egressId"`
	Status   string `json:"status"`
	RoomName string `json:"roomName"`
}

func buildEventData(room string, ev *livekit.WebhookEvent) EventData {
	d := EventData{Room: room, EventID: ev.GetId(), CreatedAt: ev.GetCreatedAt()}
	if p := ev.Participant; p != nil {
		d.Participant = &eventParticipant{p.GetIdentity(), p.GetName(), p.GetSid(), p.GetPermission().GetHidden()}
	}
	if t := ev.Track; t != nil {
		d.Track = &eventTrack{t.GetSid(), strconv.Itoa(int(t.GetType())), strconv.Itoa(int(t.GetSource())), t.GetMuted()}
	}
	if i := ev.IngressInfo; i != nil {
		d.Ingress = &eventIngress{i.GetIngressId(), strconv.Itoa(int(i.GetInputType())), i.GetRoomName()}
	}
	if e := ev.EgressInfo; e != nil {
		d.Egress = &eventEgress{e.GetEgressId(), strconv.Itoa(int(e.GetStatus())), e.GetRoomName()}
	}
	return d
}

// resolveApp maps a room to its app by the longest matching room prefix.
func (m *Module) resolveApp(ctx context.Context, room string) string {
	if room == "" || m.apps == nil {
		return ""
	}
	list, err := m.apps.List(ctx, nil)
	if err != nil {
		return ""
	}
	sort.SliceStable(list, func(i, j int) bool { return len(list[i].LivekitRoomPrefix) > len(list[j].LivekitRoomPrefix) })
	for _, a := range list {
		if room == a.LivekitRoomPrefix || strings.HasPrefix(room, a.LivekitRoomPrefix+"-") {
			return a.Name
		}
	}
	return ""
}

// streamKey is the canonical `${room}/${identity}` stream id.
func streamKey(room, identity string) string { return room + "/" + identity }

func ingressStreamType(t livekit.IngressInput) string {
	switch t {
	case livekit.IngressInput_WHIP_INPUT:
		return "whip"
	case livekit.IngressInput_URL_INPUT:
		return "rtsp"
	}
	return "rtmp"
}

func (m *Module) onEgress(ctx context.Context, ev *livekit.WebhookEvent, app string) {
	info := ev.EgressInfo
	if info == nil {
		return
	}
	status, ok := livekit.EgressStatus_name[int32(info.GetStatus())]
	if !ok {
		status = strconv.Itoa(int(info.GetStatus()))
	}
	if info.GetStatus() == livekit.EgressStatus_EGRESS_COMPLETE && app != "" {
		if net := get(m.opt.NetMetrics); net != nil {
			var bytes int64
			for _, f := range info.GetFileResults() {
				bytes += f.GetSize()
			}
			for _, s := range info.GetSegmentResults() {
				bytes += s.GetSize()
			}
			if bytes > 0 {
				net.RecordBytes(app, "out", "livekit-egress", bytes)
			}
		}
	}
	if rec := get(m.opt.Recording); rec == nil {
		m.whLog("warn", "recording service unavailable for egress event", nil)
	} else if err := rec.OnEgressEvent(ctx, info.GetEgressId(), status, ev); err != nil {
		m.whLog("error", "recording.onEgressEvent failed: "+err.Error(), map[string]any{"egressId": info.GetEgressId(), "status": status})
	}
	if rs := get(m.opt.Restream); rs != nil {
		if err := rs.OnEgressEvent(ctx, app, info.GetEgressId(), status); err != nil {
			m.whLog("error", "restream.onEgressEvent failed: "+err.Error(), map[string]any{"egressId": info.GetEgressId(), "status": status})
		}
	}
}

type unauthorizedPayload struct {
	StreamID string `json:"streamId"`
	Room     string `json:"room"`
	Reason   string `json:"reason"`
}

type ingressStartedPayload struct {
	StreamID  string `json:"streamId"`
	Room      string `json:"room"`
	Type      string `json:"type"`
	IngressID string `json:"ingressId"`
}

type ingressEndedPayload struct {
	StreamID  string `json:"streamId"`
	Room      string `json:"room"`
	IngressID string `json:"ingressId"`
}

type publisherPayload struct {
	StreamID    string `json:"streamId"`
	Room        string `json:"room"`
	Type        string `json:"type,omitempty"`
	Participant string `json:"participant"`
}

func (m *Module) onIngressStarted(ctx context.Context, ev *livekit.WebhookEvent, app string) {
	info := ev.IngressInfo
	if info == nil || app == "" {
		return
	}
	// RTMP password enforcement: an unvalidated passworded ingress is killed.
	if info.GetInputType() == livekit.IngressInput_RTMP_INPUT {
		ok, err := m.Auth.IsAuthorized(ctx, app, info.GetIngressId())
		if err == nil && !ok {
			if err = m.svc.DeleteIngress(ctx, info.GetIngressId()); err == nil {
				if err = m.Auth.Remove(ctx, app, info.GetIngressId()); err == nil {
					m.whLog("warn", "terminated unauthorized RTMP ingress (bad/missing password)",
						map[string]any{"ingressId": info.GetIngressId(), "room": info.GetRoomName(), "app": app})
					m.dispatch(ctx, app, "stream_ended", unauthorizedPayload{info.GetIngressId(), info.GetRoomName(), "unauthorized_rtmp_password"})
					return
				}
			}
		}
		if err != nil {
			m.whLog("error", "ingress auth enforcement failed: "+jsErrorString(err), map[string]any{"ingressId": info.GetIngressId()})
		}
	}
	typ := ingressStreamType(info.GetInputType())
	identity := info.GetParticipantIdentity()
	sid := info.GetIngressId()
	if identity != "" {
		sid = streamKey(info.GetRoomName(), identity)
		m.upsertStream(ctx, app, sid, typ, info.GetRoomName(), identity)
	}
	m.dispatch(ctx, app, "stream_started", ingressStartedPayload{sid, info.GetRoomName(), typ, info.GetIngressId()})
}

// jsErrorString is String(err) for an Error: "Error: <message>" (a Nest
// HttpException's name is its class, e.g. ServiceUnavailableException).
func jsErrorString(err error) string {
	if he, ok := errorsAs(err); ok && he.Status == http.StatusServiceUnavailable {
		return "ServiceUnavailableException: " + err.Error()
	}
	return "Error: " + err.Error()
}

func (m *Module) onIngressEnded(ctx context.Context, ev *livekit.WebhookEvent, app string) {
	info := ev.IngressInfo
	if info == nil || app == "" {
		return
	}
	sid := info.GetIngressId()
	if id := info.GetParticipantIdentity(); id != "" {
		sid = streamKey(info.GetRoomName(), id)
	}
	m.dispatch(ctx, app, "stream_ended", ingressEndedPayload{sid, info.GetRoomName(), info.GetIngressId()})
}

func eventRoom(ev *livekit.WebhookEvent) string {
	if ev.Room != nil {
		return ev.Room.GetName()
	}
	return ""
}

func (m *Module) onTrackPublished(ctx context.Context, ev *livekit.WebhookEvent, app string) {
	p := ev.Participant
	if p == nil || app == "" || p.GetPermission().GetHidden() {
		return
	}
	room := eventRoom(ev)
	sid := streamKey(room, p.GetIdentity())
	typ := "webrtc"
	if p.GetKind() == livekit.ParticipantInfo_INGRESS {
		typ = "rtmp"
	}
	m.upsertStream(ctx, app, sid, typ, room, p.GetIdentity())
	m.dispatch(ctx, app, "stream_started", publisherPayload{sid, room, typ, p.GetIdentity()})
}

// onPublisherGone handles track_unpublished and participant_left.
func (m *Module) onPublisherGone(ctx context.Context, ev *livekit.WebhookEvent, app string) {
	p := ev.Participant
	if p == nil || app == "" || p.GetPermission().GetHidden() {
		return
	}
	room := eventRoom(ev)
	sid := streamKey(room, p.GetIdentity())
	m.endStream(ctx, app, sid)
	m.dispatch(ctx, app, "stream_ended", publisherPayload{StreamID: sid, Room: room, Participant: p.GetIdentity()})
}

func (m *Module) onRoomStarted(ctx context.Context, ev *livekit.WebhookEvent, app string) {
	room := eventRoom(ev)
	if app == "" || room == "" || !m.autoRecordEnabled(app) {
		return
	}
	rec := get(m.opt.Recording)
	if rec == nil {
		m.whLog("warn", "auto-record skipped: recording service unavailable", map[string]any{"app": app, "room": room})
		return
	}
	vodID, egressID, err := rec.Start(ctx, app, room)
	if err != nil {
		m.whLog("warn", "auto-record failed: "+err.Error(), map[string]any{"app": app, "room": room})
		return
	}
	m.whLog("info", "auto-record started on room_started", map[string]any{"app": app, "room": room, "vodId": vodID, "egressId": egressID})
}

// autoRecordEnabled reads features.auto_record raw from config.yaml (strict
// boolean true; anything else / any failure = off).
func (m *Module) autoRecordEnabled(app string) bool {
	if m.apps == nil {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(m.apps.AppDir(app), "config.yaml"))
	if err != nil {
		return false
	}
	doc, err := yamljs.Load(string(raw))
	if err != nil {
		return false
	}
	root, ok := doc.(*yamljs.Map)
	if !ok {
		return false
	}
	features, ok := root.Get("features").(*yamljs.Map)
	if !ok {
		return false
	}
	v, ok := features.Get("auto_record").(bool)
	return ok && v
}

func (m *Module) upsertStream(ctx context.Context, app, id, typ, room, participant string) {
	st := get(m.opt.Streams)
	if st == nil {
		return
	}
	if err := st.Upsert(ctx, app, id, typ, room, participant); err != nil {
		m.whLog("error", "streams.upsert failed: "+err.Error(), map[string]any{"app": app, "streamId": id})
	}
}

func (m *Module) endStream(ctx context.Context, app, id string) {
	st := get(m.opt.Streams)
	if st == nil {
		return
	}
	if err := st.End(ctx, app, id); err != nil {
		m.whLog("error", "streams.end failed: "+err.Error(), map[string]any{"app": app, "streamId": id})
	}
}

func (m *Module) dispatch(ctx context.Context, app, event string, payload any) {
	cb := get(m.opt.Callbacks)
	if cb == nil {
		return
	}
	if err := cb.Dispatch(ctx, app, event, payload); err != nil {
		m.whLog("error", "callbacks.dispatch failed: "+err.Error(), map[string]any{"app": app, "event": event})
	}
}
