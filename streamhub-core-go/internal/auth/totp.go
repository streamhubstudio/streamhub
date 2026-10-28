package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// RFC 6238 TOTP matching the Node core's otplib `authenticator` clone:
// base32 secret (10 random bytes on generation), SHA-1, 6 digits, 30s step,
// window 1 (the previous and next step are accepted too).
const (
	totpStep   = 30
	totpDigits = 6
	totpWindow = 1
)

var base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)

// GenerateTOTPSecret mints a base32 shared secret (16 chars).
func GenerateTOTPSecret() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return base32NoPad.EncodeToString(b)
}

// TOTPCode is the code for secret at t ("" when the secret is not base32).
func TOTPCode(secret string, t time.Time) string {
	key, err := base32NoPad.DecodeString(strings.ToUpper(strings.TrimRight(secret, "=")))
	if err != nil {
		return ""
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(t.Unix()/totpStep))
	m := hmac.New(sha1.New, key)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, bin%1_000_000)
}

// TOTPCheck accepts code within ±window steps of now.
func TOTPCheck(code, secret string, now time.Time) bool {
	if code == "" {
		return false
	}
	for d := -totpWindow; d <= totpWindow; d++ {
		if c := TOTPCode(secret, now.Add(time.Duration(d*totpStep)*time.Second)); c != "" && hmac.Equal([]byte(c), []byte(code)) {
			return true
		}
	}
	return false
}

// TOTPKeyURI is otplib's keyuri(accountName, issuer, secret).
func TOTPKeyURI(accountName, issuer, secret string) string {
	prefix := issuer
	if prefix == "" {
		prefix = accountName
	}
	return fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&period=%d&digits=%d&algorithm=SHA1&issuer=%s",
		jsx.EncodeURIComponent(prefix), jsx.EncodeURIComponent(accountName), secret,
		totpStep, totpDigits, jsx.EncodeURIComponent(issuer))
}
