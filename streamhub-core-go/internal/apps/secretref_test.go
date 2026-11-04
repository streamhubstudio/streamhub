package apps

import (
	"strings"
	"testing"
)

func TestSecretRefDerivation(t *testing.T) {
	// Plain [a-z0-9] slugs (every prod app) keep the exact pre-3.3.3 names.
	for _, tc := range []struct {
		app  string
		kind SecretKind
		want string
	}{
		{"live", SecretS3Key, "APP_LIVE_S3_KEY"},
		{"streambuy", SecretS3Secret, "APP_STREAMBUY_S3_SECRET"},
		{"meet", SecretMqttPassword, "APP_MEET_MQTT_PASSWORD"},
		{"live", SecretSmtpPass, "APP_LIVE_SMTP_PASS"},
		{"live", SecretDrmToken, "APP_LIVE_DRM_TOKEN"},
		{"my-app", SecretS3Key, "APP_MY_APP_S3_KEY"},
		{"a--b", SecretS3Key, "APP_A__B_S3_KEY"},
	} {
		if got := SecretRef(tc.app, tc.kind); got != tc.want {
			t.Errorf("SecretRef(%q, %s) = %q, want %q", tc.app, tc.kind, got, tc.want)
		}
		if !strings.Contains(tc.app, "-") && SecretRef(tc.app, tc.kind) != legacySecretRef(tc.app, tc.kind) {
			t.Errorf("INVARIANT: %q changed name vs the legacy scaffold", tc.app)
		}
	}
	// Single hyphens keep the legacy name too; only runs of hyphens differ.
	if SecretRef("my-app", SecretS3Key) != legacySecretRef("my-app", SecretS3Key) {
		t.Error("single-hyphen names must keep the legacy ref")
	}
	if legacySecretRef("a--b", SecretS3Key) != legacySecretRef("a-b", SecretS3Key) {
		t.Fatal("precondition: the legacy envSlug collapsed hyphen runs")
	}
}

func TestSecretRefInjective(t *testing.T) {
	// Every valid name up to 5 chars over a small alphabet, every kind: no
	// two (app, kind) pairs share a ref.
	alphabet := []rune{'a', 'b', '1', '-'}
	var names []string
	var gen func(prefix string, n int)
	gen = func(prefix string, n int) {
		if n == 0 {
			if appSlug.MatchString(prefix) {
				names = append(names, prefix)
			}
			return
		}
		for _, r := range alphabet {
			gen(prefix+string(r), n-1)
		}
	}
	for n := 3; n <= 5; n++ {
		gen("", n)
	}
	// Out-of-slug names (never created by the API) normalize with a hash
	// suffix: they never collide with a valid name nor with each other.
	names = append(names, "a_b", "A-B", "a.b", "a b", "a_b_x0123456789")
	seen := map[string]string{}
	for _, n := range names {
		for _, f := range secretFields {
			ref := SecretRef(n, f.kind)
			key := n + "/" + string(f.kind)
			if prev, dup := seen[ref]; dup {
				t.Fatalf("collision: %s and %s → %s", prev, key, ref)
			}
			seen[ref] = key
		}
	}
	if len(names) < 100 {
		t.Fatalf("generator too small: %d names", len(names))
	}
	if r := SecretRef("a_b", SecretS3Key); !strings.HasPrefix(r, "APP_A_B_x") {
		t.Errorf("out-of-slug name = %q (want the lower-case hash marker)", r)
	}
}
