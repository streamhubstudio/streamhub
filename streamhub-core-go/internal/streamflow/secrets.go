package streamflow

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of streamflow-secrets.service.ts: the per-app, WRITE-ONLY secrets
// manager. Values are encrypted at rest (crypt.go); list returns masked
// metadata only; plaintext exists in-process at run time (expandConfig).

var (
	secretNameRe = regexp.MustCompile(`^[A-Z0-9_]{1,64}$`)
	secretRefRe  = regexp.MustCompile(`\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}`)
)

// Secrets is StreamflowSecretsService.
type Secrets struct {
	store     *Store
	apps      AppSource
	jwtSecret string
}

// NewSecrets builds the service.
func NewSecrets(store *Store, apps AppSource, jwtSecret string) *Secrets {
	return &Secrets{store: store, apps: apps, jwtSecret: jwtSecret}
}

// List returns masked metadata (no values).
func (s *Secrets) List(ctx context.Context, app string) ([]SecretMeta, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	return s.store.ListSecretMeta(ctx, app, dir)
}

// Put encrypts + stores a secret; returns its masked metadata.
func (s *Secrets) Put(ctx context.Context, app, name, value string) (*SecretMeta, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(name)
	if !secretNameRe.MatchString(key) {
		return nil, httpx.BadRequest("secret name must be UPPER_SNAKE_CASE (A–Z, 0–9, _), 1–64 chars")
	}
	if strings.TrimSpace(value) == "" {
		return nil, httpx.BadRequest("secret value is required")
	}
	if looksMasked(value) {
		return nil, httpx.BadRequest("refusing to store a masked value")
	}
	if s.jwtSecret == "" {
		return nil, httpx.BadRequest("STREAMHUB_JWT_SECRET is not set — cannot encrypt secrets")
	}
	enc, err := encryptSecret(value, s.jwtSecret, app)
	if err != nil {
		return nil, err
	}
	last4 := ""
	if jsx.UTF16Len(value) > 4 {
		last4 = utf16Tail(value, 4)
	}
	if err := s.store.SetSecret(ctx, app, dir, key, enc, last4); err != nil {
		return nil, err
	}
	return &SecretMeta{Name: key, Last4: last4}, nil
}

// Remove deletes a secret (404 when absent).
func (s *Secrets) Remove(ctx context.Context, app, name string) (map[string]bool, error) {
	dir, err := requireApp(ctx, s.apps, app)
	if err != nil {
		return nil, err
	}
	ok, err := s.store.DeleteSecret(ctx, app, dir, strings.TrimSpace(name))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpx.NotFound(fmt.Sprintf("secret '%s' not found", name))
	}
	return map[string]bool{"deleted": true}, nil
}

// resolve returns one secret's plaintext ("" when absent / undecryptable).
func (s *Secrets) resolve(ctx context.Context, app, appDir, name string) string {
	enc, ok := s.store.GetSecretEnc(ctx, app, appDir, name)
	if !ok || s.jwtSecret == "" {
		return ""
	}
	v, _ := decryptSecret(enc, s.jwtSecret, app)
	return v
}

// expandConfig replaces every {{secret.NAME}} with its plaintext into a
// fresh copy (the original keeps the ref) and reports the values used.
func (s *Secrets) expandConfig(ctx context.Context, app, appDir string, config *y.Map) (*y.Map, []string) {
	cache := map[string]string{}
	var used []string
	usedSet := map[string]bool{}
	lookup := func(name string) string {
		if v, ok := cache[name]; ok {
			return v
		}
		v := s.resolve(ctx, app, appDir, name)
		cache[name] = v
		if v != "" && !usedSet[v] {
			usedSet[v] = true
			used = append(used, v)
		}
		return v
	}
	var expand func(any) any
	expand = func(v any) any {
		switch x := v.(type) {
		case string:
			if !strings.Contains(x, "{{") {
				return x
			}
			return secretRefRe.ReplaceAllStringFunc(x, func(m string) string {
				return lookup(secretRefRe.FindStringSubmatch(m)[1])
			})
		case []any:
			out := make([]any, len(x))
			for i, e := range x {
				out[i] = expand(e)
			}
			return out
		case *y.Map:
			if x == nil {
				return x
			}
			out := y.NewMap()
			for _, k := range x.Keys() {
				out.Set(k, expand(x.Get(k)))
			}
			return out
		}
		return v
	}
	if config == nil {
		config = y.NewMap()
	}
	return expand(config).(*y.Map), used
}
