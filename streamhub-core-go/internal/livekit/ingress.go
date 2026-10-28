package livekit

import (
	"context"
	"math"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/auth"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/validate"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// longEmptyTimeout is the fallback emptyTimeout of a pre-created persistent
// (24/7 linear) room: 24h.
const longEmptyTimeout = 86400

const (
	srtNeedsPassthrough = "inputType 'srt' requires mode 'passthrough' — the LiveKit transcode path has " +
		"no SRT input type (to pull a remote SRT source, use inputType 'url' with an srt:// url)"
	mpegtsNeedsPassthrough = "inputType 'mpegts' requires mode 'passthrough' — MPEG-TS/UDP multicast is a " +
		"remux-only PULL ingest (there is no LiveKit transcode input for it)"
)

func createIngressRules(b *validate.Body) {
	it := b.Field("inputType")
	t, _ := b.Raw("inputType").(string)
	mode, _ := b.Raw("mode").(string)
	it.Check(t != "mpegts" || mode == "passthrough", mpegtsNeedsPassthrough)
	it.Check(t != "srt" || mode == "passthrough", srtNeedsPassthrough)
	it.IsIn("rtmp", "whip", "url", "srt", "mpegts")
	b.Optional("mode").IsIn("transcode", "passthrough")
	b.Optional("room").Matches(roomPattern, roomPatternMessage).MaxLength(120).IsString()
	optStr(b, "participantIdentity", 120)
	optStr(b, "participantName", 120)
	optStr(b, "url", 500)
	optStr(b, "sources", 300)
	optStr(b, "localaddr", 45)
	b.Optional("fifoSize").Max(100_000_000).Min(1).IsInt()
	optBool(b, "overrunNonfatal", "enableTranscoding", "audioOnly", "backup")
}

// CreateIngressResult is the transcode-mode POST /apps/:app/ingress data.
type CreateIngressResult struct {
	IngressInfo
	RtmpURL          string `json:"rtmp_url,omitempty"`
	RtmpsURL         string `json:"rtmps_url,omitempty"`
	StreamKeySnake   string `json:"stream_key,omitempty"`
	StreamPassword   string `json:"stream_password,omitempty"`
	RequiresPassword bool   `json:"requires_password"`
	Role             string `json:"role,omitempty"`
	HasBackup        bool   `json:"hasBackup"`
	PrimaryStreamKey string `json:"primaryStreamKey,omitempty"`
	PrimaryRtmpURL   string `json:"primary_rtmp_url,omitempty"`
	PrimaryRtmpsURL  string `json:"primary_rtmps_url,omitempty"`
	backupFields
	BackupPassword string `json:"backup_stream_password,omitempty"`
	Adaptive       bool   `json:"adaptive"`
	PlayerURL      string `json:"player_url"`
	EmbedIframe    string `json:"embed_iframe"`
}

// backupFields are the paired-backup key fields of a primary.
type backupFields struct {
	BackupIngressID      string `json:"backupIngressId,omitempty"`
	BackupStreamKey      string `json:"backupStreamKey,omitempty"`
	BackupStreamKeySnake string `json:"backup_stream_key,omitempty"`
	BackupRtmpURL        string `json:"backup_rtmp_url,omitempty"`
	BackupRtmpsURL       string `json:"backup_rtmps_url,omitempty"`
}

// PassthroughCreateResult is the passthrough-mode POST /apps/:app/ingress data.
type PassthroughCreateResult struct {
	Mode           string `json:"mode"`
	IngressID      string `json:"ingressId"`
	App            string `json:"app"`
	Room           string `json:"room"`
	InputType      string `json:"inputType"`
	StreamKey      string `json:"streamKey"`
	StreamKeySnake string `json:"stream_key"`
	RtmpURL        string `json:"rtmp_url,omitempty"`
	SrtURL         string `json:"srt_url,omitempty"`
	SourceURL      string `json:"source_url,omitempty"`
	HlsURL         string `json:"hls_url"`
	PlayerURL      string `json:"player_url"`
	EmbedIframe    string `json:"embed_iframe"`
	Capabilities   any    `json:"capabilities"`
}

type ingressIDIn struct {
	App string `path:"app"`
	ID  string `path:"id"`
}

type ingressIDBodyIn struct {
	App     string `path:"app"`
	ID      string `path:"id"`
	RawBody []byte
}

// ValidateResult is POST ingress/:id/validate.data.
type ValidateResult struct {
	IngressID string `json:"ingressId"`
	Valid     bool   `json:"valid"`
}

// DeleteIngressResult is DELETE ingress/:id.data.
type DeleteIngressResult struct {
	IngressID       string `json:"ingressId"`
	Deleted         bool   `json:"deleted"`
	BackupIngressID string `json:"backupIngressId,omitempty"`
	Mode            string `json:"mode,omitempty"`
}

// IngressListPage is GET /apps/:app/ingress.
type IngressListPage struct {
	Data   []any `json:"data"`
	Total  int   `json:"total"`
	Limit  int64 `json:"limit"`
	Offset int64 `json:"offset"`
}

// IngressRow is one LiveKit row of the listing.
type IngressRow struct {
	IngressListItem
	Room             string  `json:"room"`
	StreamKeySnake   string  `json:"stream_key,omitempty"`
	RtmpURL          string  `json:"rtmp_url,omitempty"`
	RtmpsURL         string  `json:"rtmps_url,omitempty"`
	Viewers          *int64  `json:"viewers"`
	RequiresPassword bool    `json:"requires_password"`
	Role             string  `json:"role,omitempty"`
	PairedIngressID  *string `json:"pairedIngressId,omitempty"`
	backupFields
}

// IngressDetail is GET /apps/:app/ingress/:id.data.
type IngressDetail struct {
	IngressListItem
	Role            string  `json:"role,omitempty"`
	PairedIngressID *string `json:"pairedIngressId,omitempty"`
	backupFields
}

// passthroughRow is a passthrough ingress in the listing.
type passthroughRow struct {
	IngressID        string `json:"ingressId"`
	Mode             string `json:"mode"`
	Room             string `json:"room"`
	RoomName         string `json:"roomName"`
	StreamKeySnake   string `json:"stream_key"`
	StreamKey        string `json:"streamKey"`
	InputType        string `json:"inputType,omitempty"`
	SourceURL        string `json:"source_url,omitempty"`
	SrtURL           string `json:"srt_url,omitempty"`
	RtmpURL          string `json:"rtmp_url,omitempty"`
	HlsURL           string `json:"hls_url"`
	PlayerURL        string `json:"player_url,omitempty"`
	Status           string `json:"status,omitempty"`
	PlaylistFresh    *bool  `json:"playlistFresh,omitempty"`
	RequiresPassword bool   `json:"requires_password"`
	Viewers          *int64 `json:"viewers"`
	Capabilities     any    `json:"capabilities"`
}

func (m *Module) registerIngress(a huma.API) {
	huma.Register(a, *authz.Require(op("LiveKitController_createIngress", http.MethodPost, "/apps/{app}/ingress",
		"Create an RTMP/WHIP/URL ingress for an app room (key + optional password, adaptive player).", "livekit", http.StatusCreated), "ingress", "create"),
		func(ctx context.Context, in *appBodyIn) (*api.Out[api.Data[any]], error) {
			b, err := parseBody(in.RawBody, createIngressRules)
			if err != nil {
				return nil, err
			}
			res, err := m.CreateIngressRoute(ctx, in.App, b, auth.From(ctx))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[any]{Data: res}), nil
		})

	huma.Register(a, *authz.Require(op("LiveKitController_validateIngress", http.MethodPost, "/apps/{app}/ingress/{id}/validate",
		"Validate an RTMP stream password for an ingress (SPEC §16). Marks it authorized.", "livekit", http.StatusCreated), "ingress", "write"),
		func(ctx context.Context, in *ingressIDBodyIn) (*api.Out[api.Data[ValidateResult]], error) {
			b, err := parseBody(in.RawBody, func(b *validate.Body) { b.Field("password").MaxLength(256).IsString() })
			if err != nil {
				return nil, err
			}
			row, err := m.Auth.Get(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			if row == nil {
				return nil, httpx.NotFound("ingress " + in.ID + " not found")
			}
			valid, err := m.Auth.Validate(ctx, in.App, in.ID, b.StringPtr("password"))
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[ValidateResult]{Data: ValidateResult{in.ID, valid}}), nil
		})

	huma.Register(a, *authz.Require(op("LiveKitController_listIngress", http.MethodGet, "/apps/{app}/ingress",
		"List the app ingresses, paginated ({ data, total, limit, offset }).", "livekit", 0), "ingress", "read"),
		func(ctx context.Context, in *appIn) (*api.Out[IngressListPage], error) {
			q, err := parseListQuery(api.Request(ctx).URL.Query())
			if err != nil {
				return nil, err
			}
			page, err := m.ListIngressRoute(ctx, in.App, q)
			if err != nil {
				return nil, err
			}
			return api.JSON(*page), nil
		})

	huma.Register(a, *authz.Require(op("LiveKitController_getIngress", http.MethodGet, "/apps/{app}/ingress/{id}",
		"Get a single ingress by id.", "livekit", 0), "ingress", "read"),
		func(ctx context.Context, in *ingressIDIn) (*api.Out[api.Data[IngressDetail]], error) {
			all, err := m.svc.ListIngress(ctx, "")
			if err != nil {
				return nil, err
			}
			for _, i := range all {
				if i.IngressID == in.ID {
					d := IngressDetail{IngressListItem: i}
					d.Role, d.PairedIngressID, d.backupFields = m.backupFields(ctx, in.App, in.ID, all)
					return api.JSON(api.Data[IngressDetail]{Data: d}), nil
				}
			}
			return nil, httpx.NotFound("ingress " + in.ID + " not found")
		})

	huma.Register(a, *authz.Require(op("LiveKitController_deleteIngress", http.MethodDelete, "/apps/{app}/ingress/{id}",
		"Delete an ingress by id. Deleting a PRIMARY also tears down its paired BACKUP (failover) ingress; deleting a backup just unlinks the pair.", "livekit", 0), "ingress", "delete"),
		func(ctx context.Context, in *ingressIDIn) (*api.Out[api.Data[DeleteIngressResult]], error) {
			res, err := m.DeleteIngressRoute(ctx, in.App, in.ID)
			if err != nil {
				return nil, err
			}
			return api.JSON(api.Data[DeleteIngressResult]{Data: *res}), nil
		})
}

// CreateIngressRoute is POST /apps/:app/ingress on a validated body.
func (m *Module) CreateIngressRoute(ctx context.Context, app string, b *validate.Body, p *auth.Principal) (any, error) {
	if err := m.quotas.EnforceConcurrentStreams(ctx, p); err != nil {
		return nil, err
	}
	cfg := m.appConfig(ctx, app)
	room := namespaceRoom(prefixOf(cfg, app), b.String("room"))
	inputType := b.String("inputType")

	mode := b.String("mode")
	if mode == "" {
		mode = "transcode"
		if cfg != nil && cfg.Rtmp.Passthrough {
			mode = "passthrough"
		}
	}
	if mode == "passthrough" {
		return m.createPassthrough(ctx, app, room, b)
	}
	if inputType == "srt" {
		return nil, httpx.BadRequest("inputType 'srt' requires mode 'passthrough' — the LiveKit transcode path has no SRT input type")
	}
	if inputType == "mpegts" {
		return nil, httpx.BadRequest("inputType 'mpegts' requires mode 'passthrough' — MPEG-TS/UDP is a remux-only PULL ingest")
	}

	adaptive := cfg != nil && cfg.Features.AdaptivePlayer
	enableTranscoding := b.Bool("enableTranscoding")
	if enableTranscoding == nil {
		v := adaptive || (cfg != nil && cfg.Rtmp.Transcode) || inputType != "whip"
		enableTranscoding = &v
	}

	// QW-1: pre-create a persistent room with a long emptyTimeout (best-effort).
	if cfg != nil && cfg.Features.Linear != nil && cfg.Features.Linear.PersistentRoom {
		timeout := cfg.Features.Linear.RoomEmptyTimeoutSeconds
		if timeout == 0 || math.IsNaN(timeout) {
			timeout = longEmptyTimeout
		}
		_, _ = m.svc.CreateRoom(ctx, room, uint32(timeout))
	}

	primaryIdentity := strings.TrimSpace(b.String("participantIdentity"))
	if primaryIdentity == "" {
		primaryIdentity = "ingress-" + app
	}
	simulcast := cfg != nil && cfg.Webrtc.Adaptive
	var maxHeight *float64
	if cfg != nil {
		h := float64(cfg.Webrtc.TranscodeMaxHeight)
		maxHeight = &h
	}
	info, err := m.svc.CreateIngress(ctx, CreateIngressInput{
		AppName: app, RoomName: room, InputType: inputType, ParticipantIdentity: primaryIdentity,
		ParticipantName: b.String("participantName"), URL: b.String("url"), EnableTranscoding: enableTranscoding,
		Simulcast: simulcast, MaxHeight: maxHeight, AudioOnly: boolOr(b.Bool("audioOnly"), false),
	})
	if err != nil {
		return nil, err
	}

	isRtmp := inputType == "rtmp"
	wantPassword := isRtmp && cfg != nil && cfg.Features.RtmpPassword
	var streamPassword string
	if isRtmp {
		if streamPassword, err = m.Auth.Register(ctx, info.IngressID, app, room, info.StreamKey, wantPassword); err != nil {
			return nil, err
		}
	}

	// Primary + backup (failover) keys — RTMP only, same room, distinct identity.
	wantBackup := isRtmp && boolOr(b.Bool("backup"), false)
	res := &CreateIngressResult{IngressInfo: info, RequiresPassword: wantPassword, HasBackup: wantBackup, Adaptive: adaptive}
	if wantBackup {
		var pname string
		if n := b.String("participantName"); n != "" {
			pname = n + " (backup)"
		}
		binfo, err := m.svc.CreateIngress(ctx, CreateIngressInput{
			AppName: app, RoomName: room, InputType: inputType, ParticipantIdentity: primaryIdentity + "-backup",
			ParticipantName: pname, EnableTranscoding: enableTranscoding, Simulcast: simulcast, MaxHeight: maxHeight,
		})
		if err != nil {
			return nil, err
		}
		bpw, err := m.Auth.Register(ctx, binfo.IngressID, app, room, binfo.StreamKey, wantPassword)
		if err != nil {
			return nil, err
		}
		if err := m.Backup.Link(ctx, app, info.IngressID, binfo.IngressID, room); err != nil {
			return nil, err
		}
		res.backupFields = backupFields{
			BackupIngressID: binfo.IngressID, BackupStreamKey: binfo.StreamKey, BackupStreamKeySnake: binfo.StreamKey,
			BackupRtmpURL: m.rtmpURL(binfo.StreamKey), BackupRtmpsURL: m.rtmpsURL(binfo.StreamKey),
		}
		res.BackupPassword = bpw
	}
	if isRtmp {
		res.RtmpURL, res.RtmpsURL = m.rtmpURL(info.StreamKey), m.rtmpsURL(info.StreamKey)
		res.Role, res.PrimaryStreamKey = "primary", info.StreamKey
		res.PrimaryRtmpURL, res.PrimaryRtmpsURL = res.RtmpURL, res.RtmpsURL
	}
	res.StreamKeySnake = info.StreamKey
	res.StreamPassword = streamPassword
	player := m.playerURLs(app, room)
	res.PlayerURL, res.EmbedIframe = player.PlayURL, player.Iframe
	return res, nil
}

// createPassthrough is the mode=passthrough branch (never calls LiveKit).
func (m *Module) createPassthrough(ctx context.Context, app, room string, b *validate.Body) (any, error) {
	inputType := b.String("inputType")
	if inputType != "rtmp" && inputType != "srt" && inputType != "mpegts" {
		return nil, httpx.BadRequest("passthrough ingress requires inputType=rtmp, inputType=srt or inputType=mpegts")
	}
	if boolOr(b.Bool("enableTranscoding"), false) {
		return nil, httpx.BadRequest("passthrough (remux) cannot be combined with transcoding — pick one mode")
	}
	if boolOr(b.Bool("backup"), false) {
		return nil, httpx.BadRequest("passthrough does not support a backup/failover key")
	}
	if boolOr(b.Bool("audioOnly"), false) {
		return nil, httpx.BadRequest("passthrough does not support audio-only (there is no transcode to drop video)")
	}
	pt := get(m.opt.Passthrough)
	if pt == nil {
		return nil, httpx.Unavailable("RTMP/SRT/MPEG-TS passthrough plane is unavailable")
	}
	var info *PassthroughInfo
	var err error
	switch inputType {
	case "mpegts":
		raw := yamljs.Trim(b.String("url"))
		if raw == "" {
			return nil, httpx.BadRequest("inputType 'mpegts' requires `url` — a udp://@GROUP:PORT source")
		}
		src, verr := pt.ParseMpegtsSource(MpegtsSource{
			URL: raw, Sources: b.StringPtr("sources"), Localaddr: b.StringPtr("localaddr"),
			FifoSize: b.Int("fifoSize"), OverrunNonfatal: b.Bool("overrunNonfatal"),
		})
		if verr != nil {
			return nil, httpx.BadRequest(verr.Error())
		}
		info, err = pt.Create(ctx, app, room, "mpegts", src)
	default:
		info, err = pt.Create(ctx, app, room, inputType, "")
	}
	if err != nil {
		return nil, err
	}
	player := m.playerURLs(app, room)
	it := info.InputType
	if it == "" {
		it = inputType
	}
	pu := info.PlayerURL
	if pu == "" {
		pu = player.PlayURL
	}
	return &PassthroughCreateResult{
		Mode: "passthrough", IngressID: info.IngressID, App: info.App, Room: info.Room, InputType: it,
		StreamKey: info.StreamKey, StreamKeySnake: info.StreamKey, RtmpURL: info.RtmpURL, SrtURL: info.SrtURL,
		SourceURL: info.SourceURL, HlsURL: info.HlsURL, PlayerURL: pu, EmbedIframe: player.Iframe, Capabilities: info.Capabilities,
	}, nil
}

// ListIngressQuery is the validated ListIngressDto (nil = absent).
type ListIngressQuery struct {
	Room, Q       *string
	Limit, Offset *float64
}

// parseListQuery validates ?room&q&limit&offset like ListIngressDto
// (@Type(() => Number) + @IsInt on the numbers).
func parseListQuery(v map[string][]string) (ListIngressQuery, error) {
	var q ListIngressQuery
	var msgs []string
	str := func(name string) *string {
		vals, ok := v[name]
		if !ok {
			return nil
		}
		if len(vals) != 1 {
			msgs = append(msgs, name+" must be shorter than or equal to 200 characters", name+" must be a string")
			return nil
		}
		s := vals[0]
		if jsUTF16Len(s) > 200 {
			msgs = append(msgs, name+" must be shorter than or equal to 200 characters")
		}
		return &s
	}
	num := func(name string) *float64 {
		vals, ok := v[name]
		if !ok {
			return nil
		}
		f := math.NaN()
		if len(vals) == 1 {
			f = yamljs.StringToNumber(vals[0])
		}
		if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
			msgs = append(msgs, name+" must be an integer number")
		}
		return &f
	}
	q.Room, q.Q, q.Limit, q.Offset = str("room"), str("q"), num("limit"), num("offset")
	if len(msgs) > 0 {
		return q, httpx.NestValidation(msgs)
	}
	return q, nil
}

func jsUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func clampInt(raw *float64, fallback, min, max float64) int64 {
	if raw == nil || math.IsNaN(*raw) {
		return int64(fallback)
	}
	return int64(math.Min(math.Max(math.Floor(*raw), min), max))
}

// ListIngressRoute is GET /apps/:app/ingress.
func (m *Module) ListIngressRoute(ctx context.Context, app string, q ListIngressQuery) (*IngressListPage, error) {
	prefix := prefixOf(m.appConfig(ctx, app), app)
	all, err := m.svc.ListIngress(ctx, "")
	if err != nil {
		return nil, err
	}
	var rows []IngressListItem
	for _, i := range all {
		if i.RoomName == prefix || strings.HasPrefix(i.RoomName, prefix+"-") {
			rows = append(rows, i)
		}
	}
	room := ""
	if q.Room != nil {
		room = yamljs.Trim(*q.Room)
	}
	if room != "" {
		var f []IngressListItem
		for _, i := range rows {
			if i.RoomName == room || i.RoomName == prefix+"-"+room {
				f = append(f, i)
			}
		}
		rows = f
	}
	needle := ""
	if q.Q != nil {
		needle = strings.ToLower(yamljs.Trim(*q.Q))
	}
	if needle != "" {
		var f []IngressListItem
		for _, i := range rows {
			if strings.Contains(strings.ToLower(i.IngressID), needle) || strings.Contains(strings.ToLower(i.Name), needle) ||
				strings.Contains(strings.ToLower(i.RoomName), needle) {
				f = append(f, i)
			}
		}
		rows = f
	}
	total := len(rows)
	limit := clampInt(q.Limit, 50, 1, 500)
	offset := clampInt(q.Offset, 0, 0, 9007199254740991)
	var page []IngressListItem
	if offset < int64(len(rows)) {
		end := offset + limit
		if end > int64(len(rows)) {
			end = int64(len(rows))
		}
		page = rows[offset:end]
	}

	// Viewers ≈ participants - 1 for the PAGE rooms only (best-effort).
	viewers := map[string]int64{}
	var pageRooms []string
	seen := map[string]bool{}
	for _, i := range page {
		if !seen[i.RoomName] {
			seen[i.RoomName] = true
			pageRooms = append(pageRooms, i.RoomName)
		}
	}
	if len(pageRooms) > 0 {
		if live, err := m.svc.ListRooms(ctx, pageRooms); err == nil {
			for _, r := range live {
				viewers[r.Name] = max(0, r.NumParticipants-1)
			}
		}
	}

	data := make([]any, 0, len(page))
	for _, i := range page {
		row := IngressRow{
			IngressListItem: i, Room: i.RoomName, StreamKeySnake: i.StreamKey,
			RtmpURL: m.rtmpURL(i.StreamKey), RtmpsURL: m.rtmpsURL(i.StreamKey),
		}
		if v, ok := viewers[i.RoomName]; ok {
			row.Viewers = &v
		}
		if a, err := m.Auth.Get(ctx, app, i.IngressID); err == nil && a != nil {
			row.RequiresPassword = a.RequiresPassword
		}
		row.Role, row.PairedIngressID, row.backupFields = m.backupFields(ctx, app, i.IngressID, all)
		data = append(data, row)
	}
	pt := m.passthroughRows(ctx, app, room, needle)
	if offset == 0 {
		data = append(data, pt...)
	}
	return &IngressListPage{Data: data, Total: total + len(pt), Limit: limit, Offset: offset}, nil
}

// passthroughRows are the passthrough ingresses of the listing (empty when
// the plane is unavailable).
func (m *Module) passthroughRows(ctx context.Context, app, room, needle string) []any {
	pt := get(m.opt.Passthrough)
	if pt == nil {
		return nil
	}
	rows, err := pt.List(ctx, app)
	if err != nil {
		return nil
	}
	var out []any
	for _, r := range rows {
		if room != "" && r.Room != room && !strings.HasSuffix(r.Room, "-"+room) {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(r.IngressID), needle) &&
			!strings.Contains(strings.ToLower(r.Room), needle) && !strings.Contains(strings.ToLower(r.StreamKey), needle) {
			continue
		}
		row := passthroughRow{
			IngressID: r.IngressID, Mode: "passthrough", Room: r.Room, RoomName: r.Room,
			StreamKeySnake: r.StreamKey, StreamKey: r.StreamKey, HlsURL: r.HlsURL, PlayerURL: r.PlayerURL,
			Status: r.Status, PlaylistFresh: r.PlaylistFresh, Capabilities: r.Capabilities,
		}
		switch r.InputType {
		case "mpegts":
			row.InputType, row.SourceURL = "mpegts", r.SourceURL
		case "srt":
			row.InputType, row.SrtURL = "srt", r.SrtURL
		default:
			row.RtmpURL = r.RtmpURL
		}
		out = append(out, row)
	}
	return out
}

// backupFields annotates a row with its failover role (never fails).
func (m *Module) backupFields(ctx context.Context, app, ingressID string, all []IngressListItem) (string, *string, backupFields) {
	info, err := m.Backup.GetRoleInfo(ctx, app, ingressID)
	if err != nil || info.Role == "" {
		return "", nil, backupFields{}
	}
	paired := info.PairedIngressID
	var bf backupFields
	if info.Role == "primary" && info.BackupIngressID != "" {
		for _, b := range all {
			if b.IngressID == info.BackupIngressID && b.StreamKey != "" {
				bf = backupFields{
					BackupIngressID: b.IngressID, BackupStreamKey: b.StreamKey, BackupStreamKeySnake: b.StreamKey,
					BackupRtmpURL: m.rtmpURL(b.StreamKey), BackupRtmpsURL: m.rtmpsURL(b.StreamKey),
				}
				break
			}
		}
	}
	return info.Role, &paired, bf
}

// DeleteIngressRoute is DELETE /apps/:app/ingress/:id.
func (m *Module) DeleteIngressRoute(ctx context.Context, app, id string) (*DeleteIngressResult, error) {
	if IsPassthroughID(id) {
		removed := false
		if pt := get(m.opt.Passthrough); pt != nil {
			removed = pt.Remove(ctx, app, id)
		}
		return &DeleteIngressResult{IngressID: id, Deleted: removed, Mode: "passthrough"}, nil
	}
	link, _ := m.Backup.GetLinkFor(ctx, app, id)
	if err := m.svc.DeleteIngress(ctx, id); err != nil {
		return nil, err
	}
	if err := m.Auth.Remove(ctx, app, id); err != nil {
		return nil, err
	}
	res := &DeleteIngressResult{IngressID: id, Deleted: true}
	if link != nil {
		if link.PrimaryIngressID == id {
			res.BackupIngressID = link.BackupIngressID
			_ = m.svc.DeleteIngress(ctx, link.BackupIngressID)
			_ = m.Auth.Remove(ctx, app, link.BackupIngressID)
		}
		_ = m.Backup.Remove(ctx, app, id)
	}
	return res, nil
}
