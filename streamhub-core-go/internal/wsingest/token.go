package wsingest

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"hash"
	"strings"
	"time"
)

// verifyLiveKitToken is livekit-server-sdk TokenVerifier.verify (jose
// jwtVerify with the API secret and issuer = API key): HMAC signature, iss,
// and exp/nbf against now (no clock tolerance). Returns the raw claims.
func verifyLiveKitToken(token, apiKey, apiSecret string, now time.Time) (map[string]any, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, false
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(hb, &header) != nil {
		return nil, false
	}
	var h func() hash.Hash
	switch header.Alg {
	case "HS256":
		h = sha256.New
	case "HS384":
		h = sha512.New384
	case "HS512":
		h = sha512.New
	default:
		return nil, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, false
	}
	mac := hmac.New(h, []byte(apiSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, false
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, false
	}
	var claims map[string]any
	if json.Unmarshal(pb, &claims) != nil || claims == nil {
		return nil, false
	}
	if iss, _ := claims["iss"].(string); iss != apiKey {
		return nil, false
	}
	sec := float64(now.Unix())
	if exp, ok := claims["exp"]; ok {
		f, isNum := exp.(float64)
		if !isNum || sec >= f {
			return nil, false
		}
	}
	if nbf, ok := claims["nbf"]; ok {
		f, isNum := nbf.(float64)
		if !isNum || sec < f {
			return nil, false
		}
	}
	return claims, true
}

// subscribeGrantFor: claims.video grants room join + subscribe on room
// (roomJoin / canSubscribe only fail when explicitly false).
func subscribeGrantFor(claims map[string]any, room string) bool {
	video, ok := claims["video"].(map[string]any)
	if !ok {
		return false
	}
	r, _ := video["room"].(string)
	if !ok || r != room {
		return false
	}
	return video["roomJoin"] != false && video["canSubscribe"] != false
}
