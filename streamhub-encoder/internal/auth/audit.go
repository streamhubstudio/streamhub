package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

const (
	auditMaxBytes = 10 << 20 // rotate at 10 MB
	auditBackups  = 4        // audit.log + audit.log.1…4 = 5 files
	maxAuditLimit = 5000
)

// AuditEntry is one line of <dataDir>/audit.log. Bodies, credentials and
// query strings are never recorded.
type AuditEntry struct {
	At         time.Time `json:"at"`
	Event      string    `json:"event"` // request | login | login_failed | logout | password_change
	Principal  string    `json:"principal"`
	Role       Role      `json:"role,omitempty"`
	Kind       Kind      `json:"kind,omitempty"`
	TokenID    string    `json:"tokenId,omitempty"`
	IP         string    `json:"ip"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	Status     int       `json:"status"`
	DurationMs int64     `json:"durationMs"`
}

// auditLog appends JSON lines with size-based rotation.
type auditLog struct {
	path    string
	max     int64
	backups int

	mu   sync.Mutex
	f    *os.File
	size int64
}

func openAudit(path string, max int64, backups int) (*auditLog, error) {
	l := &auditLog{path: path, max: max, backups: backups}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *auditLog) open() error {
	f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, fi.Size()
	return nil
}

func (l *auditLog) backup(i int) string { return fmt.Sprintf("%s.%d", l.path, i) }

// rotate shifts audit.log → .1 → … → .N (dropping the oldest).
func (l *auditLog) rotate() error {
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
	_ = os.Remove(l.backup(l.backups))
	for i := l.backups - 1; i >= 1; i-- {
		_ = os.Rename(l.backup(i), l.backup(i+1))
	}
	if err := os.Rename(l.path, l.backup(1)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return l.open()
}

// Write appends one entry.
func (l *auditLog) Write(e AuditEntry) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		if err := l.open(); err != nil {
			return err
		}
	}
	if l.size > 0 && l.size+int64(len(b)) > l.max {
		if err := l.rotate(); err != nil {
			return err
		}
	}
	n, err := l.f.Write(b)
	l.size += int64(n)
	return err
}

func (l *auditLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// Tail returns up to limit raw JSON lines, newest first, across the current
// file and its backups.
func (l *auditLog) Tail(limit int) ([]json.RawMessage, error) {
	if limit <= 0 {
		return []json.RawMessage{}, nil
	}
	// Hold the lock so a concurrent rotation can not shuffle the files.
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]json.RawMessage, 0, min(limit, 256))
	files := []string{l.path}
	for i := 1; i <= l.backups; i++ {
		files = append(files, l.backup(i))
	}
	for _, p := range files {
		if len(out) >= limit {
			break
		}
		err := tailFile(p, limit-len(out), func(line []byte) {
			if json.Valid(line) {
				out = append(out, json.RawMessage(bytes.Clone(line)))
			}
		})
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return out, err
		}
	}
	return out, nil
}

// tailFile calls fn for up to n lines of p from the last to the first,
// reading backwards in chunks (the file can be 10 MB).
func tailFile(p string, n int, fn func([]byte)) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	const chunk = 64 << 10
	off := fi.Size()
	var rest []byte // partial line carried to the previous chunk
	for off > 0 && n > 0 {
		sz := int64(chunk)
		if off < sz {
			sz = off
		}
		off -= sz
		buf := make([]byte, sz, int(sz)+len(rest))
		if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
			return err
		}
		buf = append(buf, rest...)
		for n > 0 {
			i := bytes.LastIndexByte(buf, '\n')
			if i < 0 {
				break
			}
			if line := bytes.TrimSpace(buf[i+1:]); len(line) > 0 {
				fn(line)
				n--
			}
			buf = buf[:i]
		}
		rest = buf
	}
	if n > 0 {
		if line := bytes.TrimSpace(rest); len(line) > 0 {
			fn(line)
		}
	}
	return nil
}
