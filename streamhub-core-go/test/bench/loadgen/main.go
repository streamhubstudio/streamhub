// Command loadgen is the Node-vs-Go core benchmark driver
// (internal design notes). Modes:
//
//	feeder  fake live HLS room: writes a 1–2 MB .ts segment every -seg and
//	        atomically rewrites index.m3u8 (sliding window of 6)
//	hls     ramp N concurrent HLS viewers (playlist poll + every new segment)
//	        against any HLS endpoint (local core, proxy direct-serve, edge,
//	        remote origin) and flag the fan-out KNEE: the first step where
//	        segment p95 > -target-p95 or errors > -max-error ("fly mode", ex
//	        scripts/hls-loadtest.mjs; -plan prints the ramp, sends nothing)
//	api     open-loop authenticated API mix at rising RPS
//	latency glass-to-glass WebRTC/HLS latency: drive ../latency/latency-page.html
//	        in headless Chrome and print its JSON result (ex bench/latency)
//
// hls/api sample the server process (-pid: CPU% + RSS from /proc) and its
// /metrics (-metrics URL: Node event-loop lag / Go goroutines + GC pauses)
// once per second and print one JSON line per step on stdout.
//
// Each viewer keeps one keep-alive connection. Run inside a private netns
// (netns.sh): on WSL2 mirrored networking 127.0.0.1 is policy-routed through
// the Windows host.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: loadgen feeder|hls|api|latency [flags]")
		os.Exit(2)
	}
	mode, args := os.Args[1], os.Args[2:]
	switch mode {
	case "feeder":
		feeder(args)
	case "hls":
		hlsMode(args)
	case "api":
		apiMode(args)
	case "latency":
		os.Exit(latencyMode(args))
	default:
		fmt.Fprintln(os.Stderr, "unknown mode", mode)
		os.Exit(2)
	}
}

// ---------------------------------------------------------------------------
// feeder
// ---------------------------------------------------------------------------

func feeder(args []string) {
	fs := flag.NewFlagSet("feeder", flag.ExitOnError)
	dir := fs.String("dir", "", "room HLS dir (<DATA_DIR>/apps/<app>/hls/<room>)")
	seg := fs.Duration("seg", 4*time.Second, "segment duration")
	window := fs.Int("window", 6, "playlist window")
	_ = fs.Parse(args)
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		panic(err)
	}
	// A pool of random payloads (1.0–2.0 MB), reused round-robin.
	pool := make([][]byte, 8)
	for i := range pool {
		pool[i] = make([]byte, 1_000_000+i*140_000)
		_, _ = rand.Read(pool[i])
	}
	seq := 0
	write := func() {
		name := fmt.Sprintf("seg_%05d.ts", seq)
		tmp := filepath.Join(*dir, "."+name)
		_ = os.WriteFile(tmp, pool[seq%len(pool)], 0o644)
		_ = os.Rename(tmp, filepath.Join(*dir, name))
		first := max(0, seq-*window+1)
		var b strings.Builder
		fmt.Fprintf(&b, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:%d\n", int(seg.Seconds()), first)
		for i := first; i <= seq; i++ {
			fmt.Fprintf(&b, "#EXTINF:%.3f,\nseg_%05d.ts\n", seg.Seconds(), i)
		}
		pl := filepath.Join(*dir, "index.m3u8")
		_ = os.WriteFile(pl+".tmp", []byte(b.String()), 0o644)
		_ = os.Rename(pl+".tmp", pl)
		// keep 2 extra segments past the window for slow viewers
		if old := seq - *window - 2; old >= 0 {
			_ = os.Remove(filepath.Join(*dir, fmt.Sprintf("seg_%05d.ts", old)))
		}
		seq++
	}
	for i := 0; i < *window; i++ { // pre-fill a full window
		write()
	}
	t := time.NewTicker(*seg)
	for range t.C {
		write()
	}
}

// ---------------------------------------------------------------------------
// shared: clients, stats, server sampling
// ---------------------------------------------------------------------------

// insecureTLS skips certificate verification (-insecure: self-signed origins).
var insecureTLS bool

func newClient(srcIPs, conns int, timeout time.Duration, idx int) *http.Client {
	d := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	if srcIPs > 0 {
		// explicit source IPs: bind() per dial (slow under many sockets —
		// only for hosts whose ephemeral range is too small)
		d.LocalAddr = &net.TCPAddr{IP: net.IPv4(127, 0, 0, byte(1+idx%srcIPs))}
	}
	return &http.Client{Timeout: timeout, Transport: &http.Transport{
		DialContext: d.DialContext, MaxIdleConns: conns, MaxIdleConnsPerHost: conns, MaxConnsPerHost: conns,
		IdleConnTimeout: 90 * time.Second, DisableCompression: true,
		TLSClientConfig: &tls.Config{InsecureSkipVerify: insecureTLS}, //nolint:gosec // opt-in bench flag
	}}
}

type recorder struct {
	mu    sync.Mutex
	lat   []float64 // ms
	errs  int64
	bytes int64
}

// errKinds counts error classes (first 60 chars) for the step report.
var errKinds sync.Map

func noteErr(err error) {
	if err == nil {
		return
	}
	k := err.Error()
	if i := strings.LastIndex(k, ": "); i > 0 {
		k = k[i+2:]
	}
	if len(k) > 60 {
		k = k[:60]
	}
	v, _ := errKinds.LoadOrStore(k, new(atomic.Int64))
	v.(*atomic.Int64).Add(1)
}

func takeErrKinds() map[string]int64 {
	out := map[string]int64{}
	errKinds.Range(func(k, v any) bool {
		if n := v.(*atomic.Int64).Swap(0); n > 0 {
			out[k.(string)] = n
		}
		return true
	})
	return out
}

func (r *recorder) add(ms float64, n int64, err bool) {
	r.mu.Lock()
	if err {
		r.errs++
	} else {
		r.lat = append(r.lat, ms)
		r.bytes += n
	}
	r.mu.Unlock()
}

func (r *recorder) take() ([]float64, int64, int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	l, e, b := r.lat, r.errs, r.bytes
	r.lat, r.errs, r.bytes = nil, 0, 0
	return l, e, b
}

func pct(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(math.Ceil(p/100*float64(len(sorted)))) - 1
	return math.Round(sorted[max(0, min(i, len(sorted)-1))]*10) / 10
}

// sampler polls the server's /proc and /metrics once per second.
type sampler struct {
	pid     int
	metrics string
	mu      sync.Mutex
	cpu     []float64
	rss     []float64
	prom    map[string][]float64
}

func clockTicks() float64 { return 100 } // USER_HZ on Linux

func procCPU(pid int) (float64, float64, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, err
	}
	f := strings.Fields(string(b[strings.LastIndexByte(string(b), ')')+2:]))
	ut, _ := strconv.ParseFloat(f[11], 64)
	st, _ := strconv.ParseFloat(f[12], 64)
	rssPages, _ := strconv.ParseFloat(f[21], 64)
	return (ut + st) / clockTicks(), rssPages * float64(os.Getpagesize()) / 1e6, nil
}

var watched = []string{
	"nodejs_eventloop_lag_p50_seconds", "nodejs_eventloop_lag_p99_seconds", "nodejs_eventloop_lag_max_seconds",
	"nodejs_active_handles_total", "go_goroutines", "go_gc_duration_seconds{quantile=\"1\"}",
	"go_gc_duration_seconds{quantile=\"0.75\"}", "go_gc_duration_seconds_count", "go_threads",
}

func (s *sampler) run(ctx context.Context) {
	cl := &http.Client{Timeout: 2 * time.Second}
	prevCPU, _, _ := procCPU(s.pid)
	prevT := time.Now()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if c, rss, err := procCPU(s.pid); err == nil {
			now := time.Now()
			s.mu.Lock()
			s.cpu = append(s.cpu, (c-prevCPU)/now.Sub(prevT).Seconds()*100)
			s.rss = append(s.rss, rss)
			s.mu.Unlock()
			prevCPU, prevT = c, now
		}
		if s.metrics == "" {
			continue
		}
		res, err := cl.Get(s.metrics)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		vals := map[string]float64{}
		for sc.Scan() {
			line := sc.Text()
			for _, w := range watched {
				if strings.HasPrefix(line, w+" ") {
					v, _ := strconv.ParseFloat(strings.Fields(line)[len(strings.Fields(line))-1], 64)
					vals[w] = v
				}
			}
		}
		res.Body.Close()
		s.mu.Lock()
		for k, v := range vals {
			s.prom[k] = append(s.prom[k], v)
		}
		s.mu.Unlock()
	}
}

// snapshot summarizes and resets the window.
func (s *sampler) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{}
	avgMax := func(v []float64) (float64, float64) {
		if len(v) == 0 {
			return 0, 0
		}
		sum, mx := 0.0, v[0]
		for _, x := range v {
			sum += x
			mx = math.Max(mx, x)
		}
		return math.Round(sum/float64(len(v))*10) / 10, math.Round(mx*10) / 10
	}
	out["cpuAvgPct"], out["cpuMaxPct"] = avgMax(s.cpu)
	_, out["rssMaxMB"] = avgMax(s.rss)
	for k, v := range s.prom {
		_, mx := avgMax(v)
		if strings.Contains(k, "seconds") && !strings.Contains(k, "count") {
			mx = 0
			for _, x := range v {
				mx = math.Max(mx, x*1000)
			}
			out[k+"_maxms"] = math.Round(mx*100) / 100
		} else if strings.HasSuffix(k, "_count") {
			if len(v) > 1 {
				out["go_gc_count_delta"] = v[len(v)-1] - v[0]
			}
		} else {
			out[k+"_max"] = mx
		}
	}
	s.cpu, s.rss, s.prom = nil, nil, map[string][]float64{}
	return out
}

func emit(v map[string]any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

// ---------------------------------------------------------------------------
// hls
// ---------------------------------------------------------------------------

func hlsMode(args []string) {
	fs := flag.NewFlagSet("hls", flag.ExitOnError)
	plURL := fs.String("url", "", "media or master playlist URL (a master resolves to its first variant)")
	ramp := fs.String("ramp", "100,500,1000,2500,5000,10000", "viewer steps")
	viewers := fs.Int("viewers", 0, "single fixed level instead of -ramp")
	hold := fs.Duration("hold", 30*time.Second, "measured hold per step")
	warm := fs.Duration("warm", 8*time.Second, "settle time after adding viewers (not measured)")
	timeout := fs.Duration("timeout", 10*time.Second, "per request")
	targetP95 := fs.Duration("target-p95", 2*time.Second, "segment p95 budget: a step above it is the knee")
	maxErr := fs.Float64("max-error", 2, "error-rate budget in percent: a step above it is the knee")
	untilKnee := fs.Bool("stop-at-knee", true, "stop the ramp at the first knee step")
	plan := fs.Bool("plan", false, "dry-run: print the ramp plan and exit (no traffic)")
	fs.BoolVar(&insecureTLS, "insecure", false, "skip TLS verification (self-signed origins)")
	srcIPs := fs.Int("srcips", 0, "loopback source IPs to bind round-robin (0 = kernel choice)")
	pid := fs.Int("pid", 0, "server pid")
	metrics := fs.String("metrics", "", "server /metrics URL")
	label := fs.String("label", "", "label")
	joinRate := fs.Float64("joinrate", 100, "new viewers per second while ramping")
	_ = fs.Parse(args)

	steps, err := rampSteps(*ramp, *viewers)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hls:", err)
		os.Exit(2)
	}
	if *plan {
		peak := steps[len(steps)-1]
		per := *warm + *hold
		fmt.Printf("DRY-RUN plan (no traffic sent)\n  url        : %s\n  steps      : %s viewers\n", orNone(*plURL), joinInts(steps, " -> "))
		fmt.Printf("  per step   : %s warm-up + %s measured  ·  total ≈ %s (+ joins at %.0f/s)\n", *warm, *hold, time.Duration(len(steps))*per, *joinRate)
		fmt.Printf("  knee when  : segment p95 > %s OR errors > %.1f%%\n", *targetP95, *maxErr)
		fmt.Printf("  peak load  : %d concurrent viewers from THIS process (one keep-alive conn each)\n", peak)
		fmt.Println("  note       : one machine caps absolute concurrency — run K copies for ~K× load")
		return
	}
	if *plURL == "" {
		fmt.Fprintln(os.Stderr, "hls: -url <m3u8> is required (or -plan)")
		os.Exit(2)
	}
	media, err := resolveMedia(*plURL, *timeout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hls:", err)
		os.Exit(1)
	}
	if media.String() != *plURL {
		fmt.Fprintln(os.Stderr, "hls: master playlist → media", media)
	}

	segRec, plRec := &recorder{}, &recorder{}
	var stalls atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &sampler{pid: *pid, metrics: *metrics, prom: map[string][]float64{}}
	go s.run(ctx)

	mediaURL := media.String()
	viewer := func(ctx context.Context, idx int) {
		cl := newClient(*srcIPs, 1, *timeout, idx)
		seen := -1
		for ctx.Err() == nil {
			t0 := time.Now()
			body, err := get(ctx, cl, mediaURL)
			noteErr(err)
			plRec.add(ms(t0), int64(len(body)), err != nil)
			if err == nil {
				segs, mseq, target := parsePlaylist(string(body))
				// a new viewer starts 3 segments from the live edge (hls.js)
				if seen < 0 {
					seen = mseq + len(segs) - 4
				}
				for i, name := range segs {
					n := mseq + i
					if n <= seen {
						continue
					}
					if n > seen+1 && seen >= 0 {
						stalls.Add(1) // skipped segments: fell behind the live window
					}
					t1 := time.Now()
					nb, err := drain(ctx, cl, resolveRef(media, name))
					if ctx.Err() != nil {
						return
					}
					noteErr(err)
					segRec.add(ms(t1), nb, err != nil)
					seen = n
				}
				// players re-poll a live playlist about every target duration
				if target <= 0 {
					target = 4
				}
				wait := time.Duration(target)*time.Second - time.Since(t0)
				if wait < 500*time.Millisecond {
					wait = 500 * time.Millisecond
				}
				sleep(ctx, wait)
			} else {
				sleep(ctx, time.Second)
			}
		}
	}

	var wg sync.WaitGroup
	running, knee := 0, 0
	for _, step := range steps {
		add := step - running
		// staggered joins (-joinrate/s): a burst of thousands of SYNs per
		// second is a connect storm, not an audience
		for i := 0; i < add; i++ {
			wg.Add(1)
			idx := running + i
			go func() { defer wg.Done(); viewer(ctx, idx) }()
			time.Sleep(time.Duration(float64(time.Second) / *joinRate))
		}
		running = max(running, step)
		time.Sleep(*warm)
		segRec.take()
		plRec.take()
		stalls.Store(0)
		takeErrKinds()
		s.snapshot()
		t0 := time.Now()
		time.Sleep(*hold)
		el := time.Since(t0).Seconds()
		lat, errs, bytes := segRec.take()
		pl, plErrs, _ := plRec.take()
		sort.Float64s(lat)
		sort.Float64s(pl)
		errPct := math.Round(float64(errs+plErrs)/math.Max(1, float64(len(lat)+len(pl))+float64(errs+plErrs))*1000) / 10
		p95 := pct(lat, 95)
		verdict := "ok"
		if isKnee(p95, errPct, *targetP95, *maxErr) {
			verdict = "knee"
		}
		out := map[string]any{
			"label": *label, "mode": "hls", "viewers": step, "segments": len(lat), "segErrors": errs,
			"segP50ms": pct(lat, 50), "segP95ms": p95, "segP99ms": pct(lat, 99), "segMaxms": pct(lat, 100),
			"playlistP95ms": pct(pl, 95), "playlistErrors": plErrs, "stalls": stalls.Load(),
			"errKinds":       takeErrKinds(),
			"throughputMBps": math.Round(float64(bytes)/el/1e6*10) / 10,
			"errorPct":       errPct,
			"verdict":        verdict,
		}
		for k, v := range s.snapshot() {
			out[k] = v
		}
		emit(out)
		if verdict == "knee" && knee == 0 {
			knee = step
			if *untilKnee {
				break
			}
		}
	}
	cancel()
	wg.Wait()
	if knee > 0 {
		fmt.Fprintf(os.Stderr, "hls: KNEE at ~%d concurrent viewers (segment p95 > %s or errors > %.1f%%); below that: healthy\n", knee, *targetP95, *maxErr)
	} else {
		fmt.Fprintf(os.Stderr, "hls: no knee up to %d viewers — raise -ramp, run more copies, or point at the edge\n", steps[len(steps)-1])
	}
}

// rampSteps is -viewers N (one level) or the ascending -ramp list.
func rampSteps(ramp string, viewers int) ([]int, error) {
	if viewers > 0 {
		return []int{viewers}, nil
	}
	var out []int
	for _, f := range strings.Split(ramp, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		n, err := strconv.Atoi(f)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("bad -ramp step %q", f)
		}
		out = append(out, n)
	}
	if len(out) == 0 {
		return nil, errors.New("empty -ramp")
	}
	return out, nil
}

// isKnee is the hls-loadtest.mjs criterion: p95 over budget OR error rate over budget.
func isKnee(segP95ms, errPct float64, target time.Duration, maxErrPct float64) bool {
	return segP95ms > float64(target.Milliseconds()) || errPct > maxErrPct
}

// resolveMedia fetches the playlist once; a master playlist resolves to its
// first variant (lowest/first listed — the most requests per byte).
func resolveMedia(raw string, timeout time.Duration) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("bad -url %q", raw)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	body, err := get(ctx, newClient(0, 1, timeout, 0), raw)
	if err != nil {
		return nil, fmt.Errorf("playlist fetch failed: %s: %w", raw, err)
	}
	if v := masterVariant(string(body)); v != "" {
		return u.Parse(v)
	}
	return u, nil
}

// masterVariant returns the URI after the first #EXT-X-STREAM-INF ("" for a
// media playlist).
func masterVariant(body string) string {
	lines := strings.Split(body, "\n")
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "#EXT-X-STREAM-INF") {
			for _, next := range lines[i+1:] {
				next = strings.TrimSpace(next)
				if next != "" && !strings.HasPrefix(next, "#") {
					return next
				}
			}
		}
	}
	return ""
}

// resolveRef resolves a playlist entry against the playlist URL (relative,
// root-relative or absolute URIs, query strings kept).
func resolveRef(base *url.URL, ref string) string {
	r, err := base.Parse(ref)
	if err != nil {
		return ref
	}
	return r.String()
}

func orNone(s string) string {
	if s == "" {
		return "<none>"
	}
	return s
}

func joinInts(v []int, sep string) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, sep)
}

func parsePlaylist(s string) ([]string, int, int) {
	var segs []string
	mseq, target := 0, 0
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			mseq, _ = strconv.Atoi(line[len("#EXT-X-MEDIA-SEQUENCE:"):])
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			target, _ = strconv.Atoi(line[len("#EXT-X-TARGETDURATION:"):])
		case line != "" && !strings.HasPrefix(line, "#"):
			segs = append(segs, line)
		}
	}
	return segs, mseq, target
}

func get(ctx context.Context, cl *http.Client, url string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	res, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return b, nil
}

var discardBufs = sync.Pool{New: func() any { b := make([]byte, 256<<10); return &b }}

// drain GETs url and discards the body (segments: no per-viewer buffers).
func drain(ctx context.Context, cl *http.Client, url string) (int64, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	res, err := cl.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	bp := discardBufs.Get().(*[]byte)
	n, err := io.CopyBuffer(io.Discard, res.Body, *bp)
	discardBufs.Put(bp)
	if err != nil {
		return n, err
	}
	if res.StatusCode != 200 {
		return n, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return n, nil
}

func ms(t time.Time) float64 { return float64(time.Since(t).Microseconds()) / 1000 }

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

type apiReq struct {
	name, method, path, body string
	weight                   int
}

func apiMode(args []string) {
	fs := flag.NewFlagSet("api", flag.ExitOnError)
	base := fs.String("base", "http://127.0.0.1:3410", "core base URL")
	token := fs.String("token", "", "bearer token")
	app := fs.String("app", "live", "app")
	rates := fs.String("rates", "100,250,500,1000,2000,4000", "RPS steps (open loop)")
	hold := fs.Duration("hold", 20*time.Second, "per step")
	conns := fs.Int("conns", 256, "max connections")
	maxInflight := fs.Int("inflight", 2000, "max in-flight requests (excess counted as dropped)")
	srcIPs := fs.Int("srcips", 0, "loopback source IPs to bind round-robin (0 = kernel choice)")
	pid := fs.Int("pid", 0, "server pid")
	metrics := fs.String("metrics", "", "server /metrics URL")
	label := fs.String("label", "", "label")
	duration := fs.Duration("duration", 0, "probe mode: run the FIRST rate for this long, one line per -hold window")
	_ = fs.Parse(args)

	mix := []apiReq{
		{"apps", "GET", "/api/v1/apps", "", 4},
		{"config", "GET", "/api/v1/apps/" + *app + "/config", "", 3},
		{"mintToken", "POST", "/api/v1/apps/" + *app + "/tokens", `{"room":"bench","identity":"u1","canPublish":false}`, 2},
		{"tokensList", "GET", "/api/v1/tokens", "", 1},
	}
	var wheel []apiReq
	for _, m := range mix {
		for i := 0; i < m.weight; i++ {
			wheel = append(wheel, m)
		}
	}
	clients := make([]*http.Client, max(1, *srcIPs))
	for i := range clients {
		clients[i] = newClient(*srcIPs, *conns/len(clients), 10*time.Second, i)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &sampler{pid: *pid, metrics: *metrics, prom: map[string][]float64{}}
	go s.run(ctx)

	all := &recorder{}
	kinds := map[string]*recorder{}
	for _, m := range mix {
		kinds[m.name] = &recorder{}
	}
	var inflight, dropped, sent atomic.Int64
	var status5xx, status4xx atomic.Int64
	do := func(i int, r apiReq) {
		defer inflight.Add(-1)
		var body io.Reader
		if r.body != "" {
			body = strings.NewReader(r.body)
		}
		req, _ := http.NewRequestWithContext(ctx, r.method, *base+r.path, body)
		req.Header.Set("Authorization", "Bearer "+*token)
		if r.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		t0 := time.Now()
		res, err := clients[i%len(clients)].Do(req)
		bad := err != nil
		noteErr(err)
		var n int64
		if err == nil {
			n, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode >= 500 {
				status5xx.Add(1)
				bad = true
			} else if res.StatusCode >= 400 {
				status4xx.Add(1)
				bad = true
			}
		} else if errors.Is(ctx.Err(), context.Canceled) {
			return
		}
		l := ms(t0)
		all.add(l, n, bad)
		kinds[r.name].add(l, n, bad)
	}
	runRate := func(rate int, d time.Duration) {
		interval := time.Second / time.Duration(rate)
		next := time.Now()
		end := next.Add(d)
		i := 0
		for time.Now().Before(end) {
			next = next.Add(interval)
			if w := time.Until(next); w > 0 {
				time.Sleep(w)
			}
			if inflight.Load() >= int64(*maxInflight) {
				dropped.Add(1)
				continue
			}
			inflight.Add(1)
			sent.Add(1)
			go do(i, wheel[i%len(wheel)])
			i++
		}
	}
	report := func(rate int, el float64) {
		lat, errs, _ := all.take()
		sort.Float64s(lat)
		out := map[string]any{
			"label": *label, "mode": "api", "targetRps": rate, "achievedRps": math.Round(float64(len(lat))/el*10) / 10,
			"ok": len(lat), "errors": errs, "http5xx": status5xx.Swap(0), "http4xx": status4xx.Swap(0), "dropped": dropped.Swap(0),
			"p50ms": pct(lat, 50), "p95ms": pct(lat, 95), "p99ms": pct(lat, 99), "maxms": pct(lat, 100),
		}
		per := map[string]any{}
		for k, r := range kinds {
			l, e, _ := r.take()
			sort.Float64s(l)
			per[k] = map[string]any{"n": len(l), "err": e, "p50": pct(l, 50), "p95": pct(l, 95), "p99": pct(l, 99)}
		}
		out["byKind"] = per
		out["errKinds"] = takeErrKinds()
		for k, v := range s.snapshot() {
			out[k] = v
		}
		emit(out)
	}
	if *duration > 0 {
		rate, _ := strconv.Atoi(strings.Split(*rates, ",")[0])
		deadline := time.Now().Add(*duration)
		for time.Now().Before(deadline) {
			all.take()
			s.snapshot()
			t0 := time.Now()
			runRate(rate, *hold)
			report(rate, time.Since(t0).Seconds())
		}
		return
	}
	for _, rs := range strings.Split(*rates, ",") {
		rate, _ := strconv.Atoi(rs)
		runRate(rate, 3*time.Second) // warm-up, discarded
		time.Sleep(500 * time.Millisecond)
		all.take()
		for _, r := range kinds {
			r.take()
		}
		status5xx.Store(0)
		status4xx.Store(0)
		dropped.Store(0)
		s.snapshot()
		t0 := time.Now()
		runRate(rate, *hold)
		// let the tail of this step finish (bounded)
		for w := 0; w < 50 && inflight.Load() > 0; w++ {
			time.Sleep(100 * time.Millisecond)
		}
		report(rate, time.Since(t0).Seconds())
	}
}
