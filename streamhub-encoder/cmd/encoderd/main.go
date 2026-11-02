// Command encoderd is the StreamHub Encoder control plane: REST API + web UI
// + Prometheus metrics + presets + persistent config + process supervisor of
// the GStreamer engines. Subcommands: serve (default), version, whip-push
// (internal: WHIP output process), tsanalyze, pipeline (dry run), token.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/api"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/caps"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/channel"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/config"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/notify"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/pipeline"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/scte35"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/streamhub"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/supervisor"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/tsbus"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/internal/whip"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-encoder/web"
)

var version = "0.0.1-dev"

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	cmd := "serve"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "version":
		fmt.Println(version)
	case "whip-push":
		err = whipPush(args)
	case "tsanalyze":
		err = tsAnalyze(args)
	case "pipeline":
		err = dryRun(args)
	case "token":
		err = printToken()
	default:
		err = fmt.Errorf("unknown command %q (serve|version|whip-push|tsanalyze|pipeline|token)", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "encoderd:", err)
		os.Exit(1)
	}
}

func dataDir() string { return env("ENCODERD_DATA_DIR", "/var/lib/streamhub-encoder") }

// apiToken returns ENCODERD_API_TOKEN or the persisted/generated token.
func apiToken() (string, error) {
	if t := os.Getenv("ENCODERD_API_TOKEN"); t != "" {
		return t, nil
	}
	p := filepath.Join(dataDir(), "api-token")
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		return strings.TrimSpace(string(b)), nil
	}
	if err := os.MkdirAll(dataDir(), 0o750); err != nil {
		return "", err
	}
	t := "ek_" + config.RandomHex(24)
	if err := os.WriteFile(p, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	return t, nil
}

func printToken() error {
	t, err := apiToken()
	if err == nil {
		fmt.Println(t)
	}
	return err
}

func parseRange(s string) (int, int) {
	a, b, ok := strings.Cut(s, "-")
	lo, e1 := strconv.Atoi(a)
	hi, e2 := strconv.Atoi(b)
	if !ok || e1 != nil || e2 != nil || lo < 1024 || hi > 65535 || hi-lo < 10 {
		return 41000, 41999
	}
	return lo, hi
}

func serve() error {
	level := slog.LevelInfo
	if env("ENCODERD_LOG_LEVEL", "info") == "debug" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	store, err := config.Open(filepath.Join(dataDir(), "encoderd.json"))
	if err != nil {
		return err
	}
	token, err := apiToken()
	if err != nil {
		return err
	}
	gstLaunch := env("ENCODERD_GST_LAUNCH", "gst-launch-1.0")
	gstInspect := env("ENCODERD_GST_INSPECT", "gst-inspect-1.0")
	ffmpeg := env("ENCODERD_FFMPEG", "ffmpeg")

	log.Info("probing host capabilities")
	report := caps.Probe(context.Background(), gstInspect, ffmpeg)
	var capMu sync.RWMutex
	getCaps := func() *caps.Report { capMu.RLock(); defer capMu.RUnlock(); return report }
	log.Info("capabilities", "gstreamer", report.GstVersion, "encoders", report.Encoders, "missing", report.Missing, "gpus", report.Devices.GPUs)
	if len(report.Missing) > 0 {
		log.Error("required GStreamer elements are missing; channels will fail to build", "missing", report.Missing)
	}

	self, _ := os.Executable()
	lo, hi := parseRange(env("ENCODERD_PORT_RANGE", "41000-41999"))
	cfg := store.Get()
	resolver := &streamhub.Resolver{DeviceID: cfg.Device.ID}
	var nc notify.Config
	if cfg.Settings.Notify != nil {
		nc = notify.Config(*cfg.Settings.Notify)
	}
	notifier := notify.New(nc, log)
	notifier.SetDevice(cfg.Device.ID)
	defer notifier.Close()
	mgr := channel.New(channel.Deps{Notify: notifier.Send, DeviceID: cfg.Device.ID,
		Store: store, Caps: capsProxy{getCaps}, Runner: supervisor.ExecRunner{SelfPath: self},
		GstLaunch: gstLaunch, FFmpeg: ffmpeg, Ports: channel.NewPortPool(lo, hi), Resolver: resolver, Log: log,
	})
	svc := &streamhub.Service{Store: store, Manager: mgr, Version: version, Model: "StreamHub Encoder", Log: log,
		AllowReboot: env("ENCODERD_ALLOW_REBOOT", "") == "true",
		Reboot:      func() error { return exec.Command("systemctl", "reboot").Run() },
		Caps: func() map[string]any {
			r := getCaps()
			encs := []string{}
			for _, e := range r.Encoders {
				encs = append(encs, e.Backend+"_"+e.Codec)
			}
			return map[string]any{"encoders": encs, "gpus": r.Devices.GPUs, "v4l2": r.Devices.V4L2, "decklink": r.Devices.DeckLink}
		}}
	metricsPublic := true
	if p := cfg.Settings.MetricsPublic; p != nil {
		metricsPublic = *p
	}
	if v := os.Getenv("ENCODERD_METRICS_PUBLIC"); v != "" {
		metricsPublic = v == "true"
	}
	au, initialPW, err := auth.New(auth.Options{DataDir: dataDir(), LegacyToken: token, MetricsPublic: metricsPublic,
		ExtraOperatorRoutes: []string{"POST /api/v1/channels/*/loudness/reset"}, ExtraAdminReadPrefixes: []string{"/api/v1/notify"},
		TrustedProxies: strings.Fields(strings.ReplaceAll(env("ENCODERD_TRUSTED_PROXIES", ""), ",", " ")), Logger: log})
	if err != nil {
		return err
	}
	defer au.Close()
	if initialPW != "" {
		log.Warn("created the initial admin account; the password is in the file below (change it at first login)",
			"user", "admin", "file", filepath.Join(dataDir(), "initial-admin-password"))
	}
	srv := &api.Server{Store: store, Manager: mgr, Caps: getCaps, Pairing: svc, Version: version, Auth: au, Notifier: notifier,
		Web: web.FS(), StartedAt: time.Now()}

	mgr.SyncAll()
	svc.Boot()
	// A hardware encoder can be missing at boot (driver still loading, GPU
	// busy/out of memory when nvcodec registered): re-probe every minute while
	// some channel is in error for a missing element, then reconcile.
	go func() {
		for range time.Tick(time.Minute) {
			missing := false
			for _, cs := range mgr.Status() {
				if cs.State == channel.StateError && strings.Contains(cs.Error, "is not available on this host") {
					missing = true
				}
			}
			if !missing {
				continue
			}
			r := caps.Probe(context.Background(), gstInspect, ffmpeg)
			capMu.Lock()
			report = r
			capMu.Unlock()
			log.Info("re-probed capabilities for channels waiting on a missing element", "encoders", r.Encoders)
			mgr.SyncAll()
		}
	}()

	listen := env("ENCODERD_LISTEN", ":8090")
	hs := &http.Server{Addr: listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	var certs *auth.CertReloader
	if env("ENCODERD_TLS", "auto") != "off" {
		tcfg, rl, err := auth.LoadOrCreateTLSReloader(dataDir(), env("ENCODERD_TLS_CERT", ""), env("ENCODERD_TLS_KEY", ""),
			strings.Fields(strings.ReplaceAll(env("ENCODERD_TLS_HOSTS", ""), ",", " ")))
		if err != nil {
			return err
		}
		hs.TLSConfig, certs = tcfg, rl
	}
	log.Info("encoderd listening", "addr", listen, "https", hs.TLSConfig != nil, "version", version, "data", dataDir())

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for s := range sig {
			if s == syscall.SIGHUP {
				log.Info("SIGHUP: re-probing capabilities")
				r := caps.Probe(context.Background(), gstInspect, ffmpeg)
				capMu.Lock()
				report = r
				capMu.Unlock()
				mgr.SyncAll()
				if certs != nil {
					if err := certs.Reload(); err != nil {
						log.Error("TLS reload failed", "err", err)
					}
				}
				continue
			}
			log.Info("shutting down", "signal", s.String())
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = hs.Shutdown(ctx)
			cancel()
			return
		}
	}()
	if hs.TLSConfig != nil {
		err = hs.ServeTLS(ln, "", "")
	} else {
		err = hs.Serve(ln)
	}
	mgr.Shutdown()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

type capsProxy struct{ get func() *caps.Report }

func (c capsProxy) Has(e string) bool { return c.get().Has(e) }

// whipPush is the WHIP output process: a GStreamer helper turns the bus TS
// into RTP on two loopback ports; pion forwards it to the WHIP endpoint.
func whipPush(args []string) error {
	fs := flag.NewFlagSet("whip-push", flag.ContinueOnError)
	busPort := fs.Int("bus-port", 0, "loopback UDP port with the channel TS")
	endpoint := fs.String("url", "", "WHIP endpoint")
	noAudio := fs.Bool("no-audio", false, "video only")
	gst := fs.String("gst-launch", env("ENCODERD_GST_LAUNCH", "gst-launch-1.0"), "gst-launch-1.0 path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *busPort == 0 || *endpoint == "" {
		return errors.New("--bus-port and --url are required")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	vc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer vc.Close()
	var ac net.PacketConn
	ap := 0
	if !*noAudio {
		if ac, err = net.ListenPacket("udp", "127.0.0.1:0"); err != nil {
			return err
		}
		defer ac.Close()
		ap = ac.LocalAddr().(*net.UDPAddr).Port
	}
	vp := vc.LocalAddr().(*net.UDPAddr).Port
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	helper := exec.CommandContext(ctx, *gst, pipeline.LaunchArgs(pipeline.WHIPHelper(*busPort, vp, ap, !*noAudio))...)
	// gst-launch prints element warnings on stdout: scan both streams.
	hErr, hOut := io.Pipe()
	helper.Stdout, helper.Stderr = hOut, hOut
	helper.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if err := helper.Start(); err != nil {
		return err
	}
	// gst-launch links tsdemux pads once. When the program changes (the engine
	// starting up announces audio a moment after video, or restarts), the new
	// pads stay unlinked, tsdemux stops and no RTP flows. Detect it and exit
	// so the supervisor renegotiates in ~1 s instead of the 30 s RTP timeout.
	relink := make(chan struct{}, 1)
	go func() {
		sc := bufio.NewScanner(hErr)
		for sc.Scan() {
			line := sc.Text()
			fmt.Fprintln(os.Stderr, line)
			if strings.Contains(line, "Delayed linking failed") {
				select {
				case relink <- struct{}{}:
				default:
				}
			}
		}
	}()
	helperDone := make(chan error, 1)
	go func() {
		err := helper.Wait()
		_ = hOut.Close()
		helperDone <- err
	}()
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pubDone := make(chan error, 1)
	opts := whip.Options{URL: *endpoint, Bearer: os.Getenv("ENCODERD_WHIP_BEARER"), Video: vc, Log: log}
	if ac != nil {
		opts.Audio = ac
	}
	go func() { pubDone <- whip.Publish(pctx, opts) }()
	select {
	case <-relink:
		cancel()
		<-pubDone
		_ = helper.Process.Kill()
		<-helperDone
		return errors.New("gst helper lost a stream on a TS program change; restarting the session")
	case err := <-helperDone:
		cancel()
		<-pubDone
		return fmt.Errorf("gst helper exited: %v", err)
	case err := <-pubDone:
		_ = helper.Process.Signal(syscall.SIGINT)
		select {
		case <-helperDone:
		case <-time.After(3 * time.Second):
			_ = helper.Process.Kill()
		}
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
}

func tsAnalyze(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: encoderd tsanalyze <file.ts|->")
	}
	f := os.Stdin
	if args[0] != "-" {
		var err error
		if f, err = os.Open(args[0]); err != nil {
			return err
		}
		defer f.Close()
	}
	st, err := tsbus.AnalyzeReader(f)
	res := struct {
		tsbus.Stats
		SCTE35 []scte35.Info `json:"scte35,omitempty"`
	}{Stats: st}
	if args[0] != "-" {
		if raw, rerr := os.ReadFile(args[0]); rerr == nil {
			res.SCTE35, _ = scte35.ExtractSections(raw)
		}
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(b))
	return err
}

// dryRun prints the pipelines for a channel JSON (all elements assumed present
// unless ENCODERD_DRYRUN_PROBE=1).
func dryRun(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: encoderd pipeline <channel.json>")
	}
	b, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	var ch config.Channel
	if err := json.Unmarshal(b, &ch); err != nil {
		return err
	}
	ch.ApplyDefaults()
	var c pipeline.Caps = pipeline.AllCaps{}
	if os.Getenv("ENCODERD_DRYRUN_PROBE") == "1" {
		c = caps.Probe(context.Background(), env("ENCODERD_GST_INSPECT", "gst-inspect-1.0"), env("ENCODERD_FFMPEG", "ffmpeg"))
	}
	eng, err := pipeline.BuildEngine(ch, 40000, c)
	if err != nil {
		return err
	}
	if len(eng.Feeder) > 0 {
		fmt.Printf("# engine (%s), fed by ffmpeg on stdin\nffmpeg %s | \\\n", eng.Element, strings.Join(eng.Feeder, " "))
	} else {
		fmt.Printf("# engine (%s)\n", eng.Element)
	}
	fmt.Printf("gst-launch-1.0 -e '%s'\n", eng.Description)
	for i, o := range ch.Outputs {
		if o.Type == config.OutStreamHub {
			fmt.Printf("# output %s: streamhub (resolved at runtime)\n", o.ID)
			continue
		}
		cmd, err := pipeline.BuildOutput(ch, o, 40001+i, time.Now())
		if err != nil {
			return fmt.Errorf("output %s: %w", o.ID, err)
		}
		fmt.Printf("# output %s (%s)\n%s %q\n", o.ID, o.Type, cmd.Path, cmd.Args)
	}
	return nil
}
