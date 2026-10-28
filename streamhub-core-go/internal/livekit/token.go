package livekit

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Join tokens are minted byte-compatible with livekit-server-sdk's
// AccessToken (jose SignJWT): protected header {"alg":"HS256"}, payload
// {metadata?, name?, video, iss, exp, nbf, sub} in that order, video grant
// keys in VideoGrant insertion order, canPublishSources as lowercase source
// names. LiveKit server 1.13 parses these claims unchanged (tested with
// protocol/auth in token_test.go).

// MintTokenOptions are the supported join-token grants (MintTokenExtraOptions).
type MintTokenOptions struct {
	Room     string
	Identity string // "" → anon-<uuid>
	Name     string
	TTL      string // jose time span, "" → 6h
	Metadata string
	// CanPublish / CanSubscribe / CanPublishData nil → true.
	CanPublish     *bool
	CanSubscribe   *bool
	CanPublishData *bool
	Hidden         bool
	Recorder       bool
	AudioOnly      bool
}

type videoGrant struct {
	RoomJoin          bool     `json:"roomJoin"`
	Room              string   `json:"room"`
	CanPublish        bool     `json:"canPublish"`
	CanSubscribe      bool     `json:"canSubscribe"`
	CanPublishData    bool     `json:"canPublishData"`
	Hidden            bool     `json:"hidden"`
	RoomRecord        bool     `json:"roomRecord"`
	CanPublishSources []string `json:"canPublishSources,omitempty"`
}

type tokenClaims struct {
	Metadata string     `json:"metadata,omitempty"`
	Name     string     `json:"name,omitempty"`
	Video    videoGrant `json:"video"`
	Iss      string     `json:"iss"`
	Exp      int64      `json:"exp"`
	Nbf      int64      `json:"nbf"`
	Sub      string     `json:"sub"`
}

var errBadTTL = errors.New("Invalid time period format") //nolint:staticcheck // jose's TypeError text

// signToken builds the JWT for opts at now.
func signToken(apiKey, apiSecret string, opts MintTokenOptions, now time.Time) (string, error) {
	identity := opts.Identity
	if identity == "" {
		identity = "anon-" + uuid.NewString()
	}
	ttl := opts.TTL
	if ttl == "" {
		ttl = "6h"
	}
	span, err := joseSecs(ttl)
	if err != nil {
		return "", err
	}
	canPublish := orTrue(opts.CanPublish)
	g := videoGrant{
		RoomJoin:       true,
		Room:           opts.Room,
		CanPublish:     canPublish,
		CanSubscribe:   orTrue(opts.CanSubscribe),
		CanPublishData: orTrue(opts.CanPublishData),
		Hidden:         opts.Hidden,
		RoomRecord:     opts.Recorder,
	}
	// Audio-only (wave-4 §5/§6): limit the publisher to the microphone source.
	if canPublish && opts.AudioOnly {
		g.CanPublishSources = []string{"microphone"}
	}
	epoch := now.Unix()
	var buf bytes.Buffer
	je := json.NewEncoder(&buf)
	je.SetEscapeHTML(false) // JSON.stringify leaves <, >, & as is
	if err := je.Encode(tokenClaims{
		Metadata: opts.Metadata, Name: opts.Name, Video: g,
		Iss: apiKey, Exp: epoch + span, Nbf: epoch, Sub: identity,
	}); err != nil {
		return "", err
	}
	payload := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	enc := base64.RawURLEncoding
	data := enc.EncodeToString([]byte(`{"alg":"HS256"}`)) + "." + enc.EncodeToString(payload)
	m := hmac.New(sha256.New, []byte(apiSecret))
	m.Write([]byte(data))
	return data + "." + enc.EncodeToString(m.Sum(nil)), nil
}

func orTrue(b *bool) bool { return b == nil || *b }

// joseTTL is jose's lib/secs.js REGEX.
var joseTTL = regexp.MustCompile(`(?i)^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$`)

// joseSecs is jose's secs(): a time span string → seconds.
func joseSecs(s string) (int64, error) {
	m := joseTTL.FindStringSubmatch(s)
	if m == nil || (m[4] != "" && m[1] != "") {
		return 0, errBadTTL
	}
	v, _ := strconv.ParseFloat(m[2], 64)
	var mult float64
	switch strings.ToLower(m[3]) {
	case "sec", "secs", "second", "seconds", "s":
		mult = 1
	case "minute", "minutes", "min", "mins", "m":
		mult = 60
	case "hour", "hours", "hr", "hrs", "h":
		mult = 3600
	case "day", "days", "d":
		mult = 86400
	case "week", "weeks", "w":
		mult = 604800
	default:
		mult = 86400 * 365.25
	}
	n := int64(jsRound(v * mult))
	if m[1] == "-" || m[4] == "ago" {
		return -n, nil
	}
	return n, nil
}

// jsRound is Math.round (half up toward +∞).
func jsRound(f float64) float64 { return math.Floor(f + 0.5) }
