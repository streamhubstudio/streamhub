package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// User is a local account as persisted in users.json.
type User struct {
	Name               string    `json:"name"`
	Role               Role      `json:"role"`
	PasswordHash       string    `json:"passwordHash"`
	MustChangePassword bool      `json:"mustChangePassword"`
	CreatedAt          time.Time `json:"createdAt"`
	Disabled           bool      `json:"disabled"`
}

// Token is an API token as persisted in users.json (only its SHA-256).
type Token struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Role       Role      `json:"role"`
	Hash       string    `json:"hash"` // hex sha256 of the plaintext token
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt,omitzero"`
	Revoked    bool      `json:"revoked"`
}

// UserInfo is the public view of a User (no hash).
type UserInfo struct {
	Name               string    `json:"name"`
	Role               Role      `json:"role"`
	MustChangePassword bool      `json:"mustChangePassword"`
	CreatedAt          time.Time `json:"createdAt"`
	Disabled           bool      `json:"disabled"`
}

// TokenInfo is the public view of a Token (no hash).
type TokenInfo struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Role       Role      `json:"role"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt,omitzero"`
	Revoked    bool      `json:"revoked"`
}

// UserPatch is a partial update of a user (nil = unchanged). Setting Password
// without MustChangePassword forces a change at next login.
type UserPatch struct {
	Role               *Role   `json:"role,omitempty"`
	Password           *string `json:"password,omitempty"`
	Disabled           *bool   `json:"disabled,omitempty"`
	MustChangePassword *bool   `json:"mustChangePassword,omitempty"`
}

func (u User) info() UserInfo {
	return UserInfo{Name: u.Name, Role: u.Role, MustChangePassword: u.MustChangePassword, CreatedAt: u.CreatedAt, Disabled: u.Disabled}
}

func (t Token) info() TokenInfo {
	return TokenInfo{ID: t.ID, Name: t.Name, Role: t.Role, CreatedAt: t.CreatedAt, LastUsedAt: t.LastUsedAt, Revoked: t.Revoked}
}

// Typed errors, mapped to HTTP statuses by the handlers.
type (
	invalidErr  string // 422
	conflictErr string // 409
	notFoundErr string // 404
)

func (e invalidErr) Error() string  { return string(e) }
func (e conflictErr) Error() string { return string(e) }
func (e notFoundErr) Error() string { return string(e) }

const storeVersion = 1

type fileData struct {
	Version int     `json:"version"`
	Users   []User  `json:"users"`
	Tokens  []Token `json:"tokens"`
}

// store is users.json: loaded once, every mutation rewritten atomically.
type store struct {
	path  string
	mu    sync.Mutex
	data  fileData
	dirty bool // token lastUsedAt changed but not persisted yet
}

func openStore(path string) (*store, error) {
	s := &store{path: path, data: fileData{Version: storeVersion}}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		// Never overwrite an unreadable store: that would silently reset accounts.
		return nil, fmt.Errorf("auth: %s is corrupt: %w", path, err)
	}
	if s.data.Version > storeVersion {
		return nil, fmt.Errorf("auth: %s has schema %d, newer than this encoderd (%d)", path, s.data.Version, storeVersion)
	}
	if fi, err := os.Stat(path); err == nil && fi.Mode().Perm() != 0o600 {
		_ = os.Chmod(path, 0o600)
	}
	return s, nil
}

func (s *store) clone() fileData {
	return fileData{Version: storeVersion, Users: slices.Clone(s.data.Users), Tokens: slices.Clone(s.data.Tokens)}
}

// update applies fn to a copy and persists it; memory changes only on success.
func (s *store) update(fn func(d *fileData) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.clone()
	if err := fn(&next); err != nil {
		return err
	}
	if err := s.save(next); err != nil {
		return err
	}
	s.data, s.dirty = next, false
	return nil
}

func (s *store) save(d fileData) error {
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, append(b, '\n'), 0o600)
}

// flush persists pending lastUsedAt updates.
func (s *store) flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty {
		return nil
	}
	if err := s.save(s.data); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

func (s *store) userCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.data.Users)
}

func (s *store) getUser(name string) (User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := findUser(s.data.Users, name); i >= 0 {
		return s.data.Users[i], true
	}
	return User{}, false
}

func (s *store) snapshot() fileData {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clone()
}

// tokenByHash scans every token with a constant-time comparison.
func (s *store) tokenByHash(sum [32]byte) (Token, bool) {
	want := []byte(hex.EncodeToString(sum[:]))
	s.mu.Lock()
	defer s.mu.Unlock()
	found := -1
	for i, t := range s.data.Tokens {
		if subtle.ConstantTimeCompare([]byte(t.Hash), want) == 1 {
			found = i
		}
	}
	if found < 0 {
		return Token{}, false
	}
	return s.data.Tokens[found], true
}

// touchToken records a use. It is persisted at most once a minute per token
// (and on Close) so a busy integration does not rewrite users.json on every
// request.
func (s *store) touchToken(id string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.data.Tokens, func(t Token) bool { return t.ID == id })
	if i < 0 {
		return nil
	}
	prev := s.data.Tokens[i].LastUsedAt
	s.data.Tokens[i].LastUsedAt = now.UTC()
	s.dirty = true
	if now.Sub(prev) < time.Minute {
		return nil
	}
	if err := s.save(s.data); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

func findUser(us []User, name string) int {
	return slices.IndexFunc(us, func(u User) bool { return u.Name == name })
}

func enabledAdmins(us []User) int {
	n := 0
	for _, u := range us {
		if u.Role == RoleAdmin && !u.Disabled {
			n++
		}
	}
	return n
}

var nameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

// normalizeName lower-cases and validates a user name.
func normalizeName(n string) (string, error) {
	n = strings.ToLower(strings.TrimSpace(n))
	if !nameRe.MatchString(n) {
		return "", invalidErr("user name must be 1-32 chars of a-z 0-9 . _ - (starting with a letter or digit)")
	}
	return n, nil
}

// Users lists the accounts (no password hashes), sorted by name.
func (a *Auth) Users() []UserInfo {
	d := a.store.snapshot()
	out := make([]UserInfo, 0, len(d.Users))
	for _, u := range d.Users {
		out = append(out, u.info())
	}
	slices.SortFunc(out, func(x, y UserInfo) int { return strings.Compare(x.Name, y.Name) })
	return out
}

// CreateUser adds a local account.
func (a *Auth) CreateUser(name, password string, role Role, mustChangePassword bool) (UserInfo, error) {
	name, err := normalizeName(name)
	if err != nil {
		return UserInfo{}, err
	}
	if !role.Valid() {
		return UserInfo{}, invalidErr("role must be admin, operator or viewer")
	}
	hash, err := a.hashPassword(password)
	if err != nil {
		return UserInfo{}, err
	}
	u := User{Name: name, Role: role, PasswordHash: hash, MustChangePassword: mustChangePassword, CreatedAt: a.now().UTC()}
	err = a.store.update(func(d *fileData) error {
		if findUser(d.Users, name) >= 0 {
			return conflictErr("user " + name + " already exists")
		}
		d.Users = append(d.Users, u)
		return nil
	})
	if err != nil {
		return UserInfo{}, err
	}
	return u.info(), nil
}

// UpdateUser changes role, password, disabled and/or mustChangePassword. The
// last enabled admin can not be demoted or disabled. A password reset or a
// disable ends the user's sessions.
func (a *Auth) UpdateUser(name string, p UserPatch) (UserInfo, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if p.Role != nil && !p.Role.Valid() {
		return UserInfo{}, invalidErr("role must be admin, operator or viewer")
	}
	var hash string
	if p.Password != nil {
		h, err := a.hashPassword(*p.Password)
		if err != nil {
			return UserInfo{}, err
		}
		hash = h
	}
	var res User
	err := a.store.update(func(d *fileData) error {
		i := findUser(d.Users, name)
		if i < 0 {
			return notFoundErr("user " + name + " not found")
		}
		u := d.Users[i]
		wasAdmin := u.Role == RoleAdmin && !u.Disabled
		if p.Role != nil {
			u.Role = *p.Role
		}
		if p.Disabled != nil {
			u.Disabled = *p.Disabled
		}
		if p.Password != nil {
			u.PasswordHash = hash
			u.MustChangePassword = true
		}
		if p.MustChangePassword != nil {
			u.MustChangePassword = *p.MustChangePassword
		}
		if wasAdmin && (u.Role != RoleAdmin || u.Disabled) && enabledAdmins(d.Users) <= 1 {
			return conflictErr("cannot demote or disable the last admin")
		}
		d.Users[i] = u
		res = u
		return nil
	})
	if err != nil {
		return UserInfo{}, err
	}
	if p.Password != nil || res.Disabled {
		a.sessions.deleteUser(name, "")
	}
	return res.info(), nil
}

// SetPassword resets a user's password (CLI recovery path).
func (a *Auth) SetPassword(name, password string, mustChangePassword bool) error {
	_, err := a.UpdateUser(name, UserPatch{Password: &password, MustChangePassword: &mustChangePassword})
	return err
}

// DeleteUser removes an account and ends its sessions; the last enabled admin
// can not be deleted.
func (a *Auth) DeleteUser(name string) error {
	name = strings.ToLower(strings.TrimSpace(name))
	err := a.store.update(func(d *fileData) error {
		i := findUser(d.Users, name)
		if i < 0 {
			return notFoundErr("user " + name + " not found")
		}
		u := d.Users[i]
		if u.Role == RoleAdmin && !u.Disabled && enabledAdmins(d.Users) <= 1 {
			return conflictErr("cannot delete the last admin")
		}
		d.Users = slices.Delete(d.Users, i, i+1)
		return nil
	})
	if err == nil {
		a.sessions.deleteUser(name, "")
	}
	return err
}

// changeOwnPassword verifies current and sets next (clearing
// mustChangePassword).
func (a *Auth) changeOwnPassword(name, current, next string) error {
	u, ok := a.store.getUser(name)
	if !ok || u.Disabled {
		return notFoundErr("user " + name + " not found")
	}
	if !a.verifyPassword(u.PasswordHash, current) {
		return errBadCurrentPassword
	}
	if current == next {
		return invalidErr("the new password must differ from the current one")
	}
	hash, err := a.hashPassword(next)
	if err != nil {
		return err
	}
	return a.store.update(func(d *fileData) error {
		i := findUser(d.Users, name)
		if i < 0 {
			return notFoundErr("user " + name + " not found")
		}
		d.Users[i].PasswordHash = hash
		d.Users[i].MustChangePassword = false
		return nil
	})
}

var errBadCurrentPassword = errors.New("current password is wrong")

// Tokens lists the API tokens (no hashes), newest first.
func (a *Auth) Tokens() []TokenInfo {
	d := a.store.snapshot()
	out := make([]TokenInfo, 0, len(d.Tokens))
	for _, t := range d.Tokens {
		out = append(out, t.info())
	}
	slices.SortStableFunc(out, func(x, y TokenInfo) int { return y.CreatedAt.Compare(x.CreatedAt) })
	return out
}

// TokenPrefix starts every API token.
const TokenPrefix = "ek_"

// CreateToken mints an API token. The plaintext ("ek_" + base64url of 32
// random bytes) is returned once and never stored — only its SHA-256.
func (a *Auth) CreateToken(name string, role Role) (TokenInfo, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 64 {
		return TokenInfo{}, "", invalidErr("token name must be 1-64 characters")
	}
	if !role.Valid() {
		return TokenInfo{}, "", invalidErr("role must be admin, operator or viewer")
	}
	plain := TokenPrefix + randomString(32)
	sum := sha256.Sum256([]byte(plain))
	t := Token{ID: "tk_" + hex.EncodeToString(randomBytes(6)), Name: name, Role: role,
		Hash: hex.EncodeToString(sum[:]), CreatedAt: a.now().UTC()}
	if err := a.store.update(func(d *fileData) error { d.Tokens = append(d.Tokens, t); return nil }); err != nil {
		return TokenInfo{}, "", err
	}
	return t.info(), plain, nil
}

// RevokeToken revokes a token (the record is kept for the audit trail).
func (a *Auth) RevokeToken(id string) error {
	return a.store.update(func(d *fileData) error {
		i := slices.IndexFunc(d.Tokens, func(t Token) bool { return t.ID == id })
		if i < 0 {
			return notFoundErr("token " + id + " not found")
		}
		d.Tokens[i].Revoked = true
		return nil
	})
}

// writeFileAtomic writes via tmp file + fsync + rename + dir fsync.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
