package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Store persists the Config as one JSON file, written atomically
// (temp file + fsync + rename) so a power cut never leaves a torn config.
// A copy of the previous version is kept as <file>.bak.
type Store struct {
	path string
	mu   sync.Mutex
	cfg  Config
}

// Open loads (or initialises) the config at path.
func Open(path string) (*Store, error) {
	s := &Store{path: path}
	b, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		s.cfg = Config{Version: SchemaVersion, Channels: []Channel{}}
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(b, &s.cfg); err != nil {
			return nil, fmt.Errorf("config %s: %w", path, err)
		}
	}
	if s.cfg.Version == 0 {
		s.cfg.Version = SchemaVersion
	}
	if s.cfg.Version > SchemaVersion {
		return nil, fmt.Errorf("config %s has schema v%d, this encoderd supports ≤ v%d", path, s.cfg.Version, SchemaVersion)
	}
	if s.cfg.Device.ID == "" {
		s.cfg.Device.ID = "enc-" + RandomHex(6)
	}
	if s.cfg.Channels == nil {
		s.cfg.Channels = []Channel{}
	}
	for i := range s.cfg.Channels {
		s.cfg.Channels[i].ApplyDefaults()
	}
	if err := s.writeLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

// RandomHex returns n random bytes hex-encoded.
func RandomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Get returns a deep copy of the config.
func (s *Store) Get() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.cfg)
}

// Update applies fn to a copy, validates it and persists it. fn's error or a
// validation error aborts without touching the stored config.
func (s *Store) Update(fn func(c *Config) error) (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := clone(s.cfg)
	if err := fn(&next); err != nil {
		return Config{}, err
	}
	for i := range next.Channels {
		next.Channels[i].ApplyDefaults()
	}
	if err := next.Validate().Err(); err != nil {
		return Config{}, err
	}
	prev := s.cfg
	s.cfg = next
	if err := s.writeLocked(); err != nil {
		s.cfg = prev
		return Config{}, err
	}
	return clone(s.cfg), nil
}

func (s *Store) writeLocked() error {
	b, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	if old, err := os.ReadFile(s.path); err == nil && string(old) != string(b) {
		_ = os.WriteFile(s.path+".bak", old, 0o600)
	}
	tmp, err := os.CreateTemp(dir, ".encoderd-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

func clone(c Config) Config {
	b, _ := json.Marshal(c)
	var out Config
	_ = json.Unmarshal(b, &out)
	if out.Channels == nil {
		out.Channels = []Channel{}
	}
	return out
}

// FindChannel returns the index of channel id or -1.
func (c *Config) FindChannel(id string) int {
	for i := range c.Channels {
		if c.Channels[i].ID == id {
			return i
		}
	}
	return -1
}

// FindOutput returns the index of output id or -1.
func (c *Channel) FindOutput(id string) int {
	for i := range c.Outputs {
		if c.Outputs[i].ID == id {
			return i
		}
	}
	return -1
}

// FindOutputCfg returns the output with id.
func (c *Channel) FindOutputCfg(id string) (Output, bool) {
	if i := c.FindOutput(id); i >= 0 {
		return c.Outputs[i], true
	}
	return Output{}, false
}
