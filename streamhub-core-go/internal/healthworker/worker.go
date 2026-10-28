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

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/streamhealth"
)

// Port of main.js: the orchestration loop (every decision lives in the pure
// files next to this one).
//
// Environment (set by the plugin framework's stream-health spawn):
//
//	HEALTH_APP             app slug
//	HEALTH_HLS_DIR         <appDir>/hls (one sub-dir per room, index.m3u8)
//	HEALTH_DATA_DIR        <appDir>/stream-health (stream-health.db lives here)
//	HEALTH_CONFIG_JSON     app-level thresholds (install config)
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

func (w *worker) postEvent(room string, e Event) {
	data, _ := y.Stringify(e.Data)
	w.log(fmt.Sprintf("event %s room=%s %s", e.Event, room, data))
	body := y.NewMap()
	body.Set("event", e.Event)
	body.Set("room", room)
	body.Set("data", e.Data)
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
}

// probeRoom samples one room; false = the stream ended (forget the room).
func (w *worker) probeRoom(ctx context.Context, room string, rt *roomRT, t streamhealth.HealthThresholds, nowMs float64) bool {
	roomDir := filepath.Join(w.hlsDir, room)
	text, err := os.ReadFile(filepath.Join(roomDir, "index.m3u8"))
	if err != nil {
		return false // playlist gone → stream ended
	}
	pl := ParsePlaylist(string(text))
	if pl.Endlist {
		return false // converted to VOD → done
	}
	diff := DiffPlaylist(rt.prev, pl)
	rt.prev = &pl
	if rt.lastAdvanceMs == nil || diff.Advanced {
		v := nowMs
		rt.lastAdvanceMs = &v
	}
	sinceAdvance := (nowMs - *rt.lastAdvanceMs) / 1000

	// stat() the new segments for the measured delivery bitrate
	var infos []SegInfo
	newestPath, newestURI := "", ""
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
	kbps := MeasuredKbps(infos)

	// deep-probe only when a NEW segment landed
	var hasAudio *bool
	var meanDb, desyncMs *float64
	ccErrors := 0
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
		if hasAudio != nil && *hasAudio {
			_, stderr := w.o.Run(ctx, w.ffmpeg, VolumeArgs(newestPath))
			if v := ParseVolumeDetect(stderr); v != nil {
				m := v.MeanDb
				meanDb = &m
			}
		}
	}

	res := Evaluate(rt.state, Sample{SecondsSinceAdvance: sinceAdvance, DroppedSegments: diff.DroppedSegments,
		CCErrors: float64(ccErrors), NewDiscontinuityTags: float64(diff.NewDiscontinuityTags), HasAudioTrack: hasAudio,
		MeanDb: meanDb, DesyncMs: desyncMs, MeasuredKbps: kbps}, t, nowMs)
	for _, e := range res.Events {
		w.postEvent(room, e)
	}

	snap := &snapshot{Room: room, Status: res.Status, Reasons: res.Reasons, TS: nowMs, Metrics: snapshotMetrics{
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

func (w *worker) forget(room string) {
	delete(w.rooms, room)
	for i, r := range w.order {
		if r == room {
			w.order = append(w.order[:i], w.order[i+1:]...)
			break
		}
	}
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
	live := w.listRooms()
	liveSet := map[string]bool{}
	for _, r := range live {
		liveSet[r] = true
	}
	for _, room := range append([]string{}, w.order...) {
		if !liveSet[room] {
			w.forget(room)
			w.log("room gone: " + room)
		}
	}
	sampled := false
	for _, room := range live {
		if ctx.Err() != nil {
			return
		}
		rt := w.rooms[room]
		if rt == nil {
			rt = &roomRT{state: NewRoomState()}
			w.rooms[room] = rt
			w.order = append(w.order, room)
			w.log("room discovered: " + room)
		}
		t := streamhealth.ResolveThresholds(w.appConfig, overrides[room])
		if nowMs-rt.lastSampleMs < t.SampleIntervalSec*1000 {
			continue
		}
		rt.lastSampleMs = nowMs
		if !w.probeRoom(ctx, room, rt, t, nowMs) {
			w.forget(room)
			continue
		}
		sampled = true
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
