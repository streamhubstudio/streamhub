package apps

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// Publisher restrictions (3.4.0): features.allowed_publisher_cidr and
// features.max_bitrate_accept — off by default, absent on disk and in JSON
// until set.

func TestIngestKnobsOffByDefault(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "fresh"})
	cfg, err := s.GetConfig(bg, "fresh")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Features.AllowedPublisherCidr != nil || cfg.Features.MaxBitrateAccept != 0 {
		t.Fatalf("fresh app has a knob on: %+v", cfg.Features)
	}
	// INVARIANT: an untouched app's JSON and yaml carry none of the keys
	// (pre-3.4 responses / the recorded parity oracle are unchanged).
	b, _ := json.Marshal(cfg)
	for _, k := range []string{"allowedPublisherCidr", "maxBitrateAccept"} {
		if strings.Contains(string(b), k) {
			t.Errorf("GET config leaks %q when unset: %s", k, b)
		}
	}
	raw, _ := readYAML(t, s, "fresh")
	for _, k := range []string{"allowed_publisher_cidr", "max_bitrate_accept"} {
		if strings.Contains(raw, k) {
			t.Errorf("scaffold yaml carries %q", k)
		}
	}
}

func TestResolveIngestKnobs(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "raw"})
	put := func(yaml string) *contracts.AppConfig {
		t.Helper()
		if _, err := s.PutRawConfig(bg, "raw", "name: raw\nroom_prefix: raw\n"+yaml); err != nil {
			t.Fatal(err)
		}
		cfg, err := s.GetConfig(bg, "raw")
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}

	cfg := put("features:\n  allowed_publisher_cidr: ['203.0.113.0/24', ' 198.51.100.7 ', '']\n  max_bitrate_accept: 4000000.9\n")
	if !reflect.DeepEqual(cfg.Features.AllowedPublisherCidr, []string{"203.0.113.0/24", "198.51.100.7"}) {
		t.Errorf("cidr list = %q", cfg.Features.AllowedPublisherCidr)
	}
	if cfg.Features.MaxBitrateAccept != 4000000 {
		t.Errorf("max bitrate = %v", cfg.Features.MaxBitrateAccept)
	}

	// AntMedia-style comma string; a garbage cap is off.
	cfg = put("features:\n  allowed_publisher_cidr: '10.0.0.0/8, 192.0.2.1'\n  max_bitrate_accept: lots\n")
	if cfg.Features.MaxBitrateAccept != 0 {
		t.Errorf("garbage cap must resolve off: %v", cfg.Features.MaxBitrateAccept)
	}
	if !reflect.DeepEqual(cfg.Features.AllowedPublisherCidr, []string{"10.0.0.0/8", "192.0.2.1"}) {
		t.Errorf("comma list = %q", cfg.Features.AllowedPublisherCidr)
	}

	// INVARIANT: a typo is KEPT (matches nothing → fail closed), never
	// dropped into an empty = unrestricted list.
	cfg = put("features:\n  allowed_publisher_cidr: ['203.0.113.0/33']\n  max_bitrate_accept: -5\n")
	if !reflect.DeepEqual(cfg.Features.AllowedPublisherCidr, []string{"203.0.113.0/33"}) || cfg.Features.MaxBitrateAccept != 0 {
		t.Errorf("typo list = %q, negative cap = %v", cfg.Features.AllowedPublisherCidr, cfg.Features.MaxBitrateAccept)
	}
}

func TestPatchIngestKnobs(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "pgk"})
	patch := func(body string) *contracts.AppConfig {
		t.Helper()
		cp, err := parseUpdateAppConfig([]byte(body))
		if err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		cfg, err := s.UpdateConfig(bg, "pgk", cp.patch)
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}

	cfg := patch(`{"features":{"allowedPublisherCidr":["203.0.113.0/24","2001:db8::/32"],"maxBitrateAccept":6000000}}`)
	if !reflect.DeepEqual(cfg.Features.AllowedPublisherCidr, []string{"203.0.113.0/24", "2001:db8::/32"}) || cfg.Features.MaxBitrateAccept != 6000000 {
		t.Fatalf("set: %+v", cfg.Features)
	}
	if _, disk := readYAML(t, s, "pgk"); at(disk, "features", "max_bitrate_accept") != 6000000.0 {
		t.Errorf("disk cap = %v", at(disk, "features", "max_bitrate_accept"))
	}

	// a toggle-only PATCH (the dashboard's feature card) leaves both alone
	cfg = patch(`{"features":{"chat":true}}`)
	if len(cfg.Features.AllowedPublisherCidr) != 2 || cfg.Features.MaxBitrateAccept != 6000000 || !cfg.Features.Chat {
		t.Fatalf("untouched knobs changed: %+v", cfg.Features)
	}

	// [] / 0 switch them off AND drop the keys from the yaml
	cfg = patch(`{"features":{"allowedPublisherCidr":[],"maxBitrateAccept":0}}`)
	if cfg.Features.AllowedPublisherCidr != nil || cfg.Features.MaxBitrateAccept != 0 {
		t.Fatalf("off: %+v", cfg.Features)
	}
	if _, disk := readYAML(t, s, "pgk"); !y.IsUndefined(at(disk, "features", "allowed_publisher_cidr")) || !y.IsUndefined(at(disk, "features", "max_bitrate_accept")) {
		t.Error("off knobs must leave no key on disk")
	}
}

func TestIngestKnobsDto(t *testing.T) {
	for _, c := range []struct {
		body string
		want []string
	}{
		{`{"features":{"allowedPublisherCidr":["203.0.113.0/24","nope"]}}`, []string{"features." + allowedPublisherCidrMessage}},
		{`{"features":{"allowedPublisherCidr":"10.0.0.0/8"}}`, []string{"features.allowedPublisherCidr must contain no more than 64 elements", "features.allowedPublisherCidr must be an array"}},
		{`{"features":{"allowedPublisherCidr":[7]}}`, []string{"features." + allowedPublisherCidrMessage, "features.each value in allowedPublisherCidr must be shorter than or equal to 64 characters", "features.each value in allowedPublisherCidr must be a string"}},
		{`{"features":{"maxBitrateAccept":-1}}`, []string{"features.maxBitrateAccept must not be less than 0"}},
		{`{"features":{"maxBitrateAccept":1.5}}`, []string{"features.maxBitrateAccept must be an integer number"}},
	} {
		_, err := parseUpdateAppConfig([]byte(c.body))
		if got := messages(t, err); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %q\nwant %q", c.body, got, c.want)
		}
	}
	many := make([]string, MaxPublisherCIDRs+1)
	for i := range many {
		many[i] = `"10.0.0.1"`
	}
	_, err := parseUpdateAppConfig([]byte(`{"features":{"allowedPublisherCidr":[` + strings.Join(many, ",") + `]}}`))
	if got := messages(t, err); len(got) != 1 || !strings.Contains(got[0], "must contain no more than 64 elements") {
		t.Errorf("size cap: %q", got)
	}
}
