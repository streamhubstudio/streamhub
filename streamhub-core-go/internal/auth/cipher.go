package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// Reversible at-rest encryption for small auth secrets, wire-compatible with
// streamhub-core/src/modules/auth/secret-cipher.util.ts: AES-256-GCM with a
// key sha256("streamhub-<domain>:<master>") (domain-separated per secret
// kind), stored as aesgcm$<iv>$<tag>$<ciphertext> (base64url, no padding).

const (
	cipherPrefix = "aesgcm"
	ivBytes      = 12
)

func deriveKey(domain, master string) []byte {
	k := sha256.Sum256([]byte("streamhub-" + domain + ":" + master))
	return k[:]
}

func encryptWithDomain(domain, plaintext, master string) (string, error) {
	if master == "" {
		return "", errors.New("encryptSecret: empty master secret")
	}
	block, err := aes.NewCipher(deriveKey(domain, master))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	ct, tag := sealed[:len(sealed)-gcm.Overhead()], sealed[len(sealed)-gcm.Overhead():]
	return strings.Join([]string{cipherPrefix, b64.EncodeToString(iv), b64.EncodeToString(tag), b64.EncodeToString(ct)}, "$"), nil
}

func decryptWithDomain(domain, stored, master string) (string, bool) {
	if stored == "" || master == "" {
		return "", false
	}
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != cipherPrefix {
		return "", false
	}
	iv, err1 := decodeLenient(parts[1])
	tag, err2 := decodeLenient(parts[2])
	ct, err3 := decodeLenient(parts[3])
	if err1 != nil || err2 != nil || err3 != nil || len(iv) == 0 || len(tag) != 16 {
		return "", false
	}
	block, err := aes.NewCipher(deriveKey(domain, master))
	if err != nil {
		return "", false
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return "", false
	}
	pt, err := gcm.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", false
	}
	return string(pt), true
}

// decodeLenient decodes base64url (padding tolerated, like Buffer.from).
func decodeLenient(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// EncryptSecret encrypts a TOTP shared secret.
func EncryptSecret(plaintext, master string) (string, error) {
	return encryptWithDomain("totp", plaintext, master)
}

// DecryptSecret decrypts a TOTP secret; ok=false on any malformed/foreign
// value or authentication failure (never panics).
func DecryptSecret(stored, master string) (string, bool) {
	return decryptWithDomain("totp", stored, master)
}

// EncryptUserSmtpSecret encrypts a per-user SMTP password (own key domain).
func EncryptUserSmtpSecret(plaintext, master string) (string, error) {
	return encryptWithDomain("user-smtp", plaintext, master)
}

// DecryptUserSmtpSecret decrypts a per-user SMTP password.
func DecryptUserSmtpSecret(stored, master string) (string, bool) {
	return decryptWithDomain("user-smtp", stored, master)
}
