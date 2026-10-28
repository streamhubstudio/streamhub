package system

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/testutil"
)

// Ports gpu.service.spec.ts, hwaccel.service.spec.ts,
// settings.service.spec.ts and os-tuning.service.spec.ts.

type nopLogs struct{ n atomic.Int32 }

func (l *nopLogs) Write(string, string, string, any, *int64) { l.n.Add(1) }

type fakeRunner struct {
	routes map[string]string // bin → stdout; missing = ENOENT
	calls  atomic.Int32
}

func (f *fakeRunner) Run(_ context.Context, bin string, _ ...string) (string, error) {
	f.calls.Add(1)
	out, ok := f.routes[bin]
	if !ok {
		return "", errors.New("ENOENT: " + bin)
	}
	return out, nil
}

func noDri(string) ([]string, error) { return nil, errors.New("ENOENT: /dev/dri") }

func dri(names ...string) DirReader {
	return func(string) ([]string, error) { return names, nil }
}

func gpuWith(t *testing.T, routes map[string]string, rd DirReader) (*Gpu, *fakeRunner) {
	t.Setenv("GPU_DISABLE", "")
	r := &fakeRunner{routes: routes}
	return NewGpu(&config.Config{}, r, rd, &nopLogs{}), r
}

func TestGpuProbe(t *testing.T) {
	ctx := context.Background()
	t.Run("none when nothing is present — never fails", func(t *testing.T) {
		g, _ := gpuWith(t, nil, noDri)
		s := g.Status(ctx)
		if s.Available || s.Type != "none" || len(s.Devices) != 0 || s.Detail != "no NVIDIA (nvidia-smi) and no VAAPI (/dev/dri render node)" {
			t.Fatalf("%+v", s)
		}
		if b, _ := json.Marshal(s); !strings.Contains(string(b), `"devices":[]`) || strings.Contains(string(b), "driver") {
			t.Fatalf("json %s", b)
		}
	})
	t.Run("nvidia from CSV", func(t *testing.T) {
		g, _ := gpuWith(t, map[string]string{"nvidia-smi": "0, NVIDIA GeForce RTX 3090, 24576, 550.90.07\n1, Tesla T4, x, 550.90.07\n"}, noDri)
		s := g.Status(ctx)
		if !s.Available || s.Type != "nvidia" || len(s.Devices) != 2 || s.Driver != "550.90.07" || s.Detail != "nvidia-smi reported 2 GPU(s)" {
			t.Fatalf("%+v", s)
		}
		if *s.Devices[0].Index != 0 || *s.Devices[0].MemoryMiB != 24576 || s.Devices[1].MemoryMiB != nil {
			t.Fatalf("%+v", s.Devices)
		}
	})
	t.Run("vaapi fallback with vainfo driver", func(t *testing.T) {
		g, _ := gpuWith(t, map[string]string{"vainfo": "vainfo: Driver version: Intel iHD driver 23.1\n"}, dri("card0", "renderD129", "renderD128"))
		s := g.Status(ctx)
		if s.Type != "vaapi" || len(s.Devices) != 2 || s.Devices[0].Name != "/dev/dri/renderD128" || s.Driver != "Intel iHD driver 23.1" {
			t.Fatalf("%+v", s)
		}
	})
	t.Run("nvidia preferred over vaapi", func(t *testing.T) {
		g, _ := gpuWith(t, map[string]string{"nvidia-smi": "0, A100, 40960, 535\n"}, dri("renderD128"))
		if s := g.Status(ctx); s.Type != "nvidia" {
			t.Fatal(s.Type)
		}
	})
	t.Run("GPU_DISABLE=true", func(t *testing.T) {
		g, _ := gpuWith(t, map[string]string{"nvidia-smi": "0, A100, 40960, 535\n"}, noDri)
		t.Setenv("GPU_DISABLE", "TRUE")
		if s := g.Status(ctx); s.Available || s.Detail != "disabled via GPU_DISABLE=true" {
			t.Fatalf("%+v", s)
		}
	})
	t.Run("cached; refresh re-probes", func(t *testing.T) {
		g, r := gpuWith(t, nil, noDri)
		g.Status(ctx)
		g.Status(ctx)
		if r.calls.Load() != 1 {
			t.Fatal("status must cache")
		}
		g.Refresh(ctx)
		if r.calls.Load() != 2 {
			t.Fatal("refresh must re-probe")
		}
	})
	t.Run("malformed nvidia-smi output", func(t *testing.T) {
		g, _ := gpuWith(t, map[string]string{"nvidia-smi": "garbage\n\n,,\n"}, noDri)
		if s := g.Status(ctx); s.Available {
			t.Fatalf("%+v", s)
		}
	})
}

func hwWith(t *testing.T, gpuAvailable bool) (*HwAccel, string) {
	t.Helper()
	t.Setenv("TRANSCODING_HWACCEL", "")
	t.Setenv("GPU_DISABLE", "")
	dir := t.TempDir()
	routes := map[string]string{}
	rd := noDri
	if gpuAvailable {
		rd = dri("renderD128")
	}
	cfg := &config.Config{DataDir: dir}
	g := NewGpu(cfg, &fakeRunner{routes: routes}, rd, &nopLogs{})
	return NewHwAccel(cfg, g, &nopLogs{}), dir
}

func TestHwAccelModes(t *testing.T) {
	h, dir := hwWith(t, false)
	if h.GetMode("live") != "auto" {
		t.Fatal("default auto")
	}
	t.Setenv("TRANSCODING_HWACCEL", "CPU")
	if h.GetMode("live") != "cpu" {
		t.Fatal("env default")
	}
	if _, err := h.SetMode("live", "gpu"); err != nil || h.GetMode("live") != "gpu" {
		t.Fatal("sidecar round-trip")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "apps", "live", "transcoding.json"))
	if string(raw) != "{\n  \"hwaccel\": \"gpu\"\n}" {
		t.Fatalf("sidecar bytes %q", raw)
	}
	if _, err := h.SetMode("live", "turbo"); err == nil || err.Error() != `invalid hwaccel mode "turbo"` {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "apps", "live", "transcoding.json"), []byte("{nope"), 0o644)
	if h.GetMode("live") != "cpu" {
		t.Fatal("corrupt sidecar → default")
	}
}

func TestHwAccelResolve(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		mode      string
		gpu       bool
		effective string
		typ       string
		reason    string
	}{
		{"cpu", true, "cpu", "none", "app configured hwaccel=cpu"},
		{"gpu", true, "gpu", "vaapi", "hwaccel=gpu and vaapi GPU available"},
		{"gpu", false, "cpu", "none", "hwaccel=gpu but no GPU detected — CPU fallback"},
		{"auto", true, "gpu", "vaapi", "hwaccel=auto resolved to vaapi GPU"},
		{"auto", false, "cpu", "none", "hwaccel=auto and no GPU detected — CPU"},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			h, _ := hwWith(t, c.gpu)
			_, _ = h.SetMode("live", c.mode)
			d := h.Resolve(ctx, "live")
			if d.Requested != c.mode || d.Effective != c.effective || d.Type != c.typ || d.Reason != c.reason {
				t.Fatalf("%+v", d)
			}
			enc, _ := h.EgressOptions(ctx, "live")
			preset, _ := h.IngressOptions(ctx, "live")
			if (enc != nil) != (c.effective == "gpu") || (preset != "") != (c.effective == "gpu") {
				t.Fatal("options only when GPU is chosen")
			}
			if enc != nil && (enc.Width != 1280 || enc.Height != 720 || enc.Framerate != 30 || enc.VideoBitrate != 3000) {
				t.Fatalf("%+v", enc)
			}
		})
	}
}

type recMetrics struct{ kind, eff, typ string }

func (r *recMetrics) RecordTranscode(kind, eff, typ string) { r.kind, r.eff, r.typ = kind, eff, typ }

func TestHwAccelRecordUsage(t *testing.T) {
	h, _ := hwWith(t, false)
	h.RecordUsage("egress", HwaccelDecision{Effective: "cpu", Type: "none"}) // no metrics: no-op
	m := &recMetrics{}
	h.SetMetrics(m)
	h.RecordUsage("egress", HwaccelDecision{Effective: "gpu", Type: "nvidia"})
	if *m != (recMetrics{"egress", "gpu", "nvidia"}) {
		t.Fatalf("%+v", m)
	}
}

// ---- settings ------------------------------------------------------------

var secrets = map[string]string{
	"STREAMHUB_JWT_SECRET":    "JWTSECRET_NEVER_EXPOSE",
	"LIVEKIT_API_SECRET":      "LKSECRET_NEVER_EXPOSE",
	"ADMIN_PASS":              "ADMINPASS_NEVER_EXPOSE",
	"STREAMHUB_CLUSTER_TOKEN": "CLUSTERTOKEN_NEVER_EXPOSE",
	"STREAMHUB_SMTP_PASS":     "SMTPPASS_NEVER_EXPOSE",
	"METRICS_TOKEN":           "METRICSTOKEN_NEVER_EXPOSE",
	"REDIS_PASSWORD":          "REDISPASS_NEVER_EXPOSE",
}

func settingsWith(t *testing.T, over map[string]string) ServerSettings {
	t.Helper()
	env := map[string]string{
		"NODE_ENV": "production", "PORT": "3020", "HOST": "127.0.0.1", "PUBLIC_BASE_URL": "https://media.example.com",
		"PUBLIC_WS_URL": "wss://public.example.com", "RTMP_PUBLIC_HOST": "rtmp.example.com", "LOG_LEVEL": "info",
		"LOG_RETENTION_DAYS": "30", "STREAMHUB_AUTHZ_ENFORCE": "on", "REDIS_URL": "redis://:" + secrets["REDIS_PASSWORD"] + "@redis-host:6390",
		"LIVEKIT_URL": "ws://127.0.0.1:7880", "LIVEKIT_API_KEY": "APIkey1234567", "ADMIN_USER": "root",
		"STREAMHUB_SMTP_HOST": "smtp.example.com", "STREAMHUB_SUPERADMIN_EMAIL": "Owner@Example.com",
		"STREAMHUB_CLUSTER_REDIS_URL": "redis://cluster:6379",
	}
	for k, v := range secrets {
		env[k] = v
	}
	for k, v := range over {
		env[k] = v
	}
	store, g, dir := testutil.Store(t)
	env["DATA_DIR"] = dir
	for k, v := range env {
		t.Setenv(k, v)
	}
	return NewSettings(config.Load(), store, g).Get(context.Background())
}

func TestSettingsShapeAndValues(t *testing.T) {
	s := settingsWith(t, nil)
	if s.Core.NodeEnv != "production" || s.Core.Port != 3020 || s.Core.PublicBaseURL != "https://media.example.com" ||
		s.Core.LogRetentionDays != 30 || s.Core.AuthzEnforce != "on" || s.Core.RedisURL != "redis-host:6390" {
		t.Fatalf("%+v", s.Core)
	}
	if s.Livekit.URL != "ws://127.0.0.1:7880" || s.Livekit.APIKeyMasked != "APIkey…" || s.Auth.AdminUser != "root" || s.Auth.SuperadminEmail != "owner@example.com" {
		t.Fatalf("%+v %+v", s.Livekit, s.Auth)
	}
	if !s.Auth.JWTSecretSet || !s.Auth.AdminPassSet || !s.Auth.SMTPConfigured || !s.Livekit.APIKeySet ||
		!s.Cluster.Enabled || !s.Cluster.RedisConfigured || !s.Metrics.TokenSet {
		t.Fatal("every secret reported as set")
	}
	if s.Ports != (PortsSettings{3020, 7880, 7881, 7882, 1935, 8080}) {
		t.Fatalf("%+v", s.Ports)
	}
	for _, g := range []string{"core", "auth", "livekit", "cluster", "metrics", "storage"} {
		if len(s.Guidance[g]) == 0 {
			t.Fatalf("guidance %s empty", g)
		}
	}
	if s.Guidance["core"][0].HowToChange != "El core escucha en 127.0.0.1:PORT detrás de Caddy/nginx. Editá `PORT` en el archivo `.env` del server (p. ej. `/home/ploi/skyline-core/.env`) y "+restartHint {
		t.Fatal(s.Guidance["core"][0].HowToChange)
	}
	var keys map[string]map[string]any
	b, _ := json.Marshal(s)
	_ = json.Unmarshal(b, &keys)
	if len(keys) != 10 || len(keys["core"]) != 11 || len(keys["auth"]) != 5 || len(keys["runtime"]) != 4 {
		t.Fatalf("shape %s", b)
	}
}

func TestSettingsUnset(t *testing.T) {
	s := settingsWith(t, map[string]string{
		"STREAMHUB_JWT_SECRET": "", "ADMIN_PASS": "", "LIVEKIT_API_KEY": "", "LIVEKIT_API_SECRET": "", "STREAMHUB_CLUSTER_TOKEN": "",
		"STREAMHUB_CLUSTER_REDIS_URL": "", "STREAMHUB_SMTP_PASS": "", "METRICS_TOKEN": "", "STREAMHUB_AUTHZ_ENFORCE": "bogus",
	})
	if s.Auth.JWTSecretSet || s.Auth.AdminPassSet || s.Auth.SMTPConfigured || s.Livekit.APIKeySet || s.Livekit.APIKeyMasked != "" ||
		s.Cluster.Enabled || s.Cluster.RedisConfigured || s.Metrics.TokenSet || s.Core.AuthzEnforce != "log" {
		t.Fatalf("%+v", s)
	}
}

func TestSettingsRedaction(t *testing.T) {
	b, _ := json.Marshal(settingsWith(t, nil))
	for _, v := range secrets {
		if strings.Contains(string(b), v) {
			t.Fatalf("leaked %s", v)
		}
	}
	for _, k := range []string{"jwtSecret", "apiSecret", "livekitApiSecret", "adminPass", "clusterToken", "smtpPass", "metricsToken", "password"} {
		if strings.Contains(string(b), `"`+k+`"`) {
			t.Fatalf("raw key %s", k)
		}
	}
	odd := settingsWith(t, map[string]string{"REDIS_URL": "redis://user:PWLEAK_NEVER@host:6379/0"})
	if odd.Core.RedisURL != "host:6379" {
		t.Fatal(odd.Core.RedisURL)
	}
}

func TestRedisHostPort(t *testing.T) {
	for in, want := range map[string]string{
		"":                          "",
		"redis://127.0.0.1:63999":   "127.0.0.1:63999",
		"redis://h":                 "h:6379",
		"redis://:p@h:1/2":          "h:1",
		"not a url user:pw@h:9/x y": "h:9",
	} {
		if got := redisHostPort(in); got != want {
			t.Errorf("%q → %q want %q", in, got, want)
		}
	}
}

// ---- os tuning -------------------------------------------------------------

type fakeReader struct {
	platform string
	values   map[string]*string
}

func (f fakeReader) Platform() string { return f.platform }
func (f fakeReader) Read(_, key string) *string {
	return f.values[key]
}

func sp(s string) *string { return &s }

func good() map[string]*string {
	return map[string]*string{
		"net.core.rmem_max": sp("16777216"), "net.core.wmem_max": sp("16777216"), "net.core.somaxconn": sp("4096"),
		"net.ipv4.udp_mem": sp("65536 131072 262144"), "net.ipv4.ip_local_port_range": sp("1024 65535"),
		"fs.file-max": sp("1048576"), "Max open files": sp("200000"), "vm.swappiness": sp("10"),
		"/sys/kernel/mm/transparent_hugepage/enabled": sp("always [madvise] never"),
	}
}

func statusOf(t *testing.T, key string, val *string, id string) string {
	t.Helper()
	v := good()
	v[key] = val
	for _, k := range BuildReport(fakeReader{"linux", v}, time.Now()).Knobs {
		if k.ID == id {
			return k.Status
		}
	}
	t.Fatalf("knob %s missing", id)
	return ""
}

func TestOsTuningVerdicts(t *testing.T) {
	r := BuildReport(fakeReader{"linux", good()}, time.Now())
	if r.Summary != (OsTuningSummary{Applied: len(Knobs)}) || !r.Supported || !strings.HasPrefix(r.Note, "install.sh applies") {
		t.Fatalf("%+v", r.Summary)
	}
	cases := []struct {
		key, val, id, want string
	}{
		{"net.core.rmem_max", "212992", "net.core.rmem_max", "not-applied"},
		{"net.core.wmem_max", "212992", "net.core.wmem_max", "not-applied"},
		{"net.core.rmem_max", "16777215", "net.core.rmem_max", "not-applied"},
		{"net.core.rmem_max", "16777216", "net.core.rmem_max", "applied"},
		{"vm.swappiness", "60", "vm.swappiness", "not-applied"},
		{"vm.swappiness", "1", "vm.swappiness", "applied"},
		{"net.core.somaxconn", "128", "net.core.somaxconn", "not-applied"},
		{"fs.file-max", "9223372036854775807", "fs.file-max", "applied"},
		{"fs.file-max", "99999999999999999999", "fs.file-max", "applied"},
		{"fs.file-max", "65536", "fs.file-max", "not-applied"},
		{"net.ipv4.udp_mem", "65536 131072 131072", "net.ipv4.udp_mem", "not-applied"},
		{"net.ipv4.udp_mem", "65536 131072 524288", "net.ipv4.udp_mem", "applied"},
		{"net.ipv4.udp_mem", "65536 131072", "net.ipv4.udp_mem", "unknown"},
		{"net.ipv4.ip_local_port_range", "50000 65535", "net.ipv4.ip_local_port_range", "not-applied"},
		{"net.ipv4.ip_local_port_range", "1024", "net.ipv4.ip_local_port_range", "unknown"},
		{"Max open files", "1024", "nofile", "not-applied"},
		{"Max open files", "65535", "nofile", "applied"},
		{"Max open files", "unlimited", "nofile", "applied"},
		{"/sys/kernel/mm/transparent_hugepage/enabled", "[always] madvise never", "transparent_hugepage", "not-applied"},
		{"/sys/kernel/mm/transparent_hugepage/enabled", "always madvise [never]", "transparent_hugepage", "applied"},
		{"net.core.rmem_max", "not-a-number", "net.core.rmem_max", "unknown"},
		{"net.core.rmem_max", "   ", "net.core.rmem_max", "unknown"},
	}
	for _, c := range cases {
		if got := statusOf(t, c.key, sp(c.val), c.id); got != c.want {
			t.Errorf("%s=%q: %s want %s", c.key, c.val, got, c.want)
		}
	}
	if statusOf(t, "net.core.rmem_max", nil, "net.core.rmem_max") != "unknown" {
		t.Error("missing → unknown")
	}
	for _, k := range r.Knobs {
		if k.Recommended == "" || k.Remedy == "" || k.Why == "" || k.Label == "" {
			t.Errorf("%s incomplete", k.ID)
		}
		if k.Optional != (k.ID == "transparent_hugepage") {
			t.Errorf("%s optional=%v", k.ID, k.Optional)
		}
	}
}

func TestOsTuningNonLinux(t *testing.T) {
	r := BuildReport(fakeReader{"darwin", good()}, time.Now())
	if r.Supported || r.Platform != "darwin" || r.Summary != (OsTuningSummary{Unknown: len(Knobs)}) || !strings.Contains(strings.ToLower(r.Note), "non-linux") {
		t.Fatalf("%+v", r)
	}
	for _, k := range r.Knobs {
		if k.Status != "unknown" || k.Current != nil {
			t.Fatalf("%+v", k)
		}
	}
	if SysctlPath("net.core.rmem_max") != "/proc/sys/net/core/rmem_max" {
		t.Fatal("sysctl path")
	}
	// live host: never fails, mirrors the platform
	live := OsTuning{}.Report()
	if len(live.Knobs) != len(Knobs) {
		t.Fatal("live report")
	}
}
