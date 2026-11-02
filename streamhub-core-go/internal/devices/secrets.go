package devices

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

// newCode draws a CodeLength code from CodeAlphabet, unbiased (rejection
// sampling over crypto/rand bytes).
func newCode() string {
	const n = len(CodeAlphabet)
	limit := 256 - 256%n // largest multiple of n ≤ 256
	out := make([]byte, 0, CodeLength)
	buf := make([]byte, 16)
	for len(out) < CodeLength {
		if _, err := rand.Read(buf); err != nil {
			panic(err) // crypto/rand never fails on supported platforms
		}
		for _, b := range buf {
			if int(b) < limit && len(out) < CodeLength {
				out = append(out, CodeAlphabet[int(b)%n])
			}
		}
	}
	return string(out)
}

// NormalizeCode upper-cases a typed code and drops separators (space, dash,
// dot); ok=false unless the result is exactly CodeLength alphabet symbols.
func NormalizeCode(raw string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(raw) {
		switch r {
		case ' ', '-', '.', '_', '\t':
			continue
		}
		if !strings.ContainsRune(CodeAlphabet, r) {
			return "", false
		}
		b.WriteRune(r)
	}
	if b.Len() != CodeLength {
		return "", false
	}
	return b.String(), true
}

// DisplayCode formats a code as XXXX-XXXX for screens.
func DisplayCode(code string) string {
	if len(code) != CodeLength {
		return code
	}
	return code[:4] + "-" + code[4:]
}

func randToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func newDeviceID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return DeviceIDPrefix + hex.EncodeToString(b)
}

// newCredential mints `dk_<deviceId>.<secret>`: the id lets the gateway
// find the row, the whole string is what gets hashed and compared.
func newCredential(deviceID string) string {
	return CredentialPrefix + deviceID + "." + randToken(32)
}

// ParseCredential extracts the device id of a `dk_<id>.<secret>`.
func ParseCredential(cred string) (deviceID string, ok bool) {
	rest, found := strings.CutPrefix(cred, CredentialPrefix)
	if !found {
		return "", false
	}
	id, secret, found := strings.Cut(rest, ".")
	if !found || !strings.HasPrefix(id, DeviceIDPrefix) || len(id) > 64 || len(secret) < 32 {
		return "", false
	}
	return id, true
}

// hashSecret is the at-rest form of codes, poll tokens and credentials.
func hashSecret(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// secretMatches compares a presented secret with a stored hash in constant
// time; blanks never match.
func secretMatches(presented, storedHash string) bool {
	if presented == "" || storedHash == "" {
		return false
	}
	got := hashSecret(presented)
	return subtle.ConstantTimeCompare([]byte(got), []byte(storedHash)) == 1
}
