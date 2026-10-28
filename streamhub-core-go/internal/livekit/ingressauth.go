package livekit

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"

	"golang.org/x/crypto/scrypt"
)

// Port of ingress-auth.service.ts: the RTMP ingress key + password store
// (SPEC §16), plus the WS-ingest (`wsi_`/`wsk_`) and passthrough
// (`pti_`/`ptk_`) keys that share the same per-app `ingress_auth` table.
// Passwords are salted scrypt (N=16384, r=8, p=1, 32 bytes — Node's
// scryptSync defaults) with the HEX salt string used as the salt bytes.

// Key prefixes (see ingress-auth.service.ts).
const (
	WsIngressIDPrefix                = "wsi_"
	WsStreamKeyPrefix                = "wsk_"
	PassthroughIngressIDPrefix       = "pti_"
	PassthroughStreamKeyPrefix       = "ptk_"
	PassthroughSrtIngressIDPrefix    = "pti_srt_"
	PassthroughMpegtsIngressIDPrefix = "pti_mpegts_"
)

// PassthroughTransportOf is the ingest transport persisted in a pti_ id.
func PassthroughTransportOf(ingressID string) string {
	switch {
	case strings.HasPrefix(ingressID, PassthroughMpegtsIngressIDPrefix):
		return "mpegts"
	case strings.HasPrefix(ingressID, PassthroughSrtIngressIDPrefix):
		return "srt"
	}
	return "rtmp"
}

// IsPassthroughID is PassthroughService.isPassthroughId.
func IsPassthroughID(id string) bool { return strings.HasPrefix(id, PassthroughIngressIDPrefix) }

// IngressAuthRow is a persisted ingress_auth row. SourceURL / CreatedAt are
// only filled by the list/stream-key lookups (as in Node's toRow).
type IngressAuthRow struct {
	IngressID        string  `json:"ingressId"`
	App              string  `json:"app"`
	Room             *string `json:"room"`
	StreamKey        *string `json:"streamKey"`
	RequiresPassword bool    `json:"requiresPassword"`
	ValidatedAt      *string `json:"validatedAt"`
	SourceURL        *string `json:"sourceUrl,omitempty"`
	CreatedAt        *string `json:"createdAt,omitempty"`
}

// AppDBFunc opens an app's database handle (db.Service.App).
type AppDBFunc func(ctx context.Context, app string) (*sql.DB, error)

// IngressAuth is the ingress_auth store.
type IngressAuth struct {
	appDB AppDBFunc
}

// NewIngressAuth builds the store over the per-app databases.
func NewIngressAuth(appDB AppDBFunc) *IngressAuth { return &IngressAuth{appDB: appDB} }

// Register stores (or replaces) an ingress and, when withPassword, a fresh
// password whose plaintext is returned exactly once ("" otherwise).
func (s *IngressAuth) Register(ctx context.Context, ingressID, app, room, streamKey string, withPassword bool) (string, error) {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return "", err
	}
	var password string
	var hash, salt any
	if withPassword {
		password = base64.RawURLEncoding.EncodeToString(randomBytes(12))
		sl := hex.EncodeToString(randomBytes(16))
		hash, salt = hashPassword(password, sl), sl
	}
	var key any
	if streamKey != "" {
		key = streamKey
	}
	req := 0
	if withPassword {
		req = 1
	}
	_, err = h.ExecContext(ctx, `INSERT INTO ingress_auth
           (ingress_id, app, room, stream_key, password_hash, password_salt, requires_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ingress_id) DO UPDATE SET
           app = excluded.app,
           room = excluded.room,
           stream_key = excluded.stream_key,
           password_hash = excluded.password_hash,
           password_salt = excluded.password_salt,
           requires_password = excluded.requires_password,
           validated_at = NULL`,
		ingressID, app, room, key, hash, salt, req)
	return password, err
}

type rawAuth struct {
	row          IngressAuthRow
	passwordHash sql.NullString
	passwordSalt sql.NullString
}

const authCols = `ingress_id, app, room, stream_key, password_hash, password_salt, requires_password, validated_at, source_url, created_at`

func scanAuth(sc interface{ Scan(...any) error }) (*rawAuth, error) {
	var r rawAuth
	var room, key, validated, source, created sql.NullString
	var req int64
	if err := sc.Scan(&r.row.IngressID, &r.row.App, &room, &key, &r.passwordHash, &r.passwordSalt, &req, &validated, &source, &created); err != nil {
		return nil, err
	}
	r.row.Room, r.row.StreamKey, r.row.ValidatedAt = nullable(room), nullable(key), nullable(validated)
	r.row.SourceURL, r.row.CreatedAt = nullable(source), nullable(created)
	r.row.RequiresPassword = req != 0
	return &r, nil
}

func nullable(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func (s *IngressAuth) raw(ctx context.Context, app, ingressID string) (*rawAuth, error) {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	r, err := scanAuth(h.QueryRowContext(ctx, `SELECT `+authCols+` FROM ingress_auth WHERE ingress_id = ?`, ingressID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return r, err
}

// Get looks up an ingress auth row (nil when absent). Like Node's get(), the
// sourceUrl/createdAt extras are not part of this view.
func (s *IngressAuth) Get(ctx context.Context, app, ingressID string) (*IngressAuthRow, error) {
	r, err := s.raw(ctx, app, ingressID)
	if r == nil || err != nil {
		return nil, err
	}
	row := r.row
	row.SourceURL, row.CreatedAt = nil, nil
	return &row, nil
}

// Validate checks a presented password; success (or no password needed)
// marks the row validated. Unknown ingress → false.
func (s *IngressAuth) Validate(ctx context.Context, app, ingressID string, password *string) (bool, error) {
	r, err := s.raw(ctx, app, ingressID)
	if r == nil || err != nil {
		return false, err
	}
	if !r.row.RequiresPassword {
		return true, s.markValidated(ctx, app, ingressID)
	}
	if password == nil || *password == "" || !r.passwordHash.Valid || r.passwordHash.String == "" || !r.passwordSalt.Valid || r.passwordSalt.String == "" {
		return false, nil
	}
	a, _ := hex.DecodeString(hashPassword(*password, r.passwordSalt.String))
	b, _ := hex.DecodeString(r.passwordHash.String)
	if len(a) != len(b) || subtle.ConstantTimeCompare(a, b) != 1 {
		return false, nil
	}
	return true, s.markValidated(ctx, app, ingressID)
}

// IsAuthorized: untracked → true; no password → true; else validated.
func (s *IngressAuth) IsAuthorized(ctx context.Context, app, ingressID string) (bool, error) {
	r, err := s.raw(ctx, app, ingressID)
	if err != nil {
		return false, err
	}
	if r == nil || !r.row.RequiresPassword {
		return true, nil
	}
	return r.row.ValidatedAt != nil, nil
}

// Remove deletes an ingress' row.
func (s *IngressAuth) Remove(ctx context.Context, app, ingressID string) error {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM ingress_auth WHERE ingress_id = ?`, ingressID)
	return err
}

// RegisterWsIngest mints a WS-ingest key (wsi_<hex12>, wsk_<base64url32>).
func (s *IngressAuth) RegisterWsIngest(ctx context.Context, app, room string) (ingressID, streamKey string, err error) {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return "", "", err
	}
	ingressID = WsIngressIDPrefix + hex.EncodeToString(randomBytes(6))
	streamKey = WsStreamKeyPrefix + base64.RawURLEncoding.EncodeToString(randomBytes(24))
	_, err = h.ExecContext(ctx, `INSERT INTO ingress_auth
           (ingress_id, app, room, stream_key, requires_password)
         VALUES (?, ?, ?, ?, 0)`, ingressID, app, room, streamKey)
	return ingressID, streamKey, err
}

// FindByStreamKey looks a row up by stream key (nil when absent or "").
func (s *IngressAuth) FindByStreamKey(ctx context.Context, app, streamKey string) (*IngressAuthRow, error) {
	if streamKey == "" {
		return nil, nil
	}
	h, err := s.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	r, err := scanAuth(h.QueryRowContext(ctx, `SELECT `+authCols+` FROM ingress_auth WHERE stream_key = ?`, streamKey))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r.row, nil
}

// ListWsIngest lists the app's wsi_ keys, newest first.
func (s *IngressAuth) ListWsIngest(ctx context.Context, app string) ([]IngressAuthRow, error) {
	return s.list(ctx, app, `SELECT `+authCols+` FROM ingress_auth WHERE ingress_id LIKE 'wsi\_%' ESCAPE '\' ORDER BY created_at DESC, ingress_id DESC`)
}

// RegisterPassthrough mints a passthrough key; transport rtmp|srt|mpegts
// picks the id prefix, sourceURL ("" = NULL) is the MPEG-TS pull input.
func (s *IngressAuth) RegisterPassthrough(ctx context.Context, app, room, transport, sourceURL string) (ingressID, streamKey string, err error) {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return "", "", err
	}
	prefix := PassthroughIngressIDPrefix
	switch transport {
	case "mpegts":
		prefix = PassthroughMpegtsIngressIDPrefix
	case "srt":
		prefix = PassthroughSrtIngressIDPrefix
	}
	ingressID = prefix + hex.EncodeToString(randomBytes(6))
	streamKey = PassthroughStreamKeyPrefix + base64.RawURLEncoding.EncodeToString(randomBytes(24))
	var src any
	if sourceURL != "" {
		src = sourceURL
	}
	_, err = h.ExecContext(ctx, `INSERT INTO ingress_auth
           (ingress_id, app, room, stream_key, requires_password, source_url)
         VALUES (?, ?, ?, ?, 0, ?)`, ingressID, app, room, streamKey, src)
	return ingressID, streamKey, err
}

// ListPassthrough lists the app's pti_ keys, newest first.
func (s *IngressAuth) ListPassthrough(ctx context.Context, app string) ([]IngressAuthRow, error) {
	return s.list(ctx, app, `SELECT `+authCols+` FROM ingress_auth WHERE ingress_id LIKE 'pti\_%' ESCAPE '\' ORDER BY created_at DESC, ingress_id DESC`)
}

func (s *IngressAuth) list(ctx context.Context, app, q string) ([]IngressAuthRow, error) {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IngressAuthRow{}
	for rows.Next() {
		r, err := scanAuth(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r.row)
	}
	return out, rows.Err()
}

func (s *IngressAuth) markValidated(ctx context.Context, app, ingressID string) error {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `UPDATE ingress_auth SET validated_at = datetime('now') WHERE ingress_id = ?`, ingressID)
	return err
}

// hashPassword is scryptSync(password, salt, 32).toString('hex').
func hashPassword(password, salt string) string {
	k, err := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 32)
	if err != nil {
		panic(err) // fixed, valid parameters
	}
	return hex.EncodeToString(k)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// ---------------------------------------------------------------------------
// ingress-backup.service.ts — primary+backup (failover) ingress pairs
// ---------------------------------------------------------------------------

// IngressBackupLink is one primary↔backup pairing row.
type IngressBackupLink struct {
	PrimaryIngressID string  `json:"primaryIngressId"`
	BackupIngressID  string  `json:"backupIngressId"`
	App              string  `json:"app"`
	Room             string  `json:"room"`
	CreatedAt        *string `json:"createdAt"`
}

// IngressRoleInfo: Role "" = not paired.
type IngressRoleInfo struct {
	Role             string
	PairedIngressID  string
	PrimaryIngressID string
	BackupIngressID  string
}

const ingressBackupDDL = `
    CREATE TABLE IF NOT EXISTS ingress_backup_links (
      primary_ingress_id TEXT PRIMARY KEY,
      backup_ingress_id  TEXT NOT NULL UNIQUE,
      app                TEXT NOT NULL,
      room               TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ingress_backup_backup
      ON ingress_backup_links(backup_ingress_id);`

// IngressBackup is the per-app ingress_backup_links store (table created
// lazily on first access, once per handle).
type IngressBackup struct {
	appDB   AppDBFunc
	mu      sync.Mutex
	ensured map[*sql.DB]bool
}

// NewIngressBackup builds the store.
func NewIngressBackup(appDB AppDBFunc) *IngressBackup {
	return &IngressBackup{appDB: appDB, ensured: map[*sql.DB]bool{}}
}

func (s *IngressBackup) handle(ctx context.Context, app string) (*sql.DB, error) {
	h, err := s.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ensured[h] {
		if _, err := h.ExecContext(ctx, ingressBackupDDL); err != nil {
			return nil, err
		}
		s.ensured[h] = true
	}
	return h, nil
}

// Link records (or replaces, keyed on the primary) a pairing.
func (s *IngressBackup) Link(ctx context.Context, app, primaryID, backupID, room string) error {
	h, err := s.handle(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `INSERT INTO ingress_backup_links
           (primary_ingress_id, backup_ingress_id, app, room)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(primary_ingress_id) DO UPDATE SET
           backup_ingress_id = excluded.backup_ingress_id,
           room = excluded.room`, primaryID, backupID, app, room)
	return err
}

func (s *IngressBackup) getBy(ctx context.Context, app, col, id string) (*IngressBackupLink, error) {
	h, err := s.handle(ctx, app)
	if err != nil {
		return nil, err
	}
	var l IngressBackupLink
	var created sql.NullString
	err = h.QueryRowContext(ctx, `SELECT primary_ingress_id, backup_ingress_id, app, room, created_at FROM ingress_backup_links WHERE `+col+` = ?`, id).
		Scan(&l.PrimaryIngressID, &l.BackupIngressID, &l.App, &l.Room, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l.CreatedAt = nullable(created)
	return &l, nil
}

// GetByPrimary is the pairing whose primary is id.
func (s *IngressBackup) GetByPrimary(ctx context.Context, app, id string) (*IngressBackupLink, error) {
	return s.getBy(ctx, app, "primary_ingress_id", id)
}

// GetByBackup is the pairing whose backup is id.
func (s *IngressBackup) GetByBackup(ctx context.Context, app, id string) (*IngressBackupLink, error) {
	return s.getBy(ctx, app, "backup_ingress_id", id)
}

// GetLinkFor is the pairing referencing id from either side.
func (s *IngressBackup) GetLinkFor(ctx context.Context, app, id string) (*IngressBackupLink, error) {
	l, err := s.GetByPrimary(ctx, app, id)
	if l != nil || err != nil {
		return l, err
	}
	return s.GetByBackup(ctx, app, id)
}

// GetRoleInfo classifies id (role "" when unpaired).
func (s *IngressBackup) GetRoleInfo(ctx context.Context, app, id string) (IngressRoleInfo, error) {
	if l, err := s.GetByPrimary(ctx, app, id); err != nil {
		return IngressRoleInfo{}, err
	} else if l != nil {
		return IngressRoleInfo{"primary", l.BackupIngressID, l.PrimaryIngressID, l.BackupIngressID}, nil
	}
	if l, err := s.GetByBackup(ctx, app, id); err != nil {
		return IngressRoleInfo{}, err
	} else if l != nil {
		return IngressRoleInfo{"backup", l.PrimaryIngressID, l.PrimaryIngressID, l.BackupIngressID}, nil
	}
	return IngressRoleInfo{}, nil
}

// Remove drops any pairing referencing id.
func (s *IngressBackup) Remove(ctx context.Context, app, id string) error {
	h, err := s.handle(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM ingress_backup_links WHERE primary_ingress_id = ? OR backup_ingress_id = ?`, id, id)
	return err
}
