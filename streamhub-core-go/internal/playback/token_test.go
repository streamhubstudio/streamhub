package playback

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestHLSTokenRoundTrip(t *testing.T) {
	key := DeriveKey("server-secret")
	now := time.Unix(1_800_000_000, 0)
	st := SignHLS(key, "live", "live-ch1", now.Unix()+60)
	if !strings.HasPrefix(st, strconv.FormatInt(now.Unix()+60, 10)+".") || len(st) != 10+1+43 {
		t.Fatalf("shape %q", st)
	}
	if v := VerifyHLS(key, "live", "live-ch1", st, now); v != TokenOK {
		t.Fatalf("fresh token: %s", v)
	}
	if v := VerifyHLS(key, "live", "live-ch1", " "+st+" ", now); v != TokenOK {
		t.Fatalf("trimmed token: %s", v)
	}
	// Bound to app, dir and exp: any change is invalid (not expired).
	for name, c := range map[string][3]string{
		"other app": {"tv", "live-ch1", st},
		"other dir": {"live", "live-ch2", st},
		"exp bump":  {"live", "live-ch1", strconv.FormatInt(now.Unix()+99999, 10) + st[10:]},
		"bad mac":   {"live", "live-ch1", st[:20] + flip(st[20]) + st[21:]},
		"no dot":    {"live", "live-ch1", strings.Replace(st, ".", "", 1)},
		"garbage":   {"live", "live-ch1", "x.y"},
	} {
		if v := VerifyHLS(key, c[0], c[1], c[2], now); v != TokenInvalid {
			t.Errorf("%s: %s", name, v)
		}
	}
	if v := VerifyHLS(key, "live", "live-ch1", "", now); v != TokenMissing {
		t.Errorf("missing: %s", v)
	}
	// Expired only once authentic.
	old := SignHLS(key, "live", "live-ch1", now.Unix()-1)
	if v := VerifyHLS(key, "live", "live-ch1", old, now); v != TokenExpired {
		t.Errorf("expired: %s", v)
	}
	// Another server secret never verifies, and no secret verifies nothing.
	if v := VerifyHLS(DeriveKey("other"), "live", "live-ch1", st, now); v != TokenInvalid {
		t.Errorf("other key: %s", v)
	}
	if DeriveKey("") != nil {
		t.Fatal("empty secret must derive no key")
	}
	if v := VerifyHLS(nil, "live", "live-ch1", st, now); v != TokenInvalid {
		t.Errorf("nil key: %s", v)
	}
}

// The key is derived (labelled HMAC), never the raw secret, and the signed
// message is length-prefixed so (app, dir) pairs cannot be re-split.
func TestHLSKeyDerivationAndInjectivity(t *testing.T) {
	secret := "server-secret"
	key := DeriveKey(secret)
	if bytes.Equal(key, []byte(secret)) || len(key) != sha256.Size {
		t.Fatal("key must be derived")
	}
	raw := hmac.New(sha256.New, []byte(secret))
	raw.Write([]byte(hlsKeyLabel))
	if !bytes.Equal(key, raw.Sum(nil)) {
		t.Fatal("derivation changed: every issued token would break")
	}
	now := time.Unix(1_800_000_000, 0)
	st := SignHLS(key, "a|1:b", "c", now.Unix()+60)
	if VerifyHLS(key, "a", "b|1:c", st, now) != TokenInvalid {
		t.Fatal("ambiguous encoding")
	}
}

func flip(c byte) string {
	if c == 'A' {
		return "B"
	}
	return "A"
}

func TestTTLOr(t *testing.T) {
	if TTLOr(0) != DefaultTTL || TTLOr(-5) != DefaultTTL || TTLOr(600) != 600 {
		t.Fatal("TTLOr")
	}
}
