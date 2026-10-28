package livecontrol

import (
	"context"
	"crypto/rand"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/livekit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/plugins"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streams"
)

// Port of live-control.service.ts. Side effects (server-side audio mute,
// data-channel push, callbacks event) are best-effort and never break a
// transition — the state machine is the source of truth.

const (
	// PluginID is the console plugin whose config carries the static defaults.
	PluginID = "live-control"
	// Topic is the LiveKit data topic the overlay listens on.
	Topic       = "live-control"
	assetURLTTL = 3600
)

// Streams is the streams-service surface used.
type Streams interface {
	List(ctx context.Context, app string) ([]streams.StreamRecord, error)
	Get(ctx context.Context, app, streamID string) (*streams.StreamRecord, error)
}

// LiveKit is the LiveKit surface used (mute + data push).
type LiveKit interface {
	ListParticipantsDetailed(ctx context.Context, room string) ([]livekit.ParticipantDetail, error)
	MutePublishedTrack(ctx context.Context, room, identity, trackSid string, muted bool) (livekit.MutedTrack, error)
	SendData(ctx context.Context, room, payload string, o livekit.SendDataOptions) error
}

// S3 is the storage surface used.
type S3 interface {
	UploadBuffer(ctx context.Context, cfg contracts.S3Config, body []byte, key, contentType string) (*contracts.S3UploadResult, error)
	PresignGet(ctx context.Context, cfg contracts.S3Config, key string, expiresInSeconds float64, opts *contracts.S3PresignOptions) (string, error)
	Delete(ctx context.Context, cfg contracts.S3Config, key string) error
}

// Deps wires the service; the func getters are resolved at call time and
// may return nil (LiveKit / Callbacks / Streams optional).
type Deps struct {
	Apps      contracts.AppsService
	Installs  *plugins.Repo
	Store     *Store
	S3        S3
	Logs      plugins.LogWriter
	Streams   func() Streams
	LiveKit   func() LiveKit
	Callbacks func() plugins.Dispatcher
}

// Service is LiveControlService.
type Service struct {
	d   Deps
	now func() time.Time
	// async runs a best-effort side effect (tests run it inline).
	async func(func())
}

// New builds the service.
func New(d Deps) *Service {
	return &Service{d: d, now: time.Now, async: func(f func()) { go f() }}
}

// Static are the static per-app defaults (console plugin config).
type LCStatic struct {
	DefaultMode         string  `json:"defaultMode"`
	DefaultCardTitle    string  `json:"defaultCardTitle"`
	DefaultCardText     string  `json:"defaultCardText"`
	DefaultCardColor    string  `json:"defaultCardColor"`
	MuteAudioServerSide bool    `json:"muteAudioServerSide"`
	PollSeconds         float64 `json:"pollSeconds"`
}

// SettingsView is static + dynamic defaults.
type LCSettingsView struct {
	LCStatic
	DefaultPauseAssetID  *int64 `json:"defaultPauseAssetId"`
	DefaultFinishAssetID *int64 `json:"defaultFinishAssetId"`
}

// CoverView is a resolved cover + its signed asset URL.
type LCCoverView struct {
	LCCover
	AssetURL *string `json:"assetUrl"`
}

// ControlView is a stream's live-control state.
type LCControlView struct {
	StreamID string       `json:"streamId"`
	Room     *string      `json:"room"`
	State    string       `json:"state"`
	Since    *string      `json:"since"`
	Cover    *LCCoverView `json:"cover"`
}

// StreamItem is a live stream + its control state.
type LCStreamItem struct {
	StreamID    string        `json:"streamId"`
	Type        string        `json:"type"`
	Room        string        `json:"room"`
	Status      string        `json:"status"`
	StartedAt   string        `json:"startedAt"`
	Participant *string       `json:"participant"`
	Viewers     *int          `json:"viewers,omitempty"`
	Control     LCControlView `json:"control"`
}

// StreamList is GET streams.
type LCStreamList struct {
	Streams     []LCStreamItem `json:"streams"`
	GeneratedAt string         `json:"generatedAt"`
}

// AssetView is an asset + a signed preview URL.
type LCAssetView struct {
	LCAsset
	URL *string `json:"url"`
}

type defaults struct {
	AppDefaults
	static LCStatic
	appDir string
	config *contracts.AppConfig
}

func (s *Service) staticDefaults(ctx context.Context, app string) LCStatic {
	c := y.NewMap()
	if row, _ := s.d.Installs.Get(ctx, app, PluginID); row != nil {
		c = row.Config
	}
	st := LCStatic{DefaultMode: "text", DefaultCardTitle: "We will be right back", DefaultCardText: "The live stream is paused.",
		DefaultCardColor: "#0b0b0f", MuteAudioServerSide: c.Get("muteAudioServerSide") != false, PollSeconds: 5}
	if m, ok := c.Get("defaultMode").(string); ok && (m == "image" || m == "video" || m == "text") {
		st.DefaultMode = m
	}
	strCfg := func(k string, dst *string) {
		if v, ok := c.Get(k).(string); ok && y.Trim(v) != "" {
			*dst = v
		}
	}
	strCfg("defaultCardTitle", &st.DefaultCardTitle)
	strCfg("defaultCardText", &st.DefaultCardText)
	strCfg("defaultCardColor", &st.DefaultCardColor)
	n := math.NaN()
	switch v := c.Get("pollSeconds").(type) {
	case float64:
		n = v
	case string:
		n = y.StringToNumber(v)
	}
	if !math.IsNaN(n) && !math.IsInf(n, 0) && n > 0 {
		st.PollSeconds = n
	}
	return st
}

// intOrNull: a positive integer from a KV string, else nil.
func intOrNull(v string, ok bool) *int64 {
	if !ok {
		return nil
	}
	n := y.StringToNumber(v)
	if n != math.Trunc(n) || n <= 0 || math.IsInf(n, 0) {
		return nil
	}
	i := int64(n)
	return &i
}

func (s *Service) appDefaults(ctx context.Context, app, appDir string) (defaults, error) {
	st := s.staticDefaults(ctx, app)
	kv, err := s.d.Store.Settings(ctx, app, appDir)
	if err != nil {
		return defaults{}, err
	}
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		cfg = &contracts.AppConfig{}
	}
	p, pok := kv["defaultPauseAssetId"]
	f, fok := kv["defaultFinishAssetId"]
	return defaults{
		AppDefaults: AppDefaults{DefaultMode: st.DefaultMode, DefaultCardTitle: st.DefaultCardTitle, DefaultCardText: st.DefaultCardText,
			DefaultCardColor: st.DefaultCardColor, DefaultPauseAssetID: intOrNull(p, pok), DefaultFinishAssetID: intOrNull(f, fok)},
		static: st, appDir: appDir, config: cfg,
	}, nil
}

func (s *Service) streamsSvc() Streams {
	if s.d.Streams == nil {
		return nil
	}
	return s.d.Streams()
}

// ListStreams is the operator list.
func (s *Service) ListStreams(ctx context.Context, app string) (*LCStreamList, error) {
	appDir := s.d.Apps.AppDir(app)
	d, err := s.appDefaults(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	out := &LCStreamList{Streams: []LCStreamItem{}}
	if ss := s.streamsSvc(); ss != nil {
		rows, err := ss.List(ctx, app)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			st, err := s.d.Store.GetState(ctx, app, appDir, r.StreamID)
			if err != nil {
				return nil, err
			}
			room := r.Room
			out.Streams = append(out.Streams, LCStreamItem{StreamID: r.StreamID, Type: r.Type, Room: r.Room, Status: r.Status,
				StartedAt: r.StartedAt, Participant: r.Participant, Viewers: r.Viewers, Control: s.viewFor(ctx, app, r.StreamID, &room, st, d)})
		}
	}
	out.GeneratedAt = jsx.ISO(s.now())
	return out, nil
}

func (s *Service) streamRoom(ctx context.Context, app, streamID string) *string {
	ss := s.streamsSvc()
	if ss == nil {
		return nil
	}
	r, err := ss.Get(ctx, app, streamID)
	if err != nil || r == nil {
		return nil
	}
	room := r.Room
	return &room
}

// GetStream is one stream's control state (even if the stream row is gone).
func (s *Service) GetStream(ctx context.Context, app, streamID string) (*LCControlView, error) {
	appDir := s.d.Apps.AppDir(app)
	d, err := s.appDefaults(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	room := s.streamRoom(ctx, app, streamID)
	st, err := s.d.Store.GetState(ctx, app, appDir, streamID)
	if err != nil {
		return nil, err
	}
	if room == nil && st != nil {
		room = st.Room
	}
	v := s.viewFor(ctx, app, streamID, room, st, d)
	return &v, nil
}

// PublicState is the anonymous overlay read (by stream id or room).
func (s *Service) PublicState(ctx context.Context, app, stream, room string) (*LCControlView, error) {
	appDir := s.d.Apps.AppDir(app)
	d, err := s.appDefaults(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	var selRoom *string
	if room != "" {
		selRoom = &room
	}
	id := s.resolveStreamID(ctx, app, stream, room)
	if id == "" {
		return &LCControlView{StreamID: "", Room: selRoom, State: "live"}, nil
	}
	st, err := s.d.Store.GetState(ctx, app, appDir, id)
	if err != nil {
		return nil, err
	}
	r := selRoom
	if st != nil && st.Room != nil {
		r = st.Room
	}
	v := s.viewFor(ctx, app, id, r, st, d)
	return &v, nil
}

func (s *Service) resolveStreamID(ctx context.Context, app, stream, room string) string {
	if t := y.Trim(stream); t != "" {
		return t
	}
	room = y.Trim(room)
	ss := s.streamsSvc()
	if room == "" || ss == nil {
		return ""
	}
	rows, err := ss.List(ctx, app)
	if err != nil {
		return ""
	}
	for _, r := range rows {
		if r.Room == room {
			return r.StreamID
		}
	}
	for _, r := range rows {
		if strings.HasSuffix(r.Room, "-"+room) || r.Room == room {
			return r.StreamID
		}
	}
	return ""
}

// Transition applies pause | resume | finish.
func (s *Service) Transition(ctx context.Context, app, streamID, op string, o Override) (*LCControlView, error) {
	appDir := s.d.Apps.AppDir(app)
	d, err := s.appDefaults(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	if o.SetAsset && o.AssetID != nil {
		a, err := s.d.Store.GetAsset(ctx, app, appDir, *o.AssetID)
		if err != nil {
			return nil, err
		}
		if a == nil {
			return nil, httpx.BadRequest(fmt.Sprintf("asset '%d' not found", *o.AssetID))
		}
	}
	target := OpTarget(op)
	room := s.streamRoom(ctx, app, streamID)
	prev, err := s.d.Store.GetState(ctx, app, appDir, streamID)
	if err != nil {
		return nil, err
	}
	if room == nil && prev != nil {
		room = prev.Room
	}
	row, err := s.d.Store.SetState(ctx, app, appDir, streamID, target, room, o)
	if err != nil {
		return nil, err
	}
	if d.static.MuteAudioServerSide {
		s.async(func() { s.setAudioMuted(app, room, target != "live") })
	}
	s.async(func() { s.pushState(app, room, streamID, target) })
	s.async(func() { s.emitEvent(app, op, streamID, room, target, o) })
	s.write("info", "live-control", fmt.Sprintf("stream '%s' → %s", streamID, target), transitionMeta{app, streamID, op})
	v := s.viewFor(ctx, app, streamID, room, row, d)
	return &v, nil
}

type transitionMeta struct {
	App    string `json:"app"`
	Stream string `json:"stream"`
	Op     string `json:"op"`
}

func (s *Service) write(level, source, msg string, meta any) {
	if s.d.Logs != nil {
		s.d.Logs.Write(level, source, msg, meta, nil)
	}
}

type warnMeta struct {
	App   string `json:"app"`
	Error string `json:"error"`
}

func (s *Service) warn(app, msg string, err error) {
	s.write("warn", "live-control", msg, warnMeta{app, err.Error()})
}

func (s *Service) livekit() LiveKit {
	if s.d.LiveKit == nil {
		return nil
	}
	return s.d.LiveKit()
}

func (s *Service) setAudioMuted(app string, room *string, muted bool) {
	lk := s.livekit()
	if lk == nil || room == nil || *room == "" {
		return
	}
	ctx := context.Background()
	parts, err := lk.ListParticipantsDetailed(ctx, *room)
	if err != nil {
		s.warn(app, "audio mute toggle failed", err)
		return
	}
	for _, p := range parts {
		for _, t := range p.Tracks {
			if t.Type == "audio" {
				_, _ = lk.MutePublishedTrack(ctx, *room, p.Identity, t.Sid, muted)
			}
		}
	}
}

type pushPayload struct {
	Type   string `json:"type"`
	App    string `json:"app"`
	Stream string `json:"stream"`
	State  string `json:"state"`
	At     string `json:"at"`
}

func (s *Service) pushState(app string, room *string, streamID, state string) {
	lk := s.livekit()
	if lk == nil || room == nil || *room == "" {
		return
	}
	payload, _ := jsx.Stringify(pushPayload{"live-control", app, streamID, state, jsx.ISO(s.now())})
	topic, reliable := Topic, true
	if err := lk.SendData(context.Background(), *room, payload, livekit.SendDataOptions{Topic: &topic, Reliable: &reliable}); err != nil {
		s.warn(app, "state push skipped", err)
	}
}

type eventPayload struct {
	Stream  string  `json:"stream"`
	Room    *string `json:"room"`
	State   string  `json:"state"`
	Mode    *string `json:"mode"`
	AssetID *int64  `json:"assetId"`
}

func (s *Service) emitEvent(app, op, streamID string, room *string, state string, o Override) {
	if s.d.Callbacks == nil || s.d.Callbacks() == nil {
		return
	}
	name := map[string]string{"pause": "livecontrol.paused", "finish": "livecontrol.finished"}[op]
	if name == "" {
		name = "livecontrol.resumed"
	}
	if err := s.d.Callbacks().Dispatch(context.Background(), app, name, eventPayload{streamID, room, state, o.Mode, o.AssetID}); err != nil {
		s.warn(app, "callbacks dispatch skipped", err)
	}
}

func (s *Service) viewFor(ctx context.Context, app, streamID string, room *string, st *StateRow, d defaults) LCControlView {
	state := "live"
	var row StateRow
	var since *string
	if st != nil {
		state, row, since = st.State, *st, &st.Since
	}
	v := LCControlView{StreamID: streamID, Room: room, State: state, Since: since}
	if c := ResolveCover(state, row, d.AppDefaults); c != nil {
		cv := &LCCoverView{LCCover: *c}
		if c.AssetID != nil {
			if a, _ := s.d.Store.GetAsset(ctx, app, d.appDir, *c.AssetID); a != nil {
				cv.AssetURL = s.signAsset(ctx, d.config, a.S3Key)
			}
		}
		v.Cover = cv
	}
	return v
}

func (s *Service) signAsset(ctx context.Context, cfg *contracts.AppConfig, key string) *string {
	if cfg == nil || cfg.S3.Bucket == "" {
		return nil
	}
	if p := cfg.S3.PublicURL; strings.TrimSpace(p) != "" {
		prefix := ""
		if cfg.S3.Prefix != "" {
			prefix = strings.TrimRight(cfg.S3.Prefix, "/") + "/"
		}
		u := strings.TrimRight(p, "/") + "/" + prefix + key
		return &u
	}
	u, err := s.d.S3.PresignGet(ctx, cfg.S3, key, assetURLTTL, nil)
	if err != nil {
		s.warn(cfg.Name, "presign failed", err)
		return nil
	}
	return &u
}

// ListAssets lists assets with signed preview URLs.
func (s *Service) ListAssets(ctx context.Context, app string) ([]LCAssetView, error) {
	appDir := s.d.Apps.AppDir(app)
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := s.d.Store.ListAssets(ctx, app, appDir)
	if err != nil {
		return nil, err
	}
	out := []LCAssetView{}
	for _, r := range rows {
		out = append(out, LCAssetView{LCAsset: r, URL: s.signAsset(ctx, cfg, r.S3Key)})
	}
	return out, nil
}

type storageError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	App     string `json:"app"`
}

func assertStorage(app string, cfg *contracts.AppConfig) error {
	if strings.TrimSpace(cfg.S3.Bucket) == "" {
		return &httpx.Error{Status: http.StatusConflict, Body: storageError{"storage_not_configured",
			fmt.Sprintf("app '%s' has no S3 storage bucket configured; cover assets cannot be uploaded", app), app}}
	}
	return nil
}

var (
	pathPrefix = regexp.MustCompile(`^.*[\\/]`)
	unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	edgeUnders = regexp.MustCompile(`^_+|_+$`)
)

func sanitizeName(name string) string {
	base := y.Trim(pathPrefix.ReplaceAllString(name, ""))
	safe := edgeUnders.ReplaceAllString(unsafeName.ReplaceAllString(base, "_"), "")
	if safe == "" {
		safe = "asset"
	}
	return jsx.UTF16Slice(safe, 100)
}

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Upload is one multipart file.
type Upload struct {
	Body     []byte
	Filename string
	MimeType string
}

type assetMeta struct {
	App     string `json:"app"`
	LCAsset int64  `json:"asset"`
}

// UploadAsset stores a cover asset in the app S3 and records it.
func (s *Service) UploadAsset(ctx context.Context, app string, f Upload, label *string) (*LCAssetView, error) {
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	if err := assertStorage(app, cfg); err != nil {
		return nil, err
	}
	appDir := s.d.Apps.AppDir(app)
	if len(f.Body) == 0 {
		return nil, httpx.BadRequest("empty upload (field name must be `file`)")
	}
	mt := strings.ToLower(f.MimeType)
	kind := ""
	switch {
	case strings.HasPrefix(mt, "video/"):
		kind = "video"
	case strings.HasPrefix(mt, "image/"):
		kind = "image"
	default:
		shown := mt
		if shown == "" {
			shown = "unknown"
		}
		return nil, httpx.BadRequest(fmt.Sprintf("unsupported asset type '%s' (image/* or video/* only)", shown))
	}
	name := f.Filename
	if name == "" {
		name = kind + ".bin"
	}
	safe := sanitizeName(name)
	key := "live-control/assets/" + uuid() + "-" + safe
	if _, err := s.d.S3.UploadBuffer(ctx, cfg.S3, f.Body, key, mt); err != nil {
		return nil, err
	}
	var lbl *string
	if label != nil && y.Trim(*label) != "" {
		l := jsx.UTF16Slice(y.Trim(*label), 200)
		lbl = &l
	}
	row, err := s.d.Store.AddAsset(ctx, app, appDir, LCAsset{Kind: kind, S3Key: key, Filename: safe, ContentType: mt, SizeBytes: int64(len(f.Body)), Label: lbl})
	if err != nil {
		return nil, err
	}
	s.write("info", "live-control", fmt.Sprintf("cover asset uploaded (%s)", kind), assetMeta{app, row.ID})
	return &LCAssetView{LCAsset: *row, URL: s.signAsset(ctx, cfg, key)}, nil
}

// Removed is {removed: true}.
type LCRemoved struct {
	Removed bool `json:"removed"`
}

// DeleteAsset deletes the row and (best-effort) the S3 object.
func (s *Service) DeleteAsset(ctx context.Context, app string, id int64) (*LCRemoved, error) {
	row, err := s.d.Store.RemoveAsset(ctx, app, s.d.Apps.AppDir(app), id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, httpx.NotFound(fmt.Sprintf("asset '%d' not found", id))
	}
	if cfg, err := s.d.Apps.GetConfig(ctx, app); err == nil && cfg.S3.Bucket != "" {
		if err := s.d.S3.Delete(ctx, cfg.S3, row.S3Key); err != nil {
			s.warn(app, "S3 asset delete failed", err)
		}
	}
	return &LCRemoved{true}, nil
}

// URLView is {url}.
type LCURLView struct {
	URL string `json:"url"`
}

// AssetURL is a fresh signed URL for one asset.
func (s *Service) AssetURL(ctx context.Context, app string, id int64) (*LCURLView, error) {
	row, err := s.d.Store.GetAsset(ctx, app, s.d.Apps.AppDir(app), id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, httpx.NotFound(fmt.Sprintf("asset '%d' not found", id))
	}
	cfg, err := s.d.Apps.GetConfig(ctx, app)
	if err != nil {
		return nil, err
	}
	if err := assertStorage(app, cfg); err != nil {
		return nil, err
	}
	u := ""
	if p := s.signAsset(ctx, cfg, row.S3Key); p != nil {
		u = *p
	}
	return &LCURLView{u}, nil
}

// GetSettings is static + dynamic defaults.
func (s *Service) GetSettings(ctx context.Context, app string) (*LCSettingsView, error) {
	kv, err := s.d.Store.Settings(ctx, app, s.d.Apps.AppDir(app))
	if err != nil {
		return nil, err
	}
	p, pok := kv["defaultPauseAssetId"]
	f, fok := kv["defaultFinishAssetId"]
	return &LCSettingsView{LCStatic: s.staticDefaults(ctx, app), DefaultPauseAssetID: intOrNull(p, pok), DefaultFinishAssetID: intOrNull(f, fok)}, nil
}

// SettingsPatch: Set* marks a present key; a nil value clears it.
type SettingsPatch struct {
	Pause, Finish       *int64
	SetPause, SetFinish bool
}

// UpdateSettings writes the default-asset choices (ids must exist).
func (s *Service) UpdateSettings(ctx context.Context, app string, p SettingsPatch) (*LCSettingsView, error) {
	appDir := s.d.Apps.AppDir(app)
	for _, e := range []struct {
		key string
		set bool
		v   *int64
	}{{"defaultPauseAssetId", p.SetPause, p.Pause}, {"defaultFinishAssetId", p.SetFinish, p.Finish}} {
		if !e.set {
			continue
		}
		if e.v == nil {
			if err := s.d.Store.SetSetting(ctx, app, appDir, e.key, nil); err != nil {
				return nil, err
			}
			continue
		}
		a, err := s.d.Store.GetAsset(ctx, app, appDir, *e.v)
		if err != nil {
			return nil, err
		}
		if a == nil {
			return nil, httpx.BadRequest(fmt.Sprintf("asset '%d' not found", *e.v))
		}
		str := strconv.FormatInt(*e.v, 10)
		if err := s.d.Store.SetSetting(ctx, app, appDir, e.key, &str); err != nil {
			return nil, err
		}
	}
	return s.GetSettings(ctx, app)
}
