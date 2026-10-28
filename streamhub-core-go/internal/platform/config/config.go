// Package config is the typed view of the streamhub-core environment
// (SPEC §13). It mirrors streamhub-core/src/shared/config/config.service.ts
// 1:1 — same variable names, same defaults, same parsing rules — so an
// existing .env boots the Go core unchanged. The environment is read once at
// construction; secrets are never logged.
package config

import (
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Config holds every core setting. See https://streamhub.studio/docs/operations/ENV.
type Config struct {
	Port     int
	Host     string
	NodeEnv  string
	LogLevel string

	LivekitURL       string
	LivekitAPIKey    string
	LivekitAPISecret string
	PublicWsURL      string
	RtmpPublicHost   string

	// RTMPS TLS front (stunnel profile). Off by default.
	RtmpsEnable     bool
	RtmpsPort       int
	RtmpsPublicHost string

	// RTMP→HLS passthrough remux (features/rtmp-passthrough.md). Off by default.
	RtmpPassthroughEnable bool
	RtmpPassthroughPort   int

	// Single-port :1935 via MediaMTX (features/rtmp-single-port.md).
	MediamtxEnable         bool
	MediamtxRtmpPort       int
	MediamtxAPIURL         string
	LivekitIngressRtmpPort int
	MediamtxHookSecret     string

	// IngestProfile is "livekit" (default) or "efficient".
	IngestProfile string
	// PublicBaseURL builds absolute public URLs (HLS, WS ingest provisioning,
	// passthrough, grid worker origin): PUBLIC_BASE_URL, else
	// STREAMHUB_PUBLIC_URL (the one install.sh writes); empty = relative URLs.
	PublicBaseURL string
	// SamplesURL is STREAMHUB_SAMPLES_URL reduced to an origin
	// (scheme://host[:port]). When set, /samples/* is served only on that
	// host, so tenant-editable sample HTML never runs on the dashboard's
	// origin (features/samples.md). Empty = samples share the dashboard
	// origin (and sample:write stays superadmin-only). An invalid value, or
	// one equal to PublicBaseURL's origin, is treated as unset.
	SamplesURL string

	RedisURL  string
	JWTSecret string

	ClusterToken    string
	ClusterRedisURL string

	// Break-glass UI login. Login is disabled if unset.
	AdminUser string
	AdminPass string

	// DataDir holds data/streamhub.db, apps/<name>/, logs/.
	DataDir string

	LogRetentionDays int

	NotifyDiscordWebhook   string
	NotifyTelegramBotToken string
	NotifyTelegramChatID   string
}

// Load reads the process environment.
func Load() *Config {
	cwd, _ := os.Getwd()
	profile := "livekit"
	if strings.ToLower(strings.TrimSpace(str("STREAMHUB_INGEST_PROFILE", "livekit"))) == "efficient" {
		profile = "efficient"
	}
	publicBase := str("PUBLIC_BASE_URL", str("STREAMHUB_PUBLIC_URL", ""))
	samples := Origin(str("STREAMHUB_SAMPLES_URL", ""))
	if samples != "" && samples == Origin(publicBase) {
		samples = ""
	}
	return &Config{
		Port:     integer("PORT", 3020),
		Host:     str("HOST", "127.0.0.1"),
		NodeEnv:  str("NODE_ENV", "development"),
		LogLevel: str("LOG_LEVEL", "info"),

		LivekitURL:       str("LIVEKIT_URL", "ws://127.0.0.1:7880"),
		LivekitAPIKey:    str("LIVEKIT_API_KEY", ""),
		LivekitAPISecret: str("LIVEKIT_API_SECRET", ""),
		PublicWsURL:      str("PUBLIC_WS_URL", ""),
		RtmpPublicHost:   str("RTMP_PUBLIC_HOST", ""),

		RtmpsEnable:     boolean("STREAMHUB_RTMPS_ENABLE", false),
		RtmpsPort:       integer("STREAMHUB_RTMPS_PORT", 1936),
		RtmpsPublicHost: str("RTMPS_PUBLIC_HOST", ""),

		RtmpPassthroughEnable: boolean("STREAMHUB_RTMP_PASSTHROUGH_ENABLE", false),
		RtmpPassthroughPort:   integer("STREAMHUB_RTMP_PASSTHROUGH_PORT", 1937),

		MediamtxEnable:         boolean("STREAMHUB_MEDIAMTX_ENABLE", false),
		MediamtxRtmpPort:       integer("STREAMHUB_MEDIAMTX_RTMP_PORT", 1935),
		MediamtxAPIURL:         str("STREAMHUB_MEDIAMTX_API_URL", "http://127.0.0.1:9997"),
		LivekitIngressRtmpPort: integer("STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT", 11935),
		MediamtxHookSecret:     str("STREAMHUB_MEDIAMTX_HOOK_SECRET", ""),

		IngestProfile: profile,
		PublicBaseURL: publicBase,
		SamplesURL:    samples,

		RedisURL:  str("REDIS_URL", "redis://localhost:6379"),
		JWTSecret: str("STREAMHUB_JWT_SECRET", ""),

		ClusterToken:    str("STREAMHUB_CLUSTER_TOKEN", ""),
		ClusterRedisURL: str("STREAMHUB_CLUSTER_REDIS_URL", ""),

		AdminUser: str("ADMIN_USER", ""),
		AdminPass: str("ADMIN_PASS", ""),

		DataDir: str("DATA_DIR", cwd),

		LogRetentionDays: max(integer("LOG_RETENTION_DAYS", 30), 0),

		NotifyDiscordWebhook:   str("STREAMHUB_NOTIFY_DISCORD_WEBHOOK", ""),
		NotifyTelegramBotToken: str("STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN", ""),
		NotifyTelegramChatID:   str("STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID", ""),
	}
}

// SamplesIsolated reports that samples are served from their own origin.
func (c *Config) SamplesIsolated() bool { return c.SamplesURL != "" }

// Origin reduces an absolute http(s) URL to scheme://host[:port] (lower-case,
// no path, no trailing slash); anything else yields "".
func Origin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.User != nil {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.ToLower(u.Host)
	if (scheme == "https" && u.Port() == "443") || (scheme == "http" && u.Port() == "80") {
		host = strings.ToLower(u.Hostname())
	}
	return scheme + "://" + host
}

// IsProduction reports NODE_ENV=production (kept as the env switch for parity).
func (c *Config) IsProduction() bool { return c.NodeEnv == "production" }

// Env is the raw getter for ad-hoc variables (secret refs like access_key_env).
func (c *Config) Env(name string) string { return os.Getenv(name) }

// EnvBool applies the shared truthy grammar to an ad-hoc variable.
func (c *Config) EnvBool(name string, fallback bool) bool { return boolean(name, fallback) }

func str(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// integer mirrors Number.parseInt: leading digits are parsed, junk → fallback.
func integer(name string, fallback int) int {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	if n, ok := ParseIntPrefix(v); ok {
		return n
	}
	return fallback
}

var truthy = regexp.MustCompile(`(?i)^(1|true|on|yes)$`)

// boolean: 1/true/on/yes (case-insensitive) is true; anything else is false.
func boolean(name string, fallback bool) bool {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	return truthy.MatchString(strings.TrimSpace(v))
}

// Truthy applies the shared 1/true/on/yes grammar to an arbitrary string.
func Truthy(v string) bool { return truthy.MatchString(strings.TrimSpace(v)) }

var intPrefix = regexp.MustCompile(`^\s*[+-]?\d+`)

// ParseIntPrefix behaves like JS Number.parseInt(v, 10): it accepts leading
// whitespace and a sign, parses the leading digit run and ignores the rest.
func ParseIntPrefix(v string) (int, bool) {
	m := intPrefix.FindString(v)
	if m == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(m))
	if err != nil {
		return 0, false
	}
	return n, true
}
