package apps

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

func featuresOf(t *testing.T, src string) any {
	t.Helper()
	v, err := y.Load(src)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// G2 blocks: config.yaml-only, sanitized, and ABSENT from the resolved JSON
// when unset (an existing app reads exactly like before).
func TestResolveG2Features(t *testing.T) {
	f := featuresOf(t, `
hls_token_ttl_seconds: 5
geo:
  allow: [ar, " UY ", AR, ARG, 7, ""]
  deny: [us]
  publish: true
play_auth:
  webhook_url: " https://auth.example.com/play "
  timeout_ms: 999999
`)
	if got := resolveHlsTokenTTL(prop(f, "hls_token_ttl_seconds")); got != MinHlsTokenTTL {
		t.Errorf("ttl clamp low: %d", got)
	}
	if got := resolveHlsTokenTTL(1e9); got != MaxHlsTokenTTL {
		t.Errorf("ttl clamp high: %d", got)
	}
	for _, v := range []any{y.Undefined, nil, "x", -3.0, 0.0} {
		if got := resolveHlsTokenTTL(v); got != 0 {
			t.Errorf("ttl %v: %d", v, got)
		}
	}
	g := ResolveGeoFeatures(prop(f, "geo"))
	if g == nil || !reflect.DeepEqual(g.Allow, []string{"AR", "UY"}) || !reflect.DeepEqual(g.Deny, []string{"US"}) || !g.Publish || !g.Active() {
		t.Fatalf("geo %+v", g)
	}
	if ResolveGeoFeatures(y.Undefined) != nil || ResolveGeoFeatures([]any{"AR"}) != nil {
		t.Fatal("absent / non-map geo must be nil")
	}
	if g := ResolveGeoFeatures(featuresOf(t, "allow: AR")); g == nil || len(g.Allow) != 0 || g.Active() {
		t.Fatalf("scalar list: %+v", g)
	}
	pa := ResolvePlayAuthFeatures(prop(f, "play_auth"))
	if pa == nil || pa.WebhookURL != "https://auth.example.com/play" || pa.TimeoutMs != MaxPlayAuthTimeoutMs || pa.FailOpen {
		t.Fatalf("play_auth %+v", pa)
	}
	if pa := ResolvePlayAuthFeatures(featuresOf(t, "fail_open: true")); pa != nil {
		t.Fatalf("no webhook_url → nil: %+v", pa)
	}
	if pa := ResolvePlayAuthFeatures(featuresOf(t, "webhook_url: http://x\nfail_open: true")); pa == nil ||
		pa.TimeoutMs != DefaultPlayAuthTimeoutMs || !pa.FailOpen {
		t.Fatalf("defaults: %+v", pa)
	}

	b, _ := json.Marshal(contracts.AppFeatures{PublicPlayback: true})
	for _, k := range []string{"hlsTokenTtlSeconds", "geo", "playAuth"} {
		if strings.Contains(string(b), `"`+k+`"`) {
			t.Fatalf("unset %s must be omitted: %s", k, b)
		}
	}
}
