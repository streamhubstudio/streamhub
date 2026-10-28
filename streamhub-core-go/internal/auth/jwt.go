package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Minimal HS256 JWT, wire-compatible with streamhub-core/src/shared/auth/jwt.util.ts:
// header {"alg":"HS256","typ":"JWT"}, payload {iat, exp, ...claims} (claims may
// override iat/exp, as with the JS spread), base64url without padding.

var b64 = base64.RawURLEncoding

// Claims is a decoded JWT payload.
type Claims map[string]any

// Sub returns the "sub" claim ("" when absent).
func (c Claims) Sub() string { s, _ := c["sub"].(string); return s }

// String returns a string claim ("" when absent or not a string).
func (c Claims) String(name string) string { s, _ := c[name].(string); return s }

// SignJWT mints a compact HS256 token valid for ttl.
func SignJWT(claims map[string]any, secret string, ttl time.Duration) (string, error) {
	if secret == "" {
		return "", errors.New("signJwt: empty secret")
	}
	now := time.Now().Unix()
	payload := map[string]any{"iat": now, "exp": now + int64(ttl/time.Second)}
	for k, v := range claims {
		payload[k] = v
	}
	// Field order matters only for byte-equality with Node tokens, which no
	// consumer relies on; any valid HS256 token verifies on both sides.
	hb, _ := json.Marshal(struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}{"HS256", "JWT"})
	pb, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	data := b64.EncodeToString(hb) + "." + b64.EncodeToString(pb)
	return data + "." + sign(data, secret), nil
}

// VerifyJWT checks signature, algorithm and expiry, returning the payload.
func VerifyJWT(token, secret string) (Claims, error) {
	if secret == "" {
		return nil, errors.New("verifyJwt: empty secret")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed JWT")
	}
	want := sign(parts[0]+"."+parts[1], secret)
	if !hmac.Equal([]byte(parts[2]), []byte(want)) {
		return nil, errors.New("invalid signature")
	}
	var header struct {
		Alg string `json:"alg"`
	}
	hb, err := decodeSegment(parts[0])
	if err != nil || json.Unmarshal(hb, &header) != nil {
		return nil, errors.New("malformed JWT")
	}
	if header.Alg != "HS256" {
		return nil, errors.New("unsupported alg")
	}
	pb, err := decodeSegment(parts[1])
	if err != nil {
		return nil, errors.New("malformed JWT")
	}
	var claims Claims
	if err := json.Unmarshal(pb, &claims); err != nil {
		return nil, errors.New("malformed JWT")
	}
	if exp, ok := claims["exp"].(float64); ok && float64(time.Now().Unix()) >= exp {
		return nil, errors.New("token expired")
	}
	return claims, nil
}

func sign(data, secret string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(data))
	return b64.EncodeToString(m.Sum(nil))
}

// decodeSegment accepts base64url with or without padding (Node's decoder is lenient).
func decodeSegment(s string) ([]byte, error) {
	return b64.DecodeString(strings.TrimRight(s, "="))
}
