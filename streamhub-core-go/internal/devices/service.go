package devices

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/audit"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/auth"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/authn"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
)

// Error texts (stable: the encoder and the dashboard read them).
const (
	msgDisabled      = "device pairing is disabled — set " + EnableEnv + "=on to use it"
	msgBadCode       = "invalid or expired pairing code"
	msgUnknownPair   = "unknown or expired pairing"
	msgTooMany       = "too many pending pairings — retry later"
	msgNotFound      = "device not found"
	msgNotConnected  = "device not connected"
	msgNoResponse    = "device did not respond in time"
	msgUnknownApp    = "app not found"
	maxStatusBytes   = 64 << 10
	maxCapsBytes     = 32 << 10
	maxFieldLen      = 120
	auditTargetType  = "device"
	auditPairClaim   = "device.claim"
	auditRevoke      = "device.revoke"
	auditCommand     = "device.command"
	auditPairFailure = "device.claim_failed"
)

// Apps is the slice of the apps registry the plane needs.
type Apps interface {
	Exists(ctx context.Context, app string) bool
}

// AuditSink records security-relevant actions (optional).
type AuditSink interface {
	RecordCtx(ctx context.Context, e audit.Event)
}

// Offenses feeds the security auto-ban (optional).
type Offenses func(ip string)

// Deps are the service collaborators.
type Deps struct {
	DB      *sql.DB
	Enabled bool
	// PublicBaseURL is PUBLIC_BASE_URL (the device's WS URL derives from it).
	PublicBaseURL string
	Apps          Apps
	Audit         AuditSink
	Offense       Offenses
	Ingress       Ingress // E6; nil = channels can't be linked
	Log           *slog.Logger
	Now           func() time.Time
}

// Service is the device plane's business logic (HTTP-free).
type Service struct {
	db      *sql.DB
	enabled bool
	baseURL string
	apps    Apps
	audit   AuditSink
	offense Offenses
	ingress Ingress
	log     *slog.Logger
	now     func() time.Time
	gw      *Gateway

	startThrottle *authn.Throttle // per IP
	pollThrottle  *authn.Throttle // per IP
	claimThrottle *authn.Throttle // per IP + per account (wrong codes)
}

// New builds the service; its gateway is attached by NewGateway.
func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	clock := func() time.Time { return d.Now() }
	return &Service{
		db: d.DB, enabled: d.Enabled, baseURL: strings.TrimRight(d.PublicBaseURL, "/"), apps: d.Apps,
		audit: d.Audit, offense: d.Offense, ingress: d.Ingress, log: d.Log, now: d.Now,
		startThrottle: authn.NewThrottle(authn.ThrottleConfig{IPMax: 10}, clock),
		pollThrottle:  authn.NewThrottle(authn.ThrottleConfig{IPMax: 120}, clock),
		claimThrottle: authn.NewThrottle(authn.ThrottleConfig{IPMax: 30, FailMax: 5}, clock),
	}
}

// Enabled reports the master switch.
func (s *Service) Enabled() bool { return s.enabled }

func (s *Service) disabled() error {
	if !s.enabled {
		return httpx.Unavailable(msgDisabled)
	}
	return nil
}

func (s *Service) iso(t time.Time) string { return jsx.ISO(t) }

// ---------------------------------------------------------------------------
// pairing (device side, public)
// ---------------------------------------------------------------------------

// StartInput is what an unpaired device announces (all optional).
type StartInput struct {
	Model, Version, Serial string
}

// DevicePairStart is POST /devices/pair/start.data.
type DevicePairStart struct {
	DeviceID     string `json:"deviceId"`
	Code         string `json:"code"`
	DisplayCode  string `json:"displayCode"`
	PollToken    string `json:"pollToken"`
	ExpiresAt    string `json:"expiresAt"`
	PollInterval int    `json:"pollInterval"`
}

// StartPairing mints a pairing (code + poll token, both stored hashed).
func (s *Service) StartPairing(ctx context.Context, ip string, in StartInput) (*DevicePairStart, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	if err := s.startThrottle.Attempt(strPtr(ip)); err != nil {
		return nil, err
	}
	now := s.now()
	nowISO := s.iso(now)
	if _, err := s.db.ExecContext(ctx, `DELETE FROM device_pairings WHERE expires_at <= ?`, nowISO); err != nil {
		return nil, err
	}
	var total, mine int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END), 0) FROM device_pairings`, ip).Scan(&total, &mine); err != nil {
		return nil, err
	}
	if total >= MaxPendingPairings || (ip != "" && mine >= MaxPendingPerIP) {
		return nil, httpx.Nest(429, msgTooMany)
	}
	expires := s.iso(now.Add(CodeTTL))
	poll := randToken(32)
	id := newDeviceID()
	for attempt := 0; attempt < 5; attempt++ {
		code := newCode()
		_, err := s.db.ExecContext(ctx, `INSERT INTO device_pairings
		    (device_id, code_hash, poll_hash, model, version, serial, ip, expires_at, created_at)
		  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, hashSecret(code), hashSecret(poll), nullable(clip(in.Model)), nullable(clip(in.Version)),
			nullable(clip(in.Serial)), nullable(ip), expires, nowISO)
		if err == nil {
			return &DevicePairStart{DeviceID: id, Code: code, DisplayCode: DisplayCode(code), PollToken: poll,
				ExpiresAt: expires, PollInterval: PollInterval}, nil
		}
		if !strings.Contains(err.Error(), "UNIQUE") {
			return nil, err
		}
	}
	return nil, errors.New("could not allocate a unique pairing code")
}

// DevicePollResult is GET /devices/pair/{deviceId}.data.
type DevicePollResult struct {
	Status     string `json:"status"` // pending | claimed
	ExpiresAt  string `json:"expiresAt,omitempty"`
	DeviceID   string `json:"deviceId,omitempty"`
	Credential string `json:"credential,omitempty"`
	WsURL      string `json:"wsUrl,omitempty"`
	App        string `json:"app,omitempty"`
}

// Poll is the device's wait for its claim. Once claimed, the FIRST valid
// poll mints the credential (only its hash is stored) and burns the pairing:
// the credential is delivered exactly once. A wrong token answers like an
// unknown pairing, and MaxPollFailures of them burn the pairing.
func (s *Service) Poll(ctx context.Context, ip, deviceID, token, wsURL string) (*DevicePollResult, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	if err := s.pollThrottle.Attempt(strPtr(ip)); err != nil {
		return nil, err
	}
	var (
		pollHash, expires string
		claimedApp        sql.NullString
		failures          int
	)
	err := s.db.QueryRowContext(ctx, `SELECT poll_hash, expires_at, claimed_app, poll_failures FROM device_pairings WHERE device_id = ?`,
		deviceID).Scan(&pollHash, &expires, &claimedApp, &failures)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound(msgUnknownPair)
	}
	if err != nil {
		return nil, err
	}
	if !secretMatches(token, pollHash) {
		s.recordOffense(ip)
		if failures+1 >= MaxPollFailures {
			_, _ = s.db.ExecContext(ctx, `DELETE FROM device_pairings WHERE device_id = ?`, deviceID)
			s.log.Warn("device pairing burnt after repeated wrong poll tokens", "deviceId", deviceID, "ip", ip)
		} else {
			_, _ = s.db.ExecContext(ctx, `UPDATE device_pairings SET poll_failures = poll_failures + 1 WHERE device_id = ?`, deviceID)
		}
		return nil, httpx.NotFound(msgUnknownPair)
	}
	if expires <= s.iso(s.now()) {
		_, _ = s.db.ExecContext(ctx, `DELETE FROM device_pairings WHERE device_id = ?`, deviceID)
		return nil, httpx.NotFound(msgUnknownPair)
	}
	if !claimedApp.Valid {
		return &DevicePollResult{Status: "pending", ExpiresAt: expires}, nil
	}

	cred := newCredential(deviceID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM device_pairings WHERE device_id = ? AND poll_hash = ? AND claimed_app IS NOT NULL`, deviceID, pollHash)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return nil, httpx.NotFound(msgUnknownPair) // a concurrent poll won
	}
	res, err = tx.ExecContext(ctx, `UPDATE devices SET credential_hash = ? WHERE id = ? AND app = ? AND credential_hash IS NULL`,
		hashSecret(cred), deviceID, claimedApp.String)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return nil, httpx.NotFound(msgUnknownPair) // revoked before delivery
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &DevicePollResult{Status: "claimed", DeviceID: deviceID, Credential: cred, WsURL: wsURL, App: claimedApp.String}, nil
}

// WsURL is the device WS URL for a request host (PUBLIC_BASE_URL wins).
func (s *Service) WsURL(reqScheme, reqHost string) string {
	base := s.baseURL
	if base == "" {
		if reqScheme == "" {
			reqScheme = "http"
		}
		base = reqScheme + "://" + reqHost
	}
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	}
	return base + WSPath
}

// ---------------------------------------------------------------------------
// claim + management (operator side, app-scoped)
// ---------------------------------------------------------------------------

// Device is the dashboard / API view of a paired device.
type Device struct {
	ID           string          `json:"id"`
	App          string          `json:"app"`
	Name         string          `json:"name"`
	Model        *string         `json:"model"`
	Version      *string         `json:"version"`
	Serial       *string         `json:"serial"`
	Paired       bool            `json:"paired"` // the credential was delivered
	Online       bool            `json:"online"`
	LastSeenAt   *string         `json:"lastSeenAt"`
	LastIP       *string         `json:"lastIp"`
	Capabilities json.RawMessage `json:"capabilities"`
	Status       json.RawMessage `json:"status"`
	ConfigRev    int64           `json:"configRev"`
	CreatedAt    string          `json:"createdAt"`
	CreatedBy    *string         `json:"createdBy"`
	Channels     []DeviceChannel `json:"channels"`
}

func accountKey(p *auth.Principal, ip string) string {
	if p != nil && p.UserID != "" {
		return "u:" + p.UserID
	}
	return "ip:" + ip
}

// Claim binds a pending pairing (by its code) to app. The code is single
// use and expires; wrong codes count against the caller (5 → backoff).
func (s *Service) Claim(ctx context.Context, app, rawCode, name string, p *auth.Principal, ip string) (*Device, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	account := accountKey(p, ip)
	if err := s.claimThrottle.Attempt(strPtr(ip)); err != nil {
		return nil, err
	}
	if err := s.claimThrottle.Locked(account); err != nil {
		return nil, err
	}
	if s.apps != nil && !s.apps.Exists(ctx, app) {
		return nil, httpx.NotFound(msgUnknownApp)
	}
	fail := func() (*Device, error) {
		s.claimThrottle.Fail(account)
		s.recordOffense(ip)
		s.record(ctx, audit.Event{Action: auditPairFailure, IP: strPtr(ip), Result: audit.Deny,
			Meta: map[string]string{"app": app}}, p)
		return nil, httpx.NotFound(msgBadCode)
	}
	code, ok := NormalizeCode(rawCode)
	if !ok {
		return fail()
	}
	now := s.now()
	nowISO := s.iso(now)
	var (
		deviceID               string
		model, version, serial sql.NullString
	)
	err := s.db.QueryRowContext(ctx, `SELECT device_id, model, version, serial FROM device_pairings
	    WHERE code_hash = ? AND claimed_app IS NULL AND expires_at > ?`, hashSecret(code), nowISO).
		Scan(&deviceID, &model, &version, &serial)
	if errors.Is(err, sql.ErrNoRows) {
		return fail()
	}
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = model.String
	}
	if name == "" {
		name = deviceID
	}
	var createdBy any
	if p != nil && p.UserID != "" {
		createdBy = p.UserID
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE device_pairings SET claimed_app = ?, expires_at = ?
	    WHERE device_id = ? AND claimed_app IS NULL AND expires_at > ?`, app, s.iso(now.Add(DeliveryGrace)), deviceID, nowISO)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return fail() // claimed concurrently
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO devices (id, app, name, model, version, serial, created_by, created_at)
	    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, deviceID, app, clip(name), model, version, serial, createdBy, nowISO); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.claimThrottle.Succeed(account)
	s.record(ctx, audit.Event{Action: auditPairClaim, IP: strPtr(ip), TargetType: strPtr(auditTargetType), TargetID: &deviceID,
		Meta: map[string]string{"app": app}}, p)
	return s.Get(ctx, app, deviceID)
}

const deviceCols = `id, app, name, model, version, serial, credential_hash IS NOT NULL, last_seen_at, last_ip,
  capabilities_json, status_json, config_rev, created_at, created_by`

type scanner interface{ Scan(...any) error }

func (s *Service) scanDevice(r scanner) (*Device, error) {
	var (
		d                       Device
		model, version, serial  sql.NullString
		lastSeen, lastIP        sql.NullString
		caps, status, createdBy sql.NullString
	)
	if err := r.Scan(&d.ID, &d.App, &d.Name, &model, &version, &serial, &d.Paired, &lastSeen, &lastIP,
		&caps, &status, &d.ConfigRev, &d.CreatedAt, &createdBy); err != nil {
		return nil, err
	}
	d.Model, d.Version, d.Serial = nsPtr(model), nsPtr(version), nsPtr(serial)
	d.LastSeenAt, d.LastIP, d.CreatedBy = nsPtr(lastSeen), nsPtr(lastIP), nsPtr(createdBy)
	d.Capabilities, d.Status = rawOrNull(caps), rawOrNull(status)
	d.Online = s.gw != nil && s.gw.IsConnected(d.ID)
	d.Channels = []DeviceChannel{}
	return &d, nil
}

// List returns the app's devices, newest first.
func (s *Service) List(ctx context.Context, app string) ([]Device, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+deviceCols+` FROM devices WHERE app = ? ORDER BY created_at DESC, id`, app)
	if err != nil {
		return nil, err
	}
	out := []Device{}
	for rows.Next() {
		d, err := s.scanDevice(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, *d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Channels, err = s.channels(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Get returns one device of app (404 for a device of another app).
func (s *Service) Get(ctx context.Context, app, id string) (*Device, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	d, err := s.scanDevice(s.db.QueryRowContext(ctx, `SELECT `+deviceCols+` FROM devices WHERE id = ? AND app = ?`, id, app))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.NotFound(msgNotFound)
	}
	if err != nil {
		return nil, err
	}
	if d.Channels, err = s.channels(ctx, id); err != nil {
		return nil, err
	}
	return d, nil
}

// Rename sets the display name.
func (s *Service) Rename(ctx context.Context, app, id, name string) (*Device, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET name = ? WHERE id = ? AND app = ?`, clip(strings.TrimSpace(name)), id, app)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, httpx.NotFound(msgNotFound)
	}
	s.pushConfig(ctx, id)
	return s.Get(ctx, app, id)
}

// DeviceRevokeResult is DELETE /apps/{app}/devices/{id}.data.
type DeviceRevokeResult struct {
	ID      string `json:"id"`
	Revoked bool   `json:"revoked"`
}

// Revoke deletes the device: its credential stops working at once (the
// live socket is closed 4401), its channels' ingress keys are torn down so
// a revoked device can't keep publishing with them, and a pending pairing
// is burnt.
func (s *Service) Revoke(ctx context.Context, app, id string, p *auth.Principal, ip string) (*DeviceRevokeResult, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id = ? AND app = ?`, id, app).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, httpx.NotFound(msgNotFound)
		}
		return nil, err
	}
	chans, err := s.channels(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, c := range chans {
		s.dropIngress(ctx, app, c.IngressID)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM device_channels WHERE device_id = ?`,
		`DELETE FROM device_pairings WHERE device_id = ?`,
		`DELETE FROM devices WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if s.gw != nil {
		s.gw.Kick(id, CloseRevoked, "revoked")
	}
	s.record(ctx, audit.Event{Action: auditRevoke, IP: strPtr(ip), TargetType: strPtr(auditTargetType), TargetID: &id,
		Meta: map[string]string{"app": app}}, p)
	return &DeviceRevokeResult{ID: id, Revoked: true}, nil
}

// ---------------------------------------------------------------------------
// device-side state (gateway)
// ---------------------------------------------------------------------------

// authRow is what the gateway needs of an authenticated device.
type authRow struct {
	ID, App string
}

// Authenticate verifies a `dk_` credential: its device must exist, have a
// delivered credential and the hash must match (constant time).
func (s *Service) Authenticate(ctx context.Context, cred string) (*authRow, bool) {
	id, ok := ParseCredential(cred)
	if !ok {
		return nil, false
	}
	var (
		app  string
		hash sql.NullString
	)
	if err := s.db.QueryRowContext(ctx, `SELECT app, credential_hash FROM devices WHERE id = ?`, id).Scan(&app, &hash); err != nil {
		return nil, false
	}
	if !hash.Valid || !secretMatches(cred, hash.String) {
		return nil, false
	}
	return &authRow{ID: id, App: app}, true
}

func (s *Service) recordHello(ctx context.Context, id, ip string, f *inFrame) {
	caps := sql.NullString{}
	if len(f.Capabilities) > 0 && len(f.Capabilities) <= maxCapsBytes && json.Valid(f.Capabilities) {
		caps = sql.NullString{String: string(f.Capabilities), Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET
	    model = COALESCE(?, model), version = COALESCE(?, version), serial = COALESCE(?, serial),
	    capabilities_json = COALESCE(?, capabilities_json), last_seen_at = ?, last_ip = ? WHERE id = ?`,
		nullable(clip(f.Model)), nullable(clip(f.Version)), nullable(clip(f.Serial)), caps, s.iso(s.now()), nullable(ip), id)
	if err != nil {
		s.log.Warn("device hello persist failed", "deviceId", id, "err", err)
	}
}

func (s *Service) recordStatus(ctx context.Context, id string, raw []byte) {
	if len(raw) > maxStatusBytes {
		return
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	delete(m, "type")
	m["receivedAt"], _ = json.Marshal(s.iso(s.now()))
	js, _ := json.Marshal(m)
	if _, err := s.db.ExecContext(ctx, `UPDATE devices SET status_json = ?, last_seen_at = ? WHERE id = ?`, string(js), s.iso(s.now()), id); err != nil {
		s.log.Warn("device status persist failed", "deviceId", id, "err", err)
	}
}

func (s *Service) touch(ctx context.Context, id string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, s.iso(s.now()), id)
}

// BuildConfig is the device's desired configuration.
func (s *Service) BuildConfig(ctx context.Context, id string) (*ConfigFrame, error) {
	var (
		f       = ConfigFrame{Type: FrameConfig, Channels: []ConfigChannel{}}
		app, nm string
		rev     int64
	)
	if err := s.db.QueryRowContext(ctx, `SELECT app, name, config_rev FROM devices WHERE id = ?`, id).Scan(&app, &nm, &rev); err != nil {
		return nil, err
	}
	f.Rev, f.Device = rev, ConfigDevice{ID: id, Name: nm, App: app}
	chans, err := s.channels(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, c := range chans {
		f.Channels = append(f.Channels, ConfigChannel{ID: c.ID, Name: c.Name, Room: c.Room, Protocol: c.Protocol,
			PublishURL: c.PublishURL, StreamKey: c.StreamKey, IngressID: c.IngressID})
	}
	return &f, nil
}

// pushConfig bumps the revision and pushes the config to a live device.
func (s *Service) pushConfig(ctx context.Context, id string) {
	if _, err := s.db.ExecContext(ctx, `UPDATE devices SET config_rev = config_rev + 1 WHERE id = ?`, id); err != nil {
		return
	}
	if s.gw == nil || !s.gw.IsConnected(id) {
		return
	}
	if f, err := s.BuildConfig(ctx, id); err == nil {
		s.gw.Send(id, f)
	}
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

// CommandInput is POST /apps/{app}/devices/{id}/commands.
type CommandInput struct {
	Action, Channel, Preset string
}

// Command sends one command to a connected device and awaits its result.
func (s *Service) Command(ctx context.Context, app, id string, in CommandInput, p *auth.Principal, ip string) (*DeviceCommandResult, error) {
	if err := s.disabled(); err != nil {
		return nil, err
	}
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM devices WHERE id = ? AND app = ?`, id, app).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, httpx.NotFound(msgNotFound)
		}
		return nil, err
	}
	if s.gw == nil || !s.gw.IsConnected(id) {
		return nil, httpx.Unavailable(msgNotConnected)
	}
	res, err := s.gw.Command(id, CommandFrame{Type: FrameCommand, Action: in.Action, Channel: in.Channel, Preset: in.Preset}, CommandTimeout)
	meta := map[string]any{"app": app, "action": in.Action, "channel": in.Channel}
	if err != nil {
		meta["error"] = err.Error()
	} else {
		meta["ok"] = res.OK
	}
	s.record(ctx, audit.Event{Action: auditCommand, IP: strPtr(ip), TargetType: strPtr(auditTargetType), TargetID: &id, Meta: meta}, p)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func (s *Service) record(ctx context.Context, e audit.Event, p *auth.Principal) {
	if s.audit == nil {
		return
	}
	if p != nil {
		e = e.WithActor(p)
	}
	s.audit.RecordCtx(ctx, e)
}

func (s *Service) recordOffense(ip string) {
	if s.offense != nil && ip != "" {
		s.offense(ip)
	}
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nsPtr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	v := n.String
	return &v
}

func rawOrNull(n sql.NullString) json.RawMessage {
	if !n.Valid || n.String == "" {
		return json.RawMessage("null")
	}
	return json.RawMessage(n.String)
}

// clip bounds a device-supplied string.
func clip(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > maxFieldLen {
		s = s[:maxFieldLen]
	}
	return s
}
