package system

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/version"
)

// Well-known LiveKit/media ports (host-networked, not env-driven).
const (
	livekitSignalingPort = 7880
	livekitTCPPort       = 7881
	livekitUDPPort       = 7882
	rtmpPort             = 1935
	whipPort             = 8080

	smtpHostDefault        = "mail.wipermax.online"
	superadminEmailDefault = "info@streamhub.studio"
	restartHint            = "reiniciá el core: `systemctl restart streamhub-core` (alias en prod: `skyline-core`)."
)

// started approximates process.uptime().
var started = time.Now()

// ServerSettings is GET /system/settings (every secret redacted).
type ServerSettings struct {
	Core     CoreSettings                 `json:"core"`
	Auth     AuthSettings                 `json:"auth"`
	Livekit  LivekitSettings              `json:"livekit"`
	Cluster  ClusterSettings              `json:"cluster"`
	Metrics  MetricsSettings              `json:"metrics"`
	Storage  StorageSettings              `json:"storage"`
	Versions VersionsSettings             `json:"versions"`
	Runtime  RuntimeSettings              `json:"runtime"`
	Ports    PortsSettings                `json:"ports"`
	Guidance map[string][]SettingGuidance `json:"guidance"`
}

type CoreSettings struct {
	NodeEnv          string `json:"nodeEnv"`
	Port             int    `json:"port"`
	Host             string `json:"host"`
	PublicBaseURL    string `json:"publicBaseUrl"`
	PublicWsURL      string `json:"publicWsUrl"`
	RtmpPublicHost   string `json:"rtmpPublicHost"`
	LogLevel         string `json:"logLevel"`
	LogRetentionDays int    `json:"logRetentionDays"`
	AuthzEnforce     string `json:"authzEnforce"`
	RedisURL         string `json:"redisUrl"`
	DataDir          string `json:"dataDir"`
}

type AuthSettings struct {
	AdminUser       string `json:"adminUser"`
	JWTSecretSet    bool   `json:"jwtSecretSet"`
	AdminPassSet    bool   `json:"adminPassSet"`
	SMTPConfigured  bool   `json:"smtpConfigured"`
	SuperadminEmail string `json:"superadminEmail"`
}

type LivekitSettings struct {
	URL          string `json:"url"`
	APIKeySet    bool   `json:"apiKeySet"`
	APIKeyMasked string `json:"apiKeyMasked"`
}

type ClusterSettings struct {
	Enabled         bool  `json:"enabled"`
	RedisConfigured bool  `json:"redisConfigured"`
	NodesCount      int64 `json:"nodesCount"`
}

type MetricsSettings struct {
	TokenSet bool `json:"tokenSet"`
}

type StorageSettings struct {
	DataDir     string `json:"dataDir"`
	DBSizeBytes int64  `json:"dbSizeBytes"`
	AppsCount   int    `json:"appsCount"`
}

type VersionsSettings struct {
	Core string `json:"core"`
	// Node is process.version in Node; the Go core reports runtime.Version().
	Node string `json:"node"`
}

type RuntimeSettings struct {
	UptimeSeconds  int64  `json:"uptimeSeconds"`
	PID            int    `json:"pid"`
	Platform       string `json:"platform"`
	MemoryRSSBytes uint64 `json:"memoryRssBytes"`
}

type PortsSettings struct {
	Core             int `json:"core"`
	LivekitSignaling int `json:"livekitSignaling"`
	LivekitTCP       int `json:"livekitTcp"`
	LivekitUDP       int `json:"livekitUdp"`
	RTMP             int `json:"rtmp"`
	WHIP             int `json:"whip"`
}

// SettingGuidance is one operator hint.
type SettingGuidance struct {
	Setting     string `json:"setting"`
	EnvVar      string `json:"envVar"`
	HowToChange string `json:"howToChange"`
}

// Settings is SettingsService.
type Settings struct {
	cfg    *config.Config
	store  *db.Service
	global *sql.DB
}

// NewSettings builds the reporter.
func NewSettings(cfg *config.Config, store *db.Service, global *sql.DB) *Settings {
	return &Settings{cfg: cfg, store: store, global: global}
}

// Get is the full, redacted snapshot.
func (s *Settings) Get(ctx context.Context) ServerSettings {
	c := s.cfg
	server := s.store.ServerSizes(ctx)
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ServerSettings{
		Core: CoreSettings{
			NodeEnv: c.NodeEnv, Port: c.Port, Host: c.Host, PublicBaseURL: c.PublicBaseURL, PublicWsURL: c.PublicWsURL,
			RtmpPublicHost: c.RtmpPublicHost, LogLevel: c.LogLevel, LogRetentionDays: c.LogRetentionDays,
			AuthzEnforce: s.authzEnforce(), RedisURL: redisHostPort(c.RedisURL), DataDir: c.DataDir,
		},
		Auth: AuthSettings{
			AdminUser: c.AdminUser, JWTSecretSet: isSet(c.JWTSecret), AdminPassSet: isSet(c.AdminPass),
			SMTPConfigured: s.smtpConfigured(), SuperadminEmail: s.superadminEmail(),
		},
		Livekit:  LivekitSettings{URL: c.LivekitURL, APIKeySet: isSet(c.LivekitAPIKey), APIKeyMasked: maskKey(c.LivekitAPIKey)},
		Cluster:  ClusterSettings{Enabled: isSet(c.ClusterToken), RedisConfigured: isSet(c.ClusterRedisURL), NodesCount: s.nodesCount(ctx)},
		Metrics:  MetricsSettings{TokenSet: isSet(c.Env("METRICS_TOKEN"))},
		Storage:  StorageSettings{DataDir: c.DataDir, DBSizeBytes: server.DBSizeBytes, AppsCount: len(server.Apps)},
		Versions: VersionsSettings{Core: version.Get(), Node: runtime.Version()},
		Runtime: RuntimeSettings{
			UptimeSeconds: int64(time.Since(started).Seconds()), PID: os.Getpid(), Platform: runtime.GOOS, MemoryRSSBytes: ms.Sys,
		},
		Ports:    PortsSettings{c.Port, livekitSignalingPort, livekitTCPPort, livekitUDPPort, rtmpPort, whipPort},
		Guidance: guidance(),
	}
}

func isSet(v string) bool { return strings.TrimSpace(v) != "" }

// maskKey is the first 6 UTF-16 units + "…" (empty when unset).
func maskKey(v string) string {
	if !isSet(v) {
		return ""
	}
	return jsx.UTF16Slice(v, 6) + "…"
}

var urlScheme = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

// redisHostPort reduces a Redis URL to host:port, never leaking a password.
func redisHostPort(raw string) string {
	if !isSet(raw) {
		return ""
	}
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && validWHATWG(raw) {
		port := u.Port()
		if port == "" {
			port = "6379"
		}
		if host := u.Hostname(); host != "" {
			if strings.Contains(host, ":") {
				host = "[" + host + "]"
			}
			return host + ":" + port
		}
		return raw
	}
	noProto := urlScheme.ReplaceAllString(raw, "")
	hostPart := noProto
	if at := strings.LastIndex(noProto, "@"); at >= 0 {
		hostPart = noProto[at+1:]
	}
	return strings.SplitN(hostPart, "/", 2)[0]
}

// validWHATWG approximates `new URL()` accepting the string: a scheme
// followed by ':' and no whitespace.
func validWHATWG(raw string) bool {
	i := strings.Index(raw, ":")
	return i > 0 && !strings.ContainsAny(raw, " \t\n")
}

// authzEnforce is STREAMHUB_AUTHZ_ENFORCE normalized (default log — this
// reporter's own default, kept as in Node).
func (s *Settings) authzEnforce() string {
	switch v := strings.ToLower(strings.TrimSpace(s.cfg.Env("STREAMHUB_AUTHZ_ENFORCE"))); v {
	case "off", "on":
		return v
	}
	return "log"
}

func (s *Settings) smtpConfigured() bool {
	host := s.cfg.Env("STREAMHUB_SMTP_HOST")
	if host == "" {
		host = smtpHostDefault
	}
	return isSet(host) && isSet(s.cfg.Env("STREAMHUB_SMTP_PASS"))
}

func (s *Settings) superadminEmail() string {
	v := strings.TrimSpace(s.cfg.Env("STREAMHUB_SUPERADMIN_EMAIL"))
	if v == "" {
		v = superadminEmailDefault
	}
	return strings.ToLower(v)
}

func (s *Settings) nodesCount(ctx context.Context) int64 {
	var n int64
	if err := s.global.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM nodes`).Scan(&n); err != nil {
		return 0
	}
	return n
}

func hint(setting, envVar, what string) SettingGuidance {
	return SettingGuidance{
		Setting: setting, EnvVar: envVar,
		HowToChange: what + " Editá `" + envVar + "` en el archivo `.env` del server (p. ej. `/home/ploi/skyline-core/.env`) y " + restartHint,
	}
}

func guidance() map[string][]SettingGuidance {
	return map[string][]SettingGuidance{
		"core": {
			hint("Puerto / host de bind", "PORT", "El core escucha en 127.0.0.1:PORT detrás de Caddy/nginx."),
			hint("URL pública base", "PUBLIC_BASE_URL", "Base absoluta para armar URLs de HLS/reproducción."),
			hint("URL pública de WebSocket", "PUBLIC_WS_URL", "wss:// público de LiveKit que reciben los clientes."),
			hint("Host público de RTMP", "RTMP_PUBLIC_HOST", "Host que se publica para ingesta RTMP."),
			hint("Nivel de log", "LOG_LEVEL", "Verbosidad del logger (trace|debug|info|warn|error)."),
			hint("Retención de logs (días)", "LOG_RETENTION_DAYS", "0 desactiva la purga por antigüedad."),
			hint("Enforcement de permisos", "STREAMHUB_AUTHZ_ENFORCE", "off = sin checks; log = solo audita; on = aplica RBAC/quotas. Poné `on` en producción."),
			hint("URL de Redis", "REDIS_URL", "Coordinación de LiveKit/colas. La contraseña nunca se muestra acá."),
			hint("Directorio de datos", "DATA_DIR", "Raíz de data/streamhub.db, apps/<name>/ y logs/."),
		},
		"auth": {
			hint("Usuario admin (break-glass)", "ADMIN_USER", "Login de emergencia del panel."),
			hint("Contraseña admin (break-glass)", "ADMIN_PASS", "Secreto: solo se informa si está seteado."),
			hint("Secreto JWT de sesión", "STREAMHUB_JWT_SECRET", "Firma los JWT del panel. Secreto: solo se informa si está seteado."),
			hint("Email de superadmin", "STREAMHUB_SUPERADMIN_EMAIL", "El magic-link a esta dirección obtiene rol superadmin."),
			hint("SMTP (envío de mails)", "STREAMHUB_SMTP_PASS", "Requiere host + password. La contraseña nunca se muestra."),
		},
		"livekit": {
			hint("URL de LiveKit", "LIVEKIT_URL", "ws:// del SFU LiveKit que usa el core."),
			hint("API key de LiveKit", "LIVEKIT_API_KEY", "Identificador de credencial (se muestra enmascarado)."),
			hint("API secret de LiveKit", "LIVEKIT_API_SECRET", "Secreto: nunca se devuelve, solo si está seteado."),
		},
		"cluster": {
			hint("Token de cluster", "STREAMHUB_CLUSTER_TOKEN", "Habilita el join de nodos edge. Secreto: solo se informa si está seteado."),
			hint("Redis del cluster", "STREAMHUB_CLUSTER_REDIS_URL", "Redis compartido que se entrega a los nodos que se unen."),
		},
		"metrics": {
			hint("Token de /metrics", "METRICS_TOKEN", "Protege el endpoint Prometheus. Secreto: solo se informa si está seteado."),
		},
		"storage": {
			hint("Directorio de datos", "DATA_DIR", "Cambia dónde viven las DBs, grabaciones y snapshots."),
		},
	}
}
