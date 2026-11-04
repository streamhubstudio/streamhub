package camgw

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ingressSettle is the pause before re-publishing to the same ingress.
var ingressSettle = 5 * time.Second

// Want is the desired output of a camera's pipeline.
type Want struct {
	Stream bool
	Record bool
	Source int // 0 main, 1 sub
}

// PipeStats is what state reports about the pipeline.
type PipeStats struct {
	Running      bool
	Want         Want
	BitrateKbps  int
	Frames       int64
	Dropped      int64
	Restarts1h   int
	LastError    string
	StartedAt    time.Time
	SegmentStart time.Time
}

// Pipeline runs ONE ffmpeg per camera: a single RTSP session, video stream
// copied (no decode — the RV1106 cannot afford one), audio to AAC so G.711
// cameras fit FLV/MP4, fanned out with the tee muxer to the RTMP ingest and/or
// MP4 segments. It restarts with backoff forever (a camera or the server being
// down for an hour must not need an operator) and any change of Want rebuilds it.
type Pipeline struct {
	ffmpeg  string
	cam     *Camera
	dir     string // recordings dir of this device
	logf    func(string, ...any)
	onEvent func(level, ev, msg string)
	resolve func(string) string // URL with its host replaced by an IP
	probe   func(string) string // audio codec of a source ("" = none/unknown)
	codecs  map[string]string   // probe cache per source URL

	mu       sync.Mutex
	want     Want
	kick     chan struct{}
	stats    PipeStats
	restarts []time.Time
}

func NewPipeline(ffmpeg string, cam *Camera, dataDir string, logf func(string, ...any), onEvent func(level, ev, msg string)) *Pipeline {
	p := &Pipeline{ffmpeg: ffmpeg, cam: cam, logf: logf, onEvent: onEvent, kick: make(chan struct{}, 1), resolve: resolveURLHost, codecs: map[string]string{}}
	p.probe = func(src string) string { return probeAudio(ffmpeg, src) }
	if dataDir != "" {
		p.dir = filepath.Join(dataDir, cam.Device.ID)
	}
	src := 1
	if s, err := strconv.Atoi(cam.Stream.Source); err == nil && (s == 0 || s == 1) {
		src = s
	}
	if cam.RTSPSub == "" {
		src = 0
	}
	p.want = Want{Stream: truthy(cam.Stream.Enabled) && cam.PushURL() != "", Record: cam.Record, Source: src}
	return p
}

// Set changes the desired outputs; the running ffmpeg is rebuilt.
func (p *Pipeline) Set(f func(w *Want)) Want {
	p.mu.Lock()
	f(&p.want)
	if p.cam.RTSPSub == "" {
		p.want.Source = 0
	}
	w := p.want
	p.mu.Unlock()
	select {
	case p.kick <- struct{}{}:
	default:
	}
	return w
}

// Restart rebuilds the ffmpeg with the same Want (system/reboot).
func (p *Pipeline) Restart() { p.Set(func(*Want) {}) }

func (p *Pipeline) Stats() PipeStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.stats
	s.Want = p.want
	cut := time.Now().Add(-time.Hour)
	for _, t := range p.restarts {
		if t.After(cut) {
			s.Restarts1h++
		}
	}
	return s
}

func (p *Pipeline) source(w Want) string {
	if w.Source == 1 && p.cam.RTSPSub != "" {
		return p.cam.RTSPSub
	}
	return p.cam.RTSP
}

// args builds the ffmpeg command line for w ("" outputs → nil).
func (p *Pipeline) args(w Want) []string {
	var outs []string
	if w.Stream && p.cam.PushURL() != "" {
		outs = append(outs, "[f=flv:onfail=ignore]"+p.resolve(p.cam.PushURL()))
	}
	if w.Record && p.dir != "" {
		seg := strconv.Itoa(p.cam.SegmentMin * 60)
		outs = append(outs, "[f=segment:segment_time="+seg+":segment_format=mp4:reset_timestamps=1:strftime=1]"+
			filepath.Join(p.dir, "%Y-%m-%d_%H-%M-%S.mp4"))
	}
	if len(outs) == 0 {
		return nil
	}
	a := []string{"-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:1", "-nostats",
		"-rtsp_transport", "tcp", "-timeout", "10000000", "-probesize", "500000", "-analyzeduration", "1000000",
		"-i", p.resolve(p.source(w)), "-map", "0:v:0", "-c:v", "copy"}
	a = append(a, p.audioArgs(p.source(w))...)
	a = append(a, "-threads", "1", "-max_muxing_queue_size", "64")
	if len(outs) == 1 && !strings.HasPrefix(outs[0], "[f=segment") {
		return append(a, "-f", "flv", strings.TrimPrefix(outs[0], "[f=flv:onfail=ignore]"))
	}
	return append(a, "-f", "tee", strings.Join(outs, "|"))
}

// Run supervises the ffmpeg until ctx ends.
func (p *Pipeline) Run(ctx context.Context) {
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		p.mu.Lock()
		w := p.want
		p.mu.Unlock()
		args := p.args(w)
		if args == nil {
			p.setRunning(false, "")
			select {
			case <-ctx.Done():
				return
			case <-p.kick:
				continue
			}
		}
		if p.dir != "" && w.Record {
			_ = os.MkdirAll(p.dir, 0o755)
		}
		started := time.Now()
		changed, errMsg := p.runOnce(ctx, args)
		if ctx.Err() != nil {
			return
		}
		if changed {
			backoff = 2 * time.Second
			if w.Stream {
				// LiveKit's RTMP ingress ends the previous session a few
				// seconds after the TCP close; a publish that lands before
				// that (e.g. HD → normal) leaves the ingress in `error`.
				select {
				case <-ctx.Done():
					return
				case <-time.After(ingressSettle):
				}
			}
			continue
		}
		if time.Since(started) > 60*time.Second {
			backoff = 2 * time.Second
		}
		p.mu.Lock()
		p.restarts = append(p.restarts, time.Now())
		if len(p.restarts) > 100 {
			p.restarts = p.restarts[len(p.restarts)-100:]
		}
		p.mu.Unlock()
		p.onEvent("warn", "stream_down", fmt.Sprintf("ffmpeg exited (%s), retry in %s", errMsg, backoff))
		select {
		case <-ctx.Done():
			return
		case <-p.kick:
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (p *Pipeline) setRunning(on bool, errMsg string) {
	p.mu.Lock()
	p.stats.Running = on
	if on {
		p.stats.StartedAt = time.Now()
		p.stats.SegmentStart = time.Now()
		p.stats.Frames, p.stats.Dropped = 0, 0
	} else {
		p.stats.BitrateKbps = 0
	}
	if errMsg != "" {
		p.stats.LastError = errMsg
	}
	p.mu.Unlock()
}

// runOnce runs one ffmpeg; changed=true when it was stopped for a new Want.
func (p *Pipeline) runOnce(ctx context.Context, args []string) (changed bool, errMsg string) {
	cmd := exec.Command(p.ffmpeg, args...)
	setChildAttrs(cmd)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return false, err.Error()
	}
	p.setRunning(true, "")
	p.onEvent("info", "started", "ffmpeg up ("+describe(args)+")")
	var tail lastLines
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); p.readProgress(stdout) }()
	go func() { defer wg.Done(); tail.read(stderr) }()
	done := make(chan error, 1)
	go func() { wg.Wait(); done <- cmd.Wait() }()

	stop := func() {
		// SIGINT lets ffmpeg close the MP4 segment (moov) and the FLV.
		_ = cmd.Process.Signal(syscall.SIGINT)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	}
	select {
	case <-ctx.Done():
		stop()
		p.setRunning(false, "")
		return false, ""
	case <-p.kick:
		stop()
		p.setRunning(false, "")
		p.onEvent("info", "reconfigured", "pipeline rebuilt")
		return true, ""
	case err := <-done:
		msg := tail.last()
		if msg == "" && err != nil {
			msg = err.Error()
		}
		p.setRunning(false, msg)
		return false, msg
	}
}

// audioArgs picks the audio handling per camera.audio: "copy", "aac", "off",
// or "auto" (default): copy AAC as is, drop a missing track, re-encode
// anything else (G.711…) to AAC for FLV/MP4. Copying matters on the RV1106:
// an AAC re-encode costs ~18% CPU per camera against ~7% for the whole relay.
func (p *Pipeline) audioArgs(src string) []string {
	copyA := []string{"-map", "0:a:0?", "-c:a", "copy"}
	aac := []string{"-map", "0:a:0?", "-c:a", "aac", "-b:a", "32k"}
	switch p.cam.Audio {
	case "off":
		return []string{"-an"}
	case "copy":
		return copyA
	case "aac":
		return aac
	}
	p.mu.Lock()
	codec, ok := p.codecs[src]
	p.mu.Unlock()
	if !ok {
		codec = p.probe(src)
		if codec != "" { // a failed probe is retried at the next start
			p.mu.Lock()
			p.codecs[src] = codec
			p.mu.Unlock()
		}
		p.logf("audio: %s → codec %q", redactURL(src), codec)
	}
	switch codec {
	case "aac":
		return copyA
	case "none":
		return []string{"-an"}
	}
	return aac // unknown (probe failed) or not FLV/MP4-friendly
}

var audioRe = regexp.MustCompile(`Audio: ([a-z0-9_]+)`)

// probeMu serializes probes: ten cameras probing at once on a single-core
// board time each other out.
var probeMu sync.Mutex

// probeAudio reads the audio codec off ffmpeg's stream listing without
// decoding anything (`ffmpeg -i src` with no output prints the streams and
// exits): "aac", "none" (no audio track) or "" when the probe fails.
func probeAudio(ffmpeg, src string) string {
	probeMu.Lock()
	defer probeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-nostdin", "-rtsp_transport", "tcp", "-timeout", "8000000",
		"-i", resolveURLHost(src))
	setChildAttrs(cmd)
	out, _ := cmd.CombinedOutput()
	if !strings.Contains(string(out), "Video:") {
		return ""
	}
	if m := audioRe.FindSubmatch(out); m != nil {
		return string(m[1])
	}
	return "none"
}

func describe(args []string) string {
	out := args[len(args)-1]
	switch {
	case strings.Contains(out, "|"):
		return "stream+record"
	case strings.HasPrefix(out, "rtmp"):
		return "stream"
	}
	return "record"
}

func (p *Pipeline) readProgress(r io.Reader) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "bitrate":
			if f, err := strconv.ParseFloat(strings.TrimSuffix(v, "kbits/s"), 64); err == nil {
				p.mu.Lock()
				p.stats.BitrateKbps = int(f)
				p.mu.Unlock()
			}
		case "frame", "drop_frames":
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				p.mu.Lock()
				if k == "frame" {
					p.stats.Frames = n
				} else {
					p.stats.Dropped = n
				}
				p.mu.Unlock()
			}
		}
	}
}

// lastLines keeps ffmpeg's last stderr line (credentials stripped).
type lastLines struct {
	mu sync.Mutex
	s  string
}

func (l *lastLines) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if t := strings.TrimSpace(sc.Text()); t != "" {
			l.mu.Lock()
			l.s = redactURL(t)
			l.mu.Unlock()
		}
	}
}

func (l *lastLines) last() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.s) > 160 {
		return l.s[:160]
	}
	return l.s
}

// redactURL hides user:pass@ and RTMP keys in a log line.
func redactURL(s string) string {
	for _, f := range strings.Fields(s) {
		if i := strings.Index(f, "://"); i > 0 {
			r := f
			if at := strings.Index(r, "@"); at > i {
				r = r[:i+3] + "***@" + r[at+1:]
			}
			if strings.HasPrefix(r, "rtmp") {
				if sl := strings.LastIndex(r, "/"); sl > i+3 {
					r = r[:sl+1] + "***"
				}
			}
			s = strings.ReplaceAll(s, f, r)
		}
	}
	return s
}

// resolveURLHost swaps the host of u for its IPv4 address. Static ffmpeg
// builds (glibc static, as shipped for armhf) cannot resolve names at all, so
// the gateway resolves with Go's resolver at every (re)start. On failure u is
// returned unchanged and ffmpeg reports the error.
func resolveURLHost(u string) string {
	pu, err := url.Parse(u)
	if err != nil || pu.Hostname() == "" || net.ParseIP(pu.Hostname()) != nil {
		return u
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", pu.Hostname())
	if err != nil || len(ips) == 0 {
		return u
	}
	host := ips[0].String()
	if port := pu.Port(); port != "" {
		host = net.JoinHostPort(host, port)
	}
	pu.Host = host
	return pu.String()
}
