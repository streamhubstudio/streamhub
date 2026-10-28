// Package backups ports modules/backups: versioned + gzip-compressed hot
// snapshots (VACUUM INTO) of every StreamHub SQLite DB, retention pruning,
// the integrity-gated restore, the daily schedule (an in-process cron in
// place of the BullMQ repeatable job) and GET/POST /system/backups(/restore).
package backups

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/config"
)

// Defaults (backup-settings.ts).
const (
	DefaultRetentionDays = 7
	DefaultCron          = "30 3 * * *"
)

// Settings are the env-driven backup settings.
type Settings struct {
	// Enabled is STREAMHUB_BACKUPS_ENABLED (opt-out; default on).
	Enabled bool
	// RetentionDays is STREAMHUB_BACKUP_RETENTION_DAYS (0 = keep forever).
	RetentionDays int
	// BackupDir is STREAMHUB_BACKUP_DIR (default <DATA_DIR>/backups).
	BackupDir string
	// Cron is STREAMHUB_BACKUP_CRON (5–6 fields, else the default).
	Cron string
}

var spaces = regexp.MustCompile(`\s+`)

// ResolveSettings reads the settings through cfg.Env.
func ResolveSettings(cfg *config.Config) Settings {
	s := Settings{Enabled: true, RetentionDays: DefaultRetentionDays, BackupDir: filepath.Join(cfg.DataDir, "backups"), Cron: DefaultCron}
	switch strings.ToLower(strings.TrimSpace(cfg.Env("STREAMHUB_BACKUPS_ENABLED"))) {
	case "0", "false", "off", "no":
		s.Enabled = false
	}
	if raw := cfg.Env("STREAMHUB_BACKUP_RETENTION_DAYS"); raw != "" {
		if n, ok := config.ParseIntPrefix(raw); ok && n >= 0 {
			s.RetentionDays = n
		}
	}
	if dir := strings.TrimSpace(cfg.Env("STREAMHUB_BACKUP_DIR")); dir != "" {
		s.BackupDir = dir
	}
	if raw := strings.TrimSpace(cfg.Env("STREAMHUB_BACKUP_CRON")); raw != "" {
		if n := len(spaces.Split(raw, -1)); n == 5 || n == 6 {
			s.Cron = raw
		}
	}
	return s
}
