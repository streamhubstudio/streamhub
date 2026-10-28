package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
)

// APITokenPrefix marks human-readable plaintext API tokens.
const APITokenPrefix = "sk_"

// HashToken is the at-rest form of API tokens and magic links: sha256 hex.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// RandomToken is n random bytes, base64url without padding.
func RandomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b64.EncodeToString(b)
}

// GenerateAPIToken mints a plaintext sk_ token (32 random bytes).
func GenerateAPIToken() string { return APITokenPrefix + RandomToken(32) }
