// Package compliance is the read-only security posture report
// (modules/audit/compliance.service.ts + compliance.controller.ts): each ISO
// 27002 §8 technological control → its LIVE state on this deployment.
package compliance

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/audit"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/authz"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/api"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// ComplianceControl is one row of the report.
type ComplianceControl struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ISO    string `json:"iso"`
	State  string `json:"state"` // active | partial | off | unknown
	Detail string `json:"detail"`
}

// ComplianceSummary counts controls per state.
type ComplianceSummary struct {
	Active  int `json:"active"`
	Partial int `json:"partial"`
	Off     int `json:"off"`
	Unknown int `json:"unknown"`
}

// ComplianceReport is GET /system/compliance.
type ComplianceReport struct {
	CheckedAt string              `json:"checkedAt"`
	Summary   ComplianceSummary   `json:"summary"`
	Controls  []ComplianceControl `json:"controls"`
}

const backupFreshHours = 48

// Service builds the report.
type Service struct {
	cfg   *config.Config
	db    *sql.DB
	audit *audit.Service
	now   func() time.Time
}

// New builds the service.
func New(cfg *config.Config, global *sql.DB, a *audit.Service) *Service {
	return &Service{cfg: cfg, db: global, audit: a, now: time.Now}
}

// Report inspects env, DB and filesystem.
func (s *Service) Report(ctx context.Context) ComplianceReport {
	controls := []ComplianceControl{
		s.authzEnforce(), s.tls(), s.ipFiltering(ctx), s.autoBan(), s.auditLog(ctx),
		s.backups(), httpHardening(), s.metricsProtected(), s.publicRegistration(), s.logRetention(),
	}
	var sum ComplianceSummary
	for _, c := range controls {
		switch c.State {
		case "active":
			sum.Active++
		case "partial":
			sum.Partial++
		case "off":
			sum.Off++
		default:
			sum.Unknown++
		}
	}
	return ComplianceReport{CheckedAt: jsx.ISO(s.now()), Summary: sum, Controls: controls}
}

func pick(cond1 bool, a string, cond2 bool, b, c string) string {
	if cond1 {
		return a
	}
	if cond2 {
		return b
	}
	return c
}

func (s *Service) authzEnforce() ComplianceControl {
	mode := authz.Mode()
	return ComplianceControl{
		ID: "authz_enforce", Name: "RBAC & quota enforcement (STREAMHUB_AUTHZ_ENFORCE)", ISO: "8.3",
		State: pick(mode == authz.ModeOn, "active", mode == authz.ModeLog, "partial", "off"),
		Detail: pick(mode == authz.ModeOn, "enforcing: role/tenant/quota denials return 403/429",
			mode == authz.ModeLog, "log-only: violations are logged but requests pass",
			"disabled: no RBAC/quota checks run"),
	}
}

func (s *Service) tls() ComplianceControl {
	base := s.cfg.PublicBaseURL
	domain := strings.TrimSpace(s.cfg.Env("STREAMHUB_DOMAIN"))
	https := strings.HasPrefix(base, "https://")
	return ComplianceControl{
		ID: "tls", Name: "TLS termination (auto-TLS at the reverse proxy)", ISO: "8.21, 8.24",
		State: pick(https, "active", domain != "", "partial", "off"),
		Detail: pick(https, fmt.Sprintf("public base URL is HTTPS (%s)", base),
			domain != "", fmt.Sprintf("STREAMHUB_DOMAIN=%s set but PUBLIC_BASE_URL is not https", domain),
			"no https PUBLIC_BASE_URL/STREAMHUB_DOMAIN configured"),
	}
}

func (s *Service) ipFiltering(ctx context.Context) ComplianceControl {
	raw := strings.ToLower(strings.TrimSpace(s.cfg.Env("STREAMHUB_IP_ACCESS_MODE")))
	mode := "off"
	if raw == "enforce" || raw == "log" {
		mode = raw
	}
	counts := map[string]int{}
	if rows, err := s.db.QueryContext(ctx, `SELECT action, COUNT(*) AS n FROM ip_rules GROUP BY action`); err == nil {
		for rows.Next() {
			var a string
			var n int
			if rows.Scan(&a, &n) == nil {
				counts[a] = n
			}
		}
		rows.Close()
	}
	return ComplianceControl{
		ID: "ip_filtering", Name: "IP allow/blocklist (network security)", ISO: "8.20",
		State:  pick(mode == "enforce", "active", mode == "log", "partial", "off"),
		Detail: fmt.Sprintf("mode=%s; rules: %d allow / %d block", mode, counts["allow"], counts["block"]),
	}
}

func (s *Service) autoBan() ComplianceControl {
	enabled := s.flag("STREAMHUB_AUTOBAN_ENABLED")
	max := envOr(s.cfg, "STREAMHUB_AUTOBAN_MAX_OFFENSES", "10")
	win := envOr(s.cfg, "STREAMHUB_AUTOBAN_WINDOW_S", "300")
	return ComplianceControl{
		ID: "auto_ban", Name: "Auto-ban on repeated abuse (in-app fail2ban)", ISO: "8.16, 8.20",
		State: pick(enabled, "active", false, "", "off"),
		Detail: pick(enabled, fmt.Sprintf("enabled: ban after %s offenses within %ss", max, win), false, "",
			"disabled (STREAMHUB_AUTOBAN_ENABLED off)"),
	}
}

func (s *Service) auditLog(ctx context.Context) ComplianceControl {
	days := s.audit.RetentionDays()
	ret := "forever"
	if days != 0 {
		ret = fmt.Sprintf("%d days", days)
	}
	return ComplianceControl{
		ID: "audit_log", Name: "Append-only security audit trail", ISO: "8.15, 8.16", State: "active",
		Detail: fmt.Sprintf("enabled; %d entries; retention %s; hash-chained, UPDATE/DELETE rejected by trigger", s.audit.Count(ctx), ret),
	}
}

func (s *Service) backups() ComplianceControl {
	localDir := strings.TrimSpace(s.cfg.Env("BACKUP_LOCAL_DIR"))
	configured := strings.TrimSpace(s.cfg.Env("BACKUP_S3_BUCKET")) != "" || localDir != ""
	dir := localDir
	if dir == "" {
		dir = filepath.Join(s.cfg.DataDir, "backups")
	}
	const name = "Automated backups of DATA_DIR"
	age, ok := s.newestFileAgeHours(dir)
	if !ok {
		return ComplianceControl{ID: "backups", Name: name, ISO: "8.13",
			State: pick(configured, "partial", false, "", "off"),
			Detail: pick(configured, "configured but no backup found in "+dir, false, "",
				"no backup configuration and no backups in "+dir)}
	}
	fresh := age <= backupFreshHours
	suffix := ""
	if !fresh {
		suffix = fmt.Sprintf(" (older than %dh)", backupFreshHours)
	}
	return ComplianceControl{ID: "backups", Name: name, ISO: "8.13",
		State:  pick(fresh, "active", false, "", "partial"),
		Detail: fmt.Sprintf("last backup %sh ago in %s%s", strconv.FormatFloat(age, 'f', 1, 64), dir, suffix)}
}

func httpHardening() ComplianceControl {
	return ComplianceControl{ID: "http_hardening", Name: "Hardened HTTP response headers (helmet)", ISO: "8.26", State: "active",
		Detail: "helmet is enabled unconditionally at bootstrap (src/main.ts)"}
}

func (s *Service) metricsProtected() ComplianceControl {
	token := strings.TrimSpace(s.cfg.Env("METRICS_TOKEN"))
	return ComplianceControl{ID: "metrics_protected", Name: "Prometheus /metrics access control", ISO: "8.16", State: "active",
		Detail: pick(token != "", "token-gated (METRICS_TOKEN set; invalid token → 403)", false, "",
			"disabled by default-deny (no METRICS_TOKEN → 404)")}
}

func (s *Service) publicRegistration() ComplianceControl {
	enabled := s.flag("STREAMHUB_PUBLIC_REGISTRATION") || s.flag("STREAMHUB_ALLOW_SIGNUP")
	return ComplianceControl{ID: "public_registration", Name: "Public self-registration disabled", ISO: "8.2, 8.5",
		State: pick(enabled, "off", false, "", "active"),
		Detail: pick(enabled, "public signup is ENABLED — anyone can create a team", false, "",
			"invite-only: unknown emails get 403 signup_disabled")}
}

func (s *Service) logRetention() ComplianceControl {
	days := s.cfg.LogRetentionDays
	return ComplianceControl{ID: "log_retention", Name: "Server log retention (server_logs purge)", ISO: "8.15",
		State: pick(days > 0, "active", false, "", "partial"),
		Detail: pick(days > 0, fmt.Sprintf("rows and rotated files older than %d days are purged", days), false, "",
			"retention 0 = logs kept forever (no automatic purge)")}
}

func (s *Service) flag(name string) bool {
	switch strings.ToLower(strings.TrimSpace(s.cfg.Env(name))) {
	case "1", "true", "on", "yes":
		return true
	}
	return false
}

// envOr is `config.env(name) ?? fallback` (an empty value is kept, like ??).
func envOr(c *config.Config, name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return fallback
}

func (s *Service) newestFileAgeHours(dir string) (float64, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, false
	}
	var newest time.Time
	for _, e := range entries {
		st, err := os.Stat(filepath.Join(dir, e.Name()))
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		if st.ModTime().After(newest) {
			newest = st.ModTime()
		}
	}
	if newest.IsZero() {
		return 0, false
	}
	return s.now().Sub(newest).Hours(), true
}

// Register implements api.Module (GET /system/compliance, global scope only).
func (s *Service) Register(a huma.API) {
	huma.Register(a, *api.Bearer(&huma.Operation{
		OperationID: "ComplianceController_report",
		Method:      http.MethodGet,
		Path:        api.Prefix + "/system/compliance",
		Summary:     "Security/compliance posture: each product control → live state → ISO 27002:2022 §8 control.",
		Tags:        []string{"system"},
	}), func(ctx context.Context, _ *struct{}) (*api.Out[api.Envelope[ComplianceReport]], error) {
		if err := api.RequireGlobal(ctx, api.GlobalScopeMessage); err != nil {
			return nil, err
		}
		return api.OK(s.Report(ctx)), nil
	})
}
