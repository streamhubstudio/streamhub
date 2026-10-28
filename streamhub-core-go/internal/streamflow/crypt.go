package streamflow

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"regexp"
	"strings"

	"golang.org/x/crypto/hkdf"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
	y "github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of secret-crypt.util.ts: per-app AES-256-GCM for streamflow secrets.
//
//	key(app) = HKDF-SHA256(ikm = STREAMHUB_JWT_SECRET, salt = 'streamflow-secret',
//	                       info = 'app:' + app, len = 32)
//
// Wire format: aesgcm$<iv>$<tag>$<ct>, base64url without padding.

const (
	cryptPrefix = "aesgcm"
	cryptSalt   = "streamflow-secret"
)

var b64url = base64.RawURLEncoding

func deriveKey(master, app string) []byte {
	key := make([]byte, 32)
	_, _ = io.ReadFull(hkdf.New(sha256.New, []byte(master), []byte(cryptSalt), []byte("app:"+app)), key)
	return key
}

// encryptSecret encrypts plaintext for app → aesgcm$iv$tag$ct.
func encryptSecret(plaintext, master, app string) (string, error) {
	if master == "" {
		return "", errors.New("encryptSecret: empty master secret")
	}
	if app == "" {
		return "", errors.New("encryptSecret: empty app")
	}
	block, err := aes.NewCipher(deriveKey(master, app))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	ct, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	return strings.Join([]string{cryptPrefix, b64url.EncodeToString(iv), b64url.EncodeToString(tag), b64url.EncodeToString(ct)}, "$"), nil
}

// decryptSecret returns ("", false) on any malformed / foreign / tampered value.
func decryptSecret(stored, master, app string) (string, bool) {
	if stored == "" || master == "" || app == "" {
		return "", false
	}
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != cryptPrefix {
		return "", false
	}
	dec := func(s string) []byte { b, _ := b64url.DecodeString(strings.TrimRight(s, "=")); return b }
	iv, tag, ct := dec(parts[1]), dec(parts[2]), dec(parts[3])
	block, err := aes.NewCipher(deriveKey(master, app))
	if err != nil {
		return "", false
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, max(1, len(iv)))
	if err != nil || len(tag) != gcm.Overhead() {
		return "", false
	}
	pt, err := gcm.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", false
	}
	return string(pt), true
}

var maskPrefix = regexp.MustCompile(`^(sk-|sk_|ghp_|xox[a-z]-|AKIA)`)

// maskSecret shows a prefix hint + the last 4 chars (sk-…a1b2).
func maskSecret(value string) string {
	v := strings.TrimSpace(value)
	if v == "" {
		return ""
	}
	if jsx.UTF16Len(v) <= 4 {
		return "…"
	}
	last4 := utf16Tail(v, 4)
	head := jsx.UTF16Slice(v, 2)
	if m := maskPrefix.FindString(v); m != "" {
		head = m
	}
	return head + "…" + last4
}

// looksMasked: the write-only mask sentinel form (never persisted).
func looksMasked(v string) bool { return strings.Contains(v, "…") }

// utf16Tail is s.slice(-n) in UTF-16 units.
func utf16Tail(s string, n int) string {
	l := jsx.UTF16Len(s)
	if l <= n {
		return s
	}
	head := jsx.UTF16Slice(s, l-n)
	return s[len(head):]
}

// redactSecretValues deep-scrubs every needle (≥ 4 chars) to [redacted].
func redactSecretValues(v any, needles []string) any {
	var found []string
	for _, n := range needles {
		if jsx.UTF16Len(n) >= 4 {
			found = append(found, n)
		}
	}
	if len(found) == 0 {
		return v
	}
	var scrub func(any) any
	scrub = func(v any) any {
		switch x := v.(type) {
		case string:
			for _, n := range found {
				x = strings.ReplaceAll(x, n, "[redacted]")
			}
			return x
		case []any:
			out := make([]any, len(x))
			for i, e := range x {
				out[i] = scrub(e)
			}
			return out
		case *y.Map:
			if x == nil {
				return x
			}
			out := y.NewMap()
			for _, k := range x.Keys() {
				out.Set(k, scrub(x.Get(k)))
			}
			return out
		}
		return v
	}
	return scrub(v)
}
