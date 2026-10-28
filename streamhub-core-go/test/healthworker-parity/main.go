// Command healthworker-parity runs the Node stream-health worker (the
// pre-F1 health-worker/, kept only in git history) and the Go one
// (`streamhub-core health-worker`) side by side over the SAME synthetic HLS
// rooms, then diffs the event sequences each one POSTs.
//
// The segments are real MPEG-TS made by ffmpeg: healthy (CBR 1500k + 440 Hz
// tone), silent (anullsrc), A/V desync (audio offset 0.4 s), low bitrate
// (CBR 200k), video-only, and a copy with a corrupted continuity counter. A
// player then writes the rooms' live playlists over time:
//
//	live-main     healthy → silence → recover → desync → recover → bitrate
//	              drop → recover → stall → resume → CC error → dropped
//	              segments → recover → ENDLIST
//	live-noaudio  video-only segments (audio_missing), then ENDLIST
//	live-gap      healthy, a media-sequence jump (dropped segments), ENDLIST
//
// Usage (heavy: ~3.5 min of real time, ffmpeg + two workers — run it on the
// .50, not the Mac):
//
//	git worktree add /tmp/hw d05b0512                     # the Node worker
//	GOOS=linux go build -o /tmp/streamhub-core ./cmd/streamhub
//	GOOS=linux go build -o /tmp/hwparity ./test/healthworker-parity
//	/tmp/hwparity -node-worker /tmp/hw/health-worker -go-bin /tmp/streamhub-core
//
// Exit 0 when both workers emitted the same events in the same order per
// room (time-derived fields — stalledForSec, silentForSec — are compared
// with ±1 tick of tolerance and printed side by side).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	nodeWorker = flag.String("node-worker", "", "Node health-worker dir (with src/main.js)")
	goBin      = flag.String("go-bin", "", "streamhub-core binary (Go worker = `<bin> health-worker`)")
	nodeBin    = flag.String("node", "node", "node executable (>= 22.13, for node:sqlite)")
	ffmpeg     = flag.String("ffmpeg", "ffmpeg", "ffmpeg executable")
	workDir    = flag.String("work", "", "work dir (default: a temp dir)")
	step       = flag.Duration("step", 4*time.Second, "segment cadence (keep it ≥ 2× the 2 s sample interval)")
	keep       = flag.Bool("keep", false, "keep the work dir")
)

const config = `{"sample_interval_sec":2,"stall_sec":8,"silence_duration_sec":6,"desync_ms":200,"bitrate_drop_pct":50,"silence_db":-50,"recover_samples":2}`

type event struct {
	Event string         `json:"event"`
	Room  string         `json:"room"`
	Data  map[string]any `json:"data"`
}

type sink struct {
	mu     sync.Mutex
	events map[string][]event // worker → events, receive order
	posts  map[string]int     // worker → overview posts
}

func (s *sink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // <worker>/<events|live>
	b, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(parts) == 2 && parts[1] == "events" {
		var e event
		if json.Unmarshal(b, &e) == nil {
			s.events[parts[0]] = append(s.events[parts[0]], e)
		}
	} else if len(parts) == 2 {
		s.posts[parts[0]]++
	}
	w.WriteHeader(http.StatusCreated)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "FATAL:", err)
		os.Exit(1)
	}
}

func ff(args ...string) {
	cmd := exec.Command(*ffmpeg, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		must(fmt.Errorf("ffmpeg %v: %v\n%s", args, err, out))
	}
}

// makePool synthesizes one 2 s segment per kind.
func makePool(dir string) {
	v := []string{"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25"}
	tone := []string{"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"}
	silence := []string{"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"}
	enc := func(kbps string) []string {
		return []string{"-t", "2", "-c:v", "libx264", "-preset", "veryfast", "-g", "50", "-b:v", kbps, "-minrate", kbps,
			"-maxrate", kbps, "-bufsize", kbps, "-x264-params", "nal-hrd=cbr", "-c:a", "aac", "-b:a", "96k", "-muxrate", "0"}
	}
	cat := func(parts ...[]string) []string {
		var out []string
		for _, p := range parts {
			out = append(out, p...)
		}
		return out
	}
	ff(cat(v, tone, enc("1500k"), []string{"-f", "mpegts", filepath.Join(dir, "healthy.ts")})...)
	ff(cat(v, silence, enc("1500k"), []string{"-f", "mpegts", filepath.Join(dir, "silent.ts")})...)
	ff(cat(v, []string{"-itsoffset", "0.4"}, tone, enc("1500k"), []string{"-f", "mpegts", filepath.Join(dir, "desync.ts")})...)
	ff(cat(v, tone, enc("200k"), []string{"-f", "mpegts", filepath.Join(dir, "low.ts")})...)
	ff(cat(v, enc("1500k"), []string{"-an", "-f", "mpegts", filepath.Join(dir, "videoonly.ts")})...)
	// a CC skip on the first video PID packet past the PAT/PMT
	b, err := os.ReadFile(filepath.Join(dir, "healthy.ts"))
	must(err)
	for i := 0; i+188 <= len(b); i += 188 {
		pid := int(b[i+1]&0x1f)<<8 | int(b[i+2])
		if pid == 0x100 && i > 188*20 && b[i+3]&0x10 != 0 {
			b[i+3] = b[i+3]&0xf0 | (b[i+3]+2)&0x0f
			break
		}
	}
	must(os.WriteFile(filepath.Join(dir, "cc.ts"), b, 0o644))
}

// room is one live playlist the player advances.
type room struct {
	name   string
	dir    string
	seq    int // media sequence of the window start
	n      int // segments produced
	window []string
	ended  bool
}

func (r *room) add(pool, kind string) {
	name := fmt.Sprintf("seg-%05d.ts", r.n)
	src, err := os.ReadFile(filepath.Join(pool, kind+".ts"))
	must(err)
	must(os.WriteFile(filepath.Join(r.dir, name), src, 0o644))
	r.n++
	r.window = append(r.window, name)
	if len(r.window) > 5 {
		r.window = r.window[1:]
		r.seq++
	}
	r.write()
}

// jump drops segments from the window unseen (a media-sequence gap).
func (r *room) jump(pool string, k int) {
	r.seq += len(r.window) + k
	r.n += k
	r.window = nil
	r.add(pool, "healthy")
}

func (r *room) write() {
	var b strings.Builder
	fmt.Fprintf(&b, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:%d\n", r.seq)
	for _, s := range r.window {
		fmt.Fprintf(&b, "#EXTINF:2.000,\n%s\n", s)
	}
	if r.ended {
		b.WriteString("#EXT-X-ENDLIST\n")
	}
	tmp := filepath.Join(r.dir, "index.m3u8.tmp")
	must(os.WriteFile(tmp, []byte(b.String()), 0o644))
	must(os.Rename(tmp, filepath.Join(r.dir, "index.m3u8")))
}

type action struct {
	room, kind string // kind: a pool segment | "stall" | "jump" | "end"
}

// script is the per-step timeline (one entry per step; "" = idle).
func script() [][]action {
	var s [][]action
	main := func(kind string, times int) {
		for i := 0; i < times; i++ {
			s = append(s, []action{{"live-main", kind}})
		}
	}
	main("healthy", 5)
	main("silent", 6)
	main("healthy", 4)
	main("desync", 4)
	main("healthy", 4)
	main("low", 4)
	main("healthy", 4)
	main("stall", 4) // no new segment for 4 steps (> stall_sec)
	main("healthy", 4)
	main("cc", 1)
	main("healthy", 3)
	main("jump", 1)
	main("healthy", 4)
	main("end", 1)
	// a video-only room alongside, from the start
	for i := 0; i < 8; i++ {
		s[i] = append(s[i], action{"live-noaudio", "videoonly"})
	}
	s[8] = append(s[8], action{"live-noaudio", "end"})
	// a media-sequence gap in its own room (live-main's falls in the
	// discontinuity cooldown)
	gap := []string{"healthy", "healthy", "healthy", "healthy", "jump", "healthy", "healthy", "healthy", "healthy", "end"}
	for i, k := range gap {
		s[10+i] = append(s[10+i], action{"live-gap", k})
	}
	return s
}

func startWorker(ctx context.Context, name string, argv []string, hls, data, base string, logw io.Writer) *exec.Cmd {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "HEALTH_APP=live", "HEALTH_HLS_DIR="+hls, "HEALTH_DATA_DIR="+data,
		"HEALTH_CONFIG_JSON="+config, "STREAMHUB_INGEST_TOKEN=t",
		"STREAMHUB_EVENTS_URL="+base+"/"+name+"/events", "STREAMHUB_INGEST_URL="+base+"/"+name+"/live")
	cmd.Stdout, cmd.Stderr = logw, logw
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	must(cmd.Start())
	return cmd
}

// timeFields are derived from wallclock tick phase, not media.
var timeFields = map[string]bool{"stalledForSec": true, "silentForSec": true}

func key(e event) string {
	d := map[string]any{}
	for k, v := range e.Data {
		if !timeFields[k] {
			d[k] = v
		}
	}
	b, _ := json.Marshal(d)
	return e.Room + " " + e.Event + " " + string(b)
}

func byRoom(evs []event) map[string][]event {
	out := map[string][]event{}
	for _, e := range evs {
		out[e.Room] = append(out[e.Room], e)
	}
	return out
}

func main() {
	flag.Parse()
	if *nodeWorker == "" || *goBin == "" {
		fmt.Fprintln(os.Stderr, "usage: healthworker-parity -node-worker <health-worker dir> -go-bin <streamhub-core>")
		os.Exit(2)
	}
	dir := *workDir
	if dir == "" {
		d, err := os.MkdirTemp("", "hwparity-")
		must(err)
		dir = d
	}
	if !*keep {
		defer os.RemoveAll(dir)
	}
	pool, hls := filepath.Join(dir, "pool"), filepath.Join(dir, "hls")
	for _, d := range []string{pool, hls, filepath.Join(dir, "data-node"), filepath.Join(dir, "data-go")} {
		must(os.MkdirAll(d, 0o755))
	}
	fmt.Println("synthesizing segments …")
	makePool(pool)
	for _, k := range []string{"healthy", "silent", "desync", "low", "videoonly", "cc"} {
		st, _ := os.Stat(filepath.Join(pool, k+".ts"))
		fmt.Printf("  %-10s %7d bytes (%d kbps over 2 s)\n", k, st.Size(), st.Size()*8/2/1000)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	sk := &sink{events: map[string][]event{}, posts: map[string]int{}}
	go func() { _ = http.Serve(ln, sk) }()
	base := "http://" + ln.Addr().String()

	rooms := map[string]*room{}
	for _, n := range []string{"live-main", "live-noaudio", "live-gap"} {
		r := &room{name: n, dir: filepath.Join(hls, n)}
		must(os.MkdirAll(r.dir, 0o755))
		rooms[n] = r
	}
	sc := script()
	// first step before the workers start, so both discover the rooms together
	apply := func(acts []action) {
		for _, a := range acts {
			r := rooms[a.room]
			switch a.kind {
			case "stall":
			case "jump":
				r.jump(pool, 3)
			case "end":
				r.ended = true
				r.write()
			default:
				r.add(pool, a.kind)
			}
		}
	}
	apply(sc[0])

	ctx, cancel := context.WithCancel(context.Background())
	var nodeLog, goLog bytes.Buffer
	nodeCmd := startWorker(ctx, "node", []string{*nodeBin, filepath.Join(*nodeWorker, "src", "main.js")}, hls, filepath.Join(dir, "data-node"), base, &nodeLog)
	goCmd := startWorker(ctx, "go", []string{*goBin, "health-worker"}, hls, filepath.Join(dir, "data-go"), base, &goLog)
	fmt.Printf("playing %d steps every %s …\n", len(sc), *step)
	for _, acts := range sc[1:] {
		time.Sleep(*step)
		apply(acts)
	}
	time.Sleep(3 * *step)
	cancel()
	_ = nodeCmd.Wait()
	_ = goCmd.Wait()

	sk.mu.Lock()
	defer sk.mu.Unlock()
	// The emitted ORDER comes from each worker's stdout `event …` lines: Node
	// POSTs events concurrently (`void postEvent`), so their arrival order at
	// the sink is not deterministic. The sink must still have received the
	// same events (as a multiset) that each worker logged.
	nodeEv, goEv := logEvents(nodeLog.String()), logEvents(goLog.String())
	sinkOK := sameMultiset(nodeEv, sk.events["node"]) && sameMultiset(goEv, sk.events["go"])
	nodeBy, goBy := byRoom(nodeEv), byRoom(goEv)
	names := map[string]bool{}
	for r := range nodeBy {
		names[r] = true
	}
	for r := range goBy {
		names[r] = true
	}
	var roomNames []string
	for r := range names {
		roomNames = append(roomNames, r)
	}
	sort.Strings(roomNames)
	equal := true
	for _, r := range roomNames {
		n, g := nodeBy[r], goBy[r]
		fmt.Printf("\n== %s: node %d events, go %d events\n", r, len(n), len(g))
		for i := 0; i < max(len(n), len(g)); i++ {
			var ln, lg string
			mark := " "
			if i < len(n) {
				ln = fmtEvent(n[i])
			}
			if i < len(g) {
				lg = fmtEvent(g[i])
			}
			if i >= len(n) || i >= len(g) || key(n[i]) != key(g[i]) || !timeClose(n[i], g[i]) {
				mark, equal = "≠", false
			}
			fmt.Printf("%s %-3d node %-70s | go %s\n", mark, i, ln, lg)
		}
	}
	fmt.Printf("\noverview posts: node %d, go %d\n", sk.posts["node"], sk.posts["go"])
	if strings.Count(nodeLog.String(), "room discovered") != strings.Count(goLog.String(), "room discovered") {
		fmt.Printf("note: 'room discovered' lines node %d / go %d\n", strings.Count(nodeLog.String(), "room discovered"), strings.Count(goLog.String(), "room discovered"))
	}
	if !sinkOK {
		fmt.Println("POSTed events do not match the logged ones")
		equal = false
	}
	if equal {
		fmt.Println("RESULT: event sequences EQUAL")
		return
	}
	fmt.Println("RESULT: event sequences DIFFER")
	fmt.Println("--- node stdout ---\n" + nodeLog.String() + "--- go stdout ---\n" + goLog.String())
	os.Exit(1)
}

// logEvents parses `[health-worker] event <name> room=<room> <json>` lines.
func logEvents(out string) []event {
	var evs []event
	for _, line := range strings.Split(out, "\n") {
		rest, ok := strings.CutPrefix(line, "[health-worker] event ")
		if !ok {
			continue
		}
		name, rest, _ := strings.Cut(rest, " room=")
		roomName, data, _ := strings.Cut(rest, " ")
		e := event{Event: name, Room: roomName}
		_ = json.Unmarshal([]byte(data), &e.Data)
		evs = append(evs, e)
	}
	return evs
}

func sameMultiset(a, b []event) bool {
	count := map[string]int{}
	for _, e := range a {
		count[key(e)]++
	}
	for _, e := range b {
		count[key(e)]--
	}
	for _, n := range count {
		if n != 0 {
			return false
		}
	}
	return true
}

func fmtEvent(e event) string {
	b, _ := json.Marshal(e.Data)
	return e.Event + " " + string(b)
}

// timeClose: wallclock-derived fields may differ by one sample tick (2 s).
func timeClose(a, b event) bool {
	for k := range timeFields {
		x, okx := a.Data[k].(float64)
		y, oky := b.Data[k].(float64)
		if okx != oky || (okx && math.Abs(x-y) > 2) {
			return false
		}
	}
	return true
}
