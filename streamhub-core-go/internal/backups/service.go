package backups

import (
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"modernc.org/sqlite"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/db"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

const (
	globalDB  = "streamhub"
	appPrefix = "app-"
)

// snapshotRE is <ISO with : and . as ->[.pre-restore].db.gz.
var snapshotRE = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(\.pre-restore)?\.db\.gz$`)

var stampRE = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$`)

// Target is a live DB the system snapshots/restores.
type Target struct {
	DB     string // streamhub | app-<name>
	Kind   string // global | app
	App    string
	DBPath string
}

// SnapshotInfo is one snapshot file.
type SnapshotInfo struct {
	DB         string `json:"db"`
	File       string `json:"file"`
	SizeBytes  int64  `json:"sizeBytes"`
	CreatedAt  string `json:"createdAt"`
	PreRestore bool   `json:"preRestore"`
}

// DatabaseView is one DB of the overview.
type DatabaseView struct {
	DB            string         `json:"db"`
	Kind          string         `json:"kind"`
	App           string         `json:"app,omitempty"`
	DBPath        string         `json:"dbPath"`
	LiveSizeBytes *int64         `json:"liveSizeBytes"`
	Orphaned      bool           `json:"orphaned"`
	Snapshots     []SnapshotInfo `json:"snapshots"`
}

// Overview is GET /system/backups.
type Overview struct {
	Enabled       bool           `json:"enabled"`
	RetentionDays int            `json:"retentionDays"`
	BackupDir     string         `json:"backupDir"`
	Schedule      string         `json:"schedule"`
	Databases     []DatabaseView `json:"databases"`
}

// RunError is a per-target failure of a run.
type RunError struct {
	DB    string `json:"db"`
	Error string `json:"error"`
}

// RunResult is POST /system/backups.
type RunResult struct {
	RanAt       string         `json:"ranAt"`
	Reason      string         `json:"reason"`
	Snapshots   []SnapshotInfo `json:"snapshots"`
	Errors      []RunError     `json:"errors"`
	PrunedCount int            `json:"prunedCount"`
}

// RestoreResult is POST /system/backups/restore.
type RestoreResult struct {
	DB                 string `json:"db"`
	Snapshot           string `json:"snapshot"`
	PreRestoreSnapshot string `json:"preRestoreSnapshot"`
	Integrity          string `json:"integrity"`
	Restored           bool   `json:"restored"`
	RestartRecommended bool   `json:"restartRecommended"`
}

// Logger is LogsServiceContract.write.
type Logger interface {
	Write(level, source, message string, meta any, appID *int64)
}

// Service is BackupsService.
type Service struct {
	Settings Settings
	store    *db.Service
	global   *sql.DB
	logs     Logger // optional
	log      *slog.Logger
	now      func() time.Time

	// runMu serializes runs/restores in this process (scheduled + manual);
	// the flock in lock.go covers a second process on the same DATA_DIR.
	runMu sync.Mutex
}

// New builds the service.
func New(settings Settings, store *db.Service, global *sql.DB, logs Logger, log *slog.Logger) *Service {
	return &Service{Settings: settings, store: store, global: global, logs: logs, log: log, now: time.Now}
}

// Targets is the global registry + one per registered app.
func (s *Service) Targets(ctx context.Context) ([]Target, error) {
	out := []Target{{DB: globalDB, Kind: "global", DBPath: s.store.GlobalPath()}}
	rows, err := s.global.QueryContext(ctx, `SELECT name FROM apps ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, Target{DB: appPrefix + name, Kind: "app", App: name, DBPath: s.store.AppPath(name)})
	}
	return out, rows.Err()
}

// Overview lists snapshots per known target, then orphaned snapshot dirs.
func (s *Service) Overview(ctx context.Context) (Overview, error) {
	targets, err := s.Targets(ctx)
	if err != nil {
		return Overview{}, err
	}
	known := map[string]bool{}
	dbs := []DatabaseView{}
	for _, t := range targets {
		known[t.DB] = true
		dbs = append(dbs, DatabaseView{DB: t.DB, Kind: t.Kind, App: t.App, DBPath: t.DBPath,
			LiveSizeBytes: fileSize(t.DBPath), Snapshots: s.ListSnapshots(t.DB)})
	}
	for _, dir := range s.snapshotDirs() {
		if known[dir] {
			continue
		}
		v := DatabaseView{DB: dir, Kind: "global", Orphaned: true, Snapshots: s.ListSnapshots(dir)}
		if strings.HasPrefix(dir, appPrefix) {
			v.Kind, v.App = "app", dir[len(appPrefix):]
		}
		dbs = append(dbs, v)
	}
	return Overview{Enabled: s.Settings.Enabled, RetentionDays: s.Settings.RetentionDays, BackupDir: s.Settings.BackupDir,
		Schedule: s.Settings.Cron, Databases: dbs}, nil
}

// ListSnapshots lists one DB's snapshots, newest first.
func (s *Service) ListSnapshots(dbID string) []SnapshotInfo {
	dir := filepath.Join(s.Settings.BackupDir, dbID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []SnapshotInfo{}
	}
	out := []SnapshotInfo{}
	for _, e := range entries {
		m := snapshotRE.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		st, err := os.Stat(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		created, ok := stampToISO(m[1])
		if !ok {
			created = jsx.ISO(st.ModTime())
		}
		out = append(out, SnapshotInfo{DB: dbID, File: e.Name(), SizeBytes: st.Size(), CreatedAt: created, PreRestore: m[2] != ""})
	}
	// V8's sort with (a<b ? 1 : -1): newest first, equal stamps end up in
	// reverse directory order.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

// NewestSnapshotAge is the age of the newest snapshot of any DB (+Inf when
// there is none).
func (s *Service) NewestSnapshotAge(now time.Time) time.Duration {
	var newest time.Time
	for _, dir := range s.snapshotDirs() {
		for _, snap := range s.ListSnapshots(dir) {
			if t, ok := jsx.ParseDate(snap.CreatedAt); ok && t.After(newest) {
				newest = t
			}
		}
	}
	if newest.IsZero() {
		return time.Duration(math.MaxInt64)
	}
	return now.Sub(newest)
}

type runMeta struct {
	Reason string     `json:"reason"`
	Actor  *string    `json:"actor"`
	Errors []RunError `json:"errors"`
}

// RunBackup snapshots every DB, then prunes. Per-target failures are
// collected, never fatal. actor "" = null.
func (s *Service) RunBackup(ctx context.Context, reason, actor string) RunResult {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	unlock := lockDir(s.Settings.BackupDir)
	defer unlock()

	ranAt := jsx.ISO(s.now())
	snaps, errs := []SnapshotInfo{}, []RunError{}
	targets, err := s.Targets(ctx)
	if err != nil {
		errs = append(errs, RunError{DB: globalDB, Error: err.Error()})
	}
	for _, t := range targets {
		snap, err := s.backupTarget(ctx, t, false)
		if err != nil {
			errs = append(errs, RunError{DB: t.DB, Error: err.Error()})
			s.log.Error(fmt.Sprintf("backup of %s failed: %s", t.DB, err))
			continue
		}
		snaps = append(snaps, snap)
	}
	pruned := s.Prune(s.now())
	if s.logs != nil {
		level := "info"
		if len(errs) > 0 {
			level = "warn"
		}
		s.logs.Write(level, "backups", fmt.Sprintf("backup run (%s): %d snapshot(s), %d error(s), %d pruned", reason, len(snaps), len(errs), pruned),
			runMeta{reason, nullable(actor), errs}, nil)
	}
	return RunResult{RanAt: ranAt, Reason: reason, Snapshots: snaps, Errors: errs, PrunedCount: pruned}
}

func (s *Service) handle(ctx context.Context, t Target) (*sql.DB, error) {
	if t.Kind == "global" {
		return s.global, nil
	}
	return s.store.App(ctx, t.App)
}

// backupTarget hot-backs-up one DB: VACUUM INTO a temp file (consistent
// through WAL, never a raw copy), gzip, atomic rename into place.
func (s *Service) backupTarget(ctx context.Context, t Target, preRestore bool) (SnapshotInfo, error) {
	dir := filepath.Join(s.Settings.BackupDir, t.DB)
	if err := os.MkdirAll(dir, 0o775); err != nil {
		return SnapshotInfo{}, err
	}
	when := s.now()
	file := snapshotName(when, preRestore)
	for exists(filepath.Join(dir, file)) {
		when = when.Add(time.Millisecond)
		file = snapshotName(when, preRestore)
	}
	final := filepath.Join(dir, file)
	tmpDB := filepath.Join(dir, fmt.Sprintf(".tmp-%d-%d.db", os.Getpid(), when.UnixMilli()))
	tmpGz := tmpDB + ".gz"
	defer os.Remove(tmpDB)
	defer os.Remove(tmpGz)

	h, err := s.handle(ctx, t)
	if err != nil {
		return SnapshotInfo{}, err
	}
	if _, err := h.ExecContext(ctx, "VACUUM INTO '"+strings.ReplaceAll(tmpDB, "'", "''")+"'"); err != nil {
		return SnapshotInfo{}, errors.New(sqliteMessage(err))
	}
	if err := gzipFile(tmpDB, tmpGz); err != nil {
		return SnapshotInfo{}, err
	}
	if err := os.Rename(tmpGz, final); err != nil {
		return SnapshotInfo{}, err
	}
	st, err := os.Stat(final)
	if err != nil {
		return SnapshotInfo{}, err
	}
	return SnapshotInfo{DB: t.DB, File: file, SizeBytes: st.Size(), CreatedAt: jsx.ISO(when), PreRestore: preRestore}, nil
}

// Prune deletes snapshots older than RetentionDays across every snapshot
// dir (orphans included). 0 disables it.
func (s *Service) Prune(now time.Time) int {
	days := s.Settings.RetentionDays
	if days <= 0 {
		return 0
	}
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour)
	removed := 0
	for _, dir := range s.snapshotDirs() {
		for _, snap := range s.ListSnapshots(dir) {
			t, ok := jsx.ParseDate(snap.CreatedAt)
			if !ok || !t.Before(cutoff) {
				continue
			}
			if err := os.Remove(filepath.Join(s.Settings.BackupDir, dir, snap.File)); err != nil && !os.IsNotExist(err) {
				s.log.Warn(fmt.Sprintf("prune of %s/%s failed: %s", dir, snap.File, err))
				continue
			}
			removed++
		}
	}
	if removed > 0 {
		s.log.Info(fmt.Sprintf("pruned %d expired snapshot(s)", removed))
	}
	return removed
}

type restoreMeta struct {
	Actor              *string `json:"actor"`
	DB                 string  `json:"db"`
	Snapshot           string  `json:"snapshot"`
	PreRestoreSnapshot string  `json:"preRestoreSnapshot"`
	RestartRecommended bool    `json:"restartRecommended"`
}

// Restore puts a snapshot back over the live DB: validate names → gunzip
// next to the live DB → integrity_check → .pre-restore safety snapshot →
// copy the pages into the live DB with SQLite's online-backup API (atomic
// for every connection; the shared *sql.DB handles stay valid, where Node
// renames the file and reopens its single handle). App DBs are then
// reopened so migrations re-run on the restored file, as Node does.
func (s *Service) Restore(ctx context.Context, dbID, snapshot, actor string) (RestoreResult, error) {
	targets, err := s.Targets(ctx)
	if err != nil {
		return RestoreResult{}, err
	}
	var t *Target
	for i := range targets {
		if targets[i].DB == dbID {
			t = &targets[i]
		}
	}
	if t == nil {
		return RestoreResult{}, httpx.NotFound(fmt.Sprintf("unknown database '%s' — restore only targets the global "+
			"registry ('%s') or a registered app ('%s<name>')", dbID, globalDB, appPrefix))
	}
	if !snapshotRE.MatchString(snapshot) {
		return RestoreResult{}, httpx.BadRequest(fmt.Sprintf("invalid snapshot name '%s'", snapshot))
	}
	snapPath := filepath.Join(s.Settings.BackupDir, t.DB, snapshot)
	if !exists(snapPath) {
		return RestoreResult{}, httpx.NotFound(fmt.Sprintf("snapshot '%s' not found for '%s'", snapshot, dbID))
	}

	s.runMu.Lock()
	defer s.runMu.Unlock()
	unlock := lockDir(s.Settings.BackupDir)
	defer unlock()

	liveDir := filepath.Dir(t.DBPath)
	if err := os.MkdirAll(liveDir, 0o775); err != nil {
		return RestoreResult{}, err
	}
	tmp := filepath.Join(liveDir, fmt.Sprintf(".restore-%d-%d.db", os.Getpid(), s.now().UnixMilli()))
	defer os.Remove(tmp)
	if err := gunzipFile(snapPath, tmp); err != nil {
		return RestoreResult{}, httpx.BadRequest(fmt.Sprintf("snapshot '%s' is not a valid gzip file: %s", snapshot, zlibMessage(err)))
	}
	if err := checkIntegrity(ctx, tmp); err != nil {
		_ = os.Remove(tmp)
		return RestoreResult{}, httpx.BadRequest(fmt.Sprintf("snapshot '%s' failed integrity validation — restore aborted, "+
			"live DB untouched (%s)", snapshot, err))
	}

	pre, err := s.backupTarget(ctx, *t, true)
	if err != nil {
		return RestoreResult{}, err
	}

	h, err := s.handle(ctx, *t)
	if err != nil {
		return RestoreResult{}, err
	}
	if err := restoreInto(ctx, h, tmp); err != nil {
		return RestoreResult{}, err
	}
	if t.Kind == "app" {
		if _, err := s.store.ReopenApp(ctx, t.App); err != nil {
			return RestoreResult{}, err
		}
	}

	restart := t.Kind == "global"
	if s.logs != nil {
		s.logs.Write("warn", "backups", fmt.Sprintf("RESTORED %s from snapshot %s", t.DB, snapshot),
			restoreMeta{nullable(actor), t.DB, snapshot, pre.File, restart}, nil)
	}
	who := actor
	if who == "" {
		who = "n/a"
	}
	s.log.Warn(fmt.Sprintf("restored %s from %s (safety copy: %s, actor: %s)", t.DB, snapshot, pre.File, who))
	return RestoreResult{DB: t.DB, Snapshot: snapshot, PreRestoreSnapshot: pre.File, Integrity: "ok", Restored: true, RestartRecommended: restart}, nil
}

// checkIntegrity opens the candidate read-only and requires
// PRAGMA integrity_check = ok.
func checkIntegrity(ctx context.Context, file string) error {
	h, err := sql.Open("sqlite", "file:"+file+"?mode=ro")
	if err != nil {
		return errors.New(sqliteMessage(err))
	}
	defer h.Close()
	var result string
	if err := h.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); err != nil {
		return errors.New(sqliteMessage(err))
	}
	if result != "ok" {
		return fmt.Errorf("integrity_check reported: %s", result)
	}
	return nil
}

type restorer interface {
	NewRestore(srcURI string) (*sqlite.Backup, error)
}

// restoreInto copies every page of src into h's main DB on one connection.
func restoreInto(ctx context.Context, h *sql.DB, src string) error {
	conn, err := h.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Raw(func(dc any) error {
		r, ok := dc.(restorer)
		if !ok {
			return errors.New("sqlite driver does not support the backup API")
		}
		b, err := r.NewRestore("file:" + src + "?mode=ro")
		if err != nil {
			return err
		}
		for {
			more, err := b.Step(-1)
			if err != nil {
				_ = b.Finish()
				return err
			}
			if !more {
				break
			}
		}
		return b.Finish()
	})
}

func (s *Service) snapshotDirs() []string {
	entries, err := os.ReadDir(s.Settings.BackupDir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}

func snapshotName(when time.Time, preRestore bool) string {
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(jsx.ISO(when))
	if preRestore {
		return stamp + ".pre-restore.db.gz"
	}
	return stamp + ".db.gz"
}

// stampToISO: 2026-07-06T03-30-00-000Z → 2026-07-06T03:30:00.000Z.
func stampToISO(stamp string) (string, bool) {
	m := stampRE.FindStringSubmatch(stamp)
	if m == nil {
		return "", false
	}
	return fmt.Sprintf("%sT%s:%s:%s.%sZ", m[1], m[2], m[3], m[4], m[5]), true
}

func fileSize(p string) *int64 {
	st, err := os.Stat(p)
	if err != nil {
		return nil
	}
	n := st.Size()
	return &n
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func gzipFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	zw := gzip.NewWriter(out)
	if _, err := io.Copy(zw, in); err != nil {
		out.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func gunzipFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	zr, err := gzip.NewReader(in)
	if err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, zr); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// zlibMessage maps Go's gzip errors onto Node zlib's messages.
func zlibMessage(err error) string {
	switch {
	case errors.Is(err, gzip.ErrHeader):
		return "incorrect header check"
	case errors.Is(err, gzip.ErrChecksum):
		return "incorrect data check"
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return "unexpected end of file"
	}
	return err.Error()
}

var sqliteCode = regexp.MustCompile(`\s*\(\d+\)$`)

// sqliteMessage strips modernc's " (NN)" result-code suffix so messages read
// like better-sqlite3's.
func sqliteMessage(err error) string { return sqliteCode.ReplaceAllString(err.Error(), "") }
