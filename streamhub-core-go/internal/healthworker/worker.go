package healthworker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/streamhealth"
)

// Port of main.js: the orchestration loop (every decision lives in the pure
// files next to this one).
//
// Environment (set by the plugin framework's stream-health spawn):
//
//	HEALTH_APP             app slug
//	HEALTH_HLS_DIR         <appDir>/hls (one sub-dir per room, index.m3u8)
//	HEALTH_DATA_DIR        <appDir>/stream-health (stream-health.db lives here)
//	HEALTH_CONFIG_JSON     app-level thresholds (install config; its
//	                       edge_hls_bases turns on the remote probes, remote.go)
//	HEALTH_FFPROBE / HEALTH_FFMPEG   binaries (default ffprobe / ffmpeg)
//	STREAMHUB_INGEST_URL   POST live-data (overview snapshot)
//	STREAMHUB_EVENTS_URL   POST domain events
//	STREAMHUB_INGEST_TOKEN per-start ingest token

const (
	tickInterval      = 2 * time.Second
	subprocessTimeout = 15 * time.Second
	subprocessMaxBuf  = 8 * 1024 * 1024
	tsReadCap         = 4 * 1024 * 1024
	postTimeout       = 5 * time.Second
)

// Options are the worker's inputs (tests inject them).
type Options struct {
	Getenv func(string) (string, bool)
	Stdout io.Writer
	Stderr io.Writer
	Client *http.Client
	Now    func() time.Time
	// Run executes a subprocess (nil = os/exec with the 15 s timeout).
	Run func(ctx context.Context, bin string, args []string) (stdout, stderr string)
}

type roomRT struct {
	origin        string    // the on-disk room (== the key for an origin probe)
	edge          *EdgeBase // nil = origin probe; set = remote probe via that edge
	state         *RoomState
	prev          *Playlist
	lastAdvanceMs *float64
	lastSampleMs  float64
	facts         *Facts
	snapshot      *snapshot
}

type worker struct {
	o                    Options
	app, hlsDir, dbFile  string
	ffprobe, ffmpeg      string
	eventsURL, ingestURL string
	token                string
	appConfig            *y.Map
	edges                []EdgeBase
	order                []string // rooms Map insertion order
	rooms                map[string]*roomRT
	events               chan []byte
	wg                   sync.WaitGroup
}

func (w *worker) log(msg string) { fmt.Fprintf(w.o.Stdout, "[health-worker] %s\n", msg) }

func (w *worker) nowMs() float64 { return float64(w.o.Now().UnixMilli()) }

// Run is `streamhub-core health-worker`; it returns the exit code.
func Run(ctx context.Context, o Options) int {
	if o.Getenv == nil {
		o.Getenv = os.LookupEnv
	}
	if o.Stdout == nil {
		o.Stdout = os.Stdout
	}
	if o.Stderr == nil {
		o.Stderr = os.Stderr
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: postTimeout}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Run == nil {
		o.Run = execRun
	}
	get := func(k, def string) string {
		if v, ok := o.Getenv(k); ok {
			return v
		}
		return def
	}
	cfgRaw, cfgSet := o.Getenv("HEALTH_CONFIG_JSON")
	w := &worker{o: o, app: get("HEALTH_APP", ""), hlsDir: get("HEALTH_HLS_DIR", ""),
		dbFile:  filepath.Join(get("HEALTH_DATA_DIR", "."), "stream-health.db"),
		ffprobe: get("HEALTH_FFPROBE", "ffprobe"), ffmpeg: get("HEALTH_FFMPEG", "ffmpeg"),
		eventsURL: get("STREAMHUB_EVENTS_URL", ""), ingestURL: get("STREAMHUB_INGEST_URL", ""),
		token: get("STREAMHUB_INGEST_TOKEN", ""), appConfig: ParseAppConfig(cfgRaw, cfgSet),
		rooms: map[string]*roomRT{}, events: make(chan []byte, 256)}
	w.edges = ParseEdgeBases(w.appConfig.Get(EdgeBasesKey))
	if w.app == "" || w.hlsDir == "" {
		fmt.Fprintln(o.Stderr, "[health-worker] HEALTH_APP / HEALTH_HLS_DIR missing — exiting")
		return 2
	}
	cfgJSON, _ := y.Stringify(w.appConfig)
	w.log(fmt.Sprintf("starting app=%s hls=%s db=%s config=%s", w.app, w.hlsDir, w.dbFile, cfgJSON))

	// Event POSTs are fire-and-forget (Node: `void postEvent`) but keep their
	// order: one sender drains them while the loop goes on.
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		for body := range w.events {
			w.post(context.Background(), w.eventsURL, body)
		}
	}()

	t := time.NewTicker(tickInterval)
	defer t.Stop()
	w.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			w.log("stopped")
			return 0
		case <-t.C:
			w.tick(ctx)
		}
	}
}

func execRun(ctx context.Context, bin string, args []string) (string, string) {
	ctx, cancel := context.WithTimeout(ctx, subprocessTimeout)
	defer cancel()
	var out, errb capBuffer
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdout, cmd.Stderr = &out, &errb
	_ = cmd.Run() // ffmpeg -f null exits 0; ffprobe errors often still print JSON
	return out.String(), errb.String()
}

// capBuffer keeps at most subprocessMaxBuf bytes (execFile maxBuffer).
type capBuffer struct{ bytes.Buffer }

func (b *capBuffer) Write(p []byte) (int, error) {
	if room := subprocessMaxBuf - b.Len(); room < len(p) {
		if room > 0 {
			b.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

func (w *worker) post(ctx context.Context, url string, body []byte) {
	if url == "" || w.token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, postTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-plugin-ingest-token", w.token)
	if res, err := w.o.Client.Do(req); err == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
}

// postEvent posts one event of the probe rt (logged under its key). A remote
// probe's event names the ORIGIN room — webhook consumers map rooms to
// streams — and carries the edge as data.via.
func (w *worker) postEvent(key string, rt *roomRT, e Event) {
	payload := e.Data
	if rt.edge != nil {
		payload = withVia(e.Data, rt.edge.Name)
	}
	data, _ := y.Stringify(payload)
	w.log(fmt.Sprintf("event %s room=%s %s", e.Event, key, data))
	body := y.NewMap()
	body.Set("event", e.Event)
	body.Set("room", rt.origin)
	body.Set("data", payload)
	js, _ := y.Stringify(body)
	select {
	case w.events <- []byte(js):
	default: // a wedged events endpoint must not stall the probe loop
	}
}

// readBounded reads a segment's head for the TS continuity analysis.
func readBounded(file string, limit int64) []byte {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit))
	if err != nil {
		return nil
	}
	return b
}

var remoteURI = regexp.MustCompile(`(?i)^[a-z]+://`)

// segmentPath resolves a playlist uri under its room dir; "" when unsafe.
func segmentPath(roomDir, uri string) string {
	if uri == "" || remoteURI.MatchString(uri) {
		return ""
	}
	clean := strings.SplitN(uri, "?", 2)[0]
	base, err := filepath.Abs(roomDir)
	if err != nil {
		return ""
	}
	resolved := filepath.Clean(clean)
	if !filepath.IsAbs(clean) {
		resolved = filepath.Join(base, clean)
	}
	if !strings.HasPrefix(resolved, base+string(filepath.Separator)) {
		return ""
	}
	return resolved
}

type snapshotFacts struct {
	VideoCodec  *string  `json:"videoCodec"`
	Width       *float64 `json:"width"`
	Height      *float64 `json:"height"`
	Fps         *float64 `json:"fps"`
	AudioCodec  *string  `json:"audioCodec"`
	SampleRate  *float64 `json:"sampleRate"`
	Channels    *float64 `json:"channels"`
	BitrateKbps *float64 `json:"bitrateKbps"`
	// AudioSource is what the core knows of the room's publishers (3.4):
	// "none" (no audio track published — the egress's injected silent AAC
	// is not a fault), "track", or absent when the core reported nothing.
	AudioSource string `json:"audioSource,omitempty"`
}

type snapshotMetrics struct {
	MeasuredKbps        *float64 `json:"measuredKbps"`
	SecondsSinceAdvance float64  `json:"secondsSinceAdvance"`
	MeanDb              *float64 `json:"meanDb"`
	DesyncMs            *float64 `json:"desyncMs"`
	CCErrors            float64  `json:"ccErrors"`
	DroppedSegments     float64  `json:"droppedSegments"`
	DiscontinuityTags   float64  `json:"discontinuityTags"`
	BaselineKbps        *float64 `json:"baselineKbps"`
}

type snapshot struct {
	Room    string          `json:"room"`
	Status  string          `json:"status"`
	Reasons []string        `json:"reasons"`
	Facts   *snapshotFacts  `json:"facts"`
	Metrics snapshotMetrics `json:"metrics"`
	TS      float64         `json:"ts"`
	// remote probes only (3.4; absent on origin probes): the on-disk room,
	// the edge name, the probed playlist URL and the last fetch failure.
	Origin string `json:"origin,omitempty"`
	Via    string `json:"via,omitempty"`
	URL    string `json:"url,omitempty"`
	Error  string `json:"error,omitempty"`
}

// probeRoom samples one probe (origin or remote); false = the stream ended
// (forget the room). audioSource is the core's word on the room's
// publishers ("" unknown, "none", "track").
func (w *worker) probeRoom(ctx context.Context, key string, rt *roomRT, t streamhealth.HealthThresholds, nowMs float64, audioSource string) bool {
	var diff Diff
	var infos []SegInfo
	newestPath, newestURI, fetchErr, playlistURL := "", "", "", ""
	if rt.edge == nil {
		roomDir := filepath.Join(w.hlsDir, rt.origin)
		text, err := os.ReadFile(filepath.Join(roomDir, "index.m3u8"))
		if err != nil {
			return false // playlist gone → stream ended
		}
		pl := ParsePlaylist(string(text))
		if pl.Endlist {
			return false // converted to VOD → done
		}
		diff = DiffPlaylist(rt.prev, pl)
		rt.prev = &pl
		// stat() the new segments for the measured delivery bitrate
		for _, seg := range diff.NewSegments {
			p := segmentPath(roomDir, seg.URI)
			if p == "" {
				continue
			}
			fi, err := os.Stat(p)
			if err != nil {
				continue // already rotated out
			}
			infos = append(infos, SegInfo{Bytes: float64(fi.Size()), Duration: seg.Duration})
			newestPath, newestURI = p, seg.URI
		}
	} else {
		playlistURL = rt.edge.PlaylistURL(w.app, rt.origin)
		if text, _, err := w.fetch(ctx, playlistURL, remotePlaylistCap); err != nil {
			fetchErr = err.Error() // no advance this cycle (prev kept: no false "dropped")
		} else {
			pl := ParsePlaylist(string(text))
			diff = DiffPlaylist(rt.prev, pl)
			rt.prev = &pl
			infos, newestPath, newestURI = w.remoteNewest(ctx, playlistURL, diff.NewSegments)
			if newestPath != "" {
				defer os.Remove(newestPath)
			}
		}
	}
	if rt.lastAdvanceMs == nil || diff.Advanced {
		v := nowMs
		rt.lastAdvanceMs = &v
	}
	sinceAdvance := (nowMs - *rt.lastAdvanceMs) / 1000
	kbps := MeasuredKbps(infos)

	// deep-probe only when a NEW segment landed
	var hasAudio *bool
	var meanDb, desyncMs *float64
	ccErrors := 0
	noAudioSource := audioSource == "none"
	if newestPath != "" {
		out, _ := w.o.Run(ctx, w.ffprobe, FfprobeArgs(newestPath))
		if facts := ParseFfprobe(out); facts != nil {
			a := facts.Audio != nil
			hasAudio, desyncMs, rt.facts = &a, facts.DesyncMs, facts
		}
		if IsTSSegment(newestURI) {
			if buf := readBounded(newestPath, tsReadCap); buf != nil {
				ccErrors = AnalyzeTSContinuity(buf).CCErrors
			}
		}
		// no audio source: the track (if any) is the egress's filler — skip the decode
		if hasAudio != nil && *hasAudio && !noAudioSource {
			_, stderr := w.o.Run(ctx, w.ffmpeg, VolumeArgs(newestPath))
			if v := ParseVolumeDetect(stderr); v != nil {
				m := v.MeanDb
				meanDb = &m
			}
		}
	}

	res := Evaluate(rt.state, Sample{SecondsSinceAdvance: sinceAdvance, DroppedSegments: diff.DroppedSegments,
		CCErrors: float64(ccErrors), NewDiscontinuityTags: float64(diff.NewDiscontinuityTags), HasAudioTrack: hasAudio,
		MeanDb: meanDb, DesyncMs: desyncMs, MeasuredKbps: kbps, NoAudioSource: noAudioSource}, t, nowMs)
	for _, e := range res.Events {
		w.postEvent(key, rt, e)
	}

	snap := &snapshot{Room: key, Status: res.Status, Reasons: res.Reasons, TS: nowMs, Metrics: snapshotMetrics{
		MeasuredKbps: kbps, SecondsSinceAdvance: jsRound(sinceAdvance), MeanDb: meanDb, DesyncMs: desyncMs,
		CCErrors: float64(ccErrors), DroppedSegments: diff.DroppedSegments, DiscontinuityTags: float64(diff.NewDiscontinuityTags),
		BaselineKbps: rt.state.BaselineKbps}}
	if f := rt.facts; f != nil {
		sf := &snapshotFacts{BitrateKbps: f.OverallBitrateKbps}
		if f.Video != nil {
			c := f.Video.Codec
			sf.VideoCodec, sf.Width, sf.Height, sf.Fps = &c, f.Video.Width, f.Video.Height, f.Video.Fps
		}
		if f.Audio != nil {
			c := f.Audio.Codec
			sf.AudioCodec, sf.SampleRate, sf.Channels = &c, f.Audio.SampleRate, f.Audio.Channels
		}
		snap.Facts = sf
	}
	if audioSource != "" {
		if snap.Facts == nil {
			snap.Facts = &snapshotFacts{}
		}
		snap.Facts.AudioSource = audioSource
	}
	if rt.edge != nil {
		snap.Origin, snap.Via, snap.URL, snap.Error = rt.origin, rt.edge.Name, playlistURL, fetchErr
	}
	rt.snapshot = snap
	return true
}

// listRooms is every room dir holding an index.m3u8 (name order, as libuv's
// scandir returns them to Node).
func (w *worker) listRooms() []string {
	entries, err := os.ReadDir(w.hlsDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(w.hlsDir, e.Name(), "index.m3u8")); err == nil {
			out = append(out, e.Name())
		}
	}
	return out
}

func (w *worker) forget(key string) {
	delete(w.rooms, key)
	for i, r := range w.order {
		if r == key {
			w.order = append(w.order[:i], w.order[i+1:]...)
			break
		}
	}
}

// forgetRoom drops an on-disk room and every remote probe of it.
func (w *worker) forgetRoom(room string) {
	for _, key := range append([]string{}, w.order...) {
		if rt := w.rooms[key]; rt != nil && rt.origin == room {
			w.forget(key)
		}
	}
}

// sample probes one key when its interval elapsed: probed = a probe ran,
// keep = false when the stream ended.
func (w *worker) sample(ctx context.Context, key, room string, edge *EdgeBase, t streamhealth.HealthThresholds, nowMs float64, audioSource string) (probed, keep bool) {
	rt := w.rooms[key]
	if rt == nil {
		rt = &roomRT{origin: room, edge: edge, state: NewRoomState()}
		w.rooms[key] = rt
		w.order = append(w.order, key)
		if edge == nil {
			w.log("room discovered: " + room)
		} else {
			w.log("room discovered: " + key + " via " + edge.PlaylistURL(w.app, room))
		}
	}
	if nowMs-rt.lastSampleMs < t.SampleIntervalSec*1000 {
		return false, true
	}
	rt.lastSampleMs = nowMs
	return true, w.probeRoom(ctx, key, rt, t, nowMs, audioSource)
}

type overview struct {
	Room    string      `json:"room"`
	TS      float64     `json:"ts"`
	Streams []*snapshot `json:"streams"`
}

func (w *worker) tick(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			w.log(fmt.Sprintf("tick error: %v", r))
		}
	}()
	nowMs := w.nowMs()
	overrides := ReadRoomOverrides(ctx, w.dbFile)
	sources := ReadRoomSources(ctx, w.dbFile)
	live := w.listRooms()
	liveSet := map[string]bool{}
	for _, r := range live {
		liveSet[r] = true
	}
	for _, key := range append([]string{}, w.order...) {
		if rt := w.rooms[key]; rt != nil && !liveSet[rt.origin] {
			w.forget(key)
			w.log("room gone: " + key)
		}
	}
	sampled := false
	for _, room := range live {
		if ctx.Err() != nil {
			return
		}
		t := streamhealth.ResolveThresholds(w.appConfig, overrides[room])
		audioSource := ""
		if has, ok := sources[room]; ok {
			audioSource = "track"
			if !has {
				audioSource = "none"
			}
		}
		probed, keep := w.sample(ctx, room, room, nil, t, nowMs, audioSource)
		if !keep {
			w.forgetRoom(room)
			continue
		}
		sampled = sampled || probed
		for i := range w.edges {
			e := &w.edges[i]
			if ctx.Err() != nil {
				return
			}
			probed, _ := w.sample(ctx, room+"@"+e.Name, room, e, t, nowMs, audioSource)
			sampled = sampled || probed
		}
	}
	if sampled || len(w.rooms) > 0 {
		ov := overview{Room: "overview", TS: w.nowMs(), Streams: []*snapshot{}}
		for _, room := range w.order {
			if s := w.rooms[room].snapshot; s != nil {
				ov.Streams = append(ov.Streams, s)
			}
		}
		body, _ := jsx.Stringify(ov)
		w.post(ctx, w.ingestURL, []byte(body))
	}
}
