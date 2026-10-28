package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

// Password hashing compatible with streamhub-core/src/modules/auth/password.util.ts:
// the stored string is self-describing, scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>,
// so hashes written by the Node core verify here and vice versa.
const (
	scryptN   = 1 << 15
	scryptR   = 8
	scryptP   = 1
	keyLen    = 64
	saltBytes = 16
)

// HashPassword returns a fresh salted scrypt string.
func HashPassword(password string) (string, error) {
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, keyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("scrypt$%d$%d$%d$%s$%s", scryptN, scryptR, scryptP,
		hex.EncodeToString(salt), hex.EncodeToString(dk)), nil
}

// VerifyPassword is a constant-time check; malformed hashes return false.
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	n, err1 := strconv.Atoi(parts[1])
	r, err2 := strconv.Atoi(parts[2])
	p, err3 := strconv.Atoi(parts[3])
	if err1 != nil || err2 != nil || err3 != nil || n == 0 || r == 0 || p == 0 {
		return false
	}
	salt, err := hex.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false
	}
	got, err := scrypt.Key([]byte(password), salt, n, r, p, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// RandomPassword is 256 bits of entropy, base64url (no padding) — as Node.
func RandomPassword() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// HashRandomPassword hashes a password nobody knows (login disabled until reset).
func HashRandomPassword() (string, error) { return HashPassword(RandomPassword()) }
