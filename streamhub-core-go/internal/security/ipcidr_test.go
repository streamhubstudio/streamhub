package security

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseIP(t *testing.T) {
	cases := map[string]int{ // address → version (0 = invalid)
		"1.2.3.4": 4, "255.255.255.255": 4, "::1": 6, "2001:db8::1": 6,
		"2001:0db8:0000:0000:0000:0000:0000:0001": 6, "::ffff:10.1.2.3": 4, "fe80::1%eth0": 6, "::": 6,
		"256.1.1.1": 0, "1.2.3": 0, "a.b.c.d": 0, "1:2:3:4:5:6:7:8:9": 0, "1::2::3": 0, "": 0, "gggg::1": 0,
		"::ffff:1.2.3": 0,
	}
	for in, want := range cases {
		p := ParseIP(in)
		if (p == nil) != (want == 0) || (p != nil && p.Version != want) {
			t.Errorf("ParseIP(%q) = %+v, want v%d", in, p, want)
		}
	}
	if NormalizeIP("::ffff:1.2.3.4") != "1.2.3.4" || NormalizeIP(" fe80::1%lo ") != "fe80::1" {
		t.Fatal("normalize")
	}
}

func TestParseCIDR(t *testing.T) {
	if c := ParseCIDR("1.2.3.4"); c == nil || c.CIDR != "1.2.3.4/32" {
		t.Fatalf("%+v", c)
	}
	if c := ParseCIDR("2001:db8::1"); c == nil || c.CIDR != "2001:db8::1/128" {
		t.Fatalf("%+v", c)
	}
	if c := ParseCIDR("10.0.0.5/8"); c == nil || c.Network.Uint64() != 10<<24 || c.CIDR != "10.0.0.5/8" {
		t.Fatalf("%+v", c)
	}
	for _, bad := range []string{"1.2.3.4/33", "::1/129", "1.2.3.4/x", "1.2.3.4/", "nope/8", "", "1.2.3.4/8/1"} {
		if ParseCIDR(bad) != nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestMatchesCIDR(t *testing.T) {
	cases := []struct {
		ip, cidr string
		want     bool
	}{
		{"192.168.1.0", "192.168.1.0/24", true}, {"192.168.1.255", "192.168.1.0/24", true},
		{"192.168.2.0", "192.168.1.0/24", false}, {"1.2.3.4", "1.2.3.4/32", true}, {"1.2.3.5", "1.2.3.4/32", false},
		{"8.8.8.8", "0.0.0.0/0", true}, {"2001:db8::ffff", "2001:db8::/64", true}, {"2001:db8:0:1::", "2001:db8::/64", false},
		{"::1", "::/0", true}, {"1.2.3.4", "::/0", false}, {"::1", "0.0.0.0/0", false},
		{"::ffff:10.1.2.3", "10.0.0.0/8", true},
	}
	for _, c := range cases {
		if got := MatchesCIDR(c.ip, c.cidr); got != c.want {
			t.Errorf("%s in %s = %v", c.ip, c.cidr, got)
		}
	}
}

func TestPrivateRanges(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "::1", "fd00::5", "fe80::1", "::ffff:127.0.0.1"} {
		if !IsPrivateOrLoopback(ip) {
			t.Errorf("%s should be private", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "172.15.255.255", "172.32.0.0", "192.169.0.1", "2001:4860::8888", "fec0::1", "garbage"} {
		if IsPrivateOrLoopback(ip) {
			t.Errorf("%s should be public", ip)
		}
	}
}

func TestEgressGuard(t *testing.T) {
	ctx := context.Background()
	fake := func(answers map[string][]string) HostResolver {
		return func(_ context.Context, h string) ([]string, error) {
			a, ok := answers[h]
			if !ok {
				return nil, errors.New("NXDOMAIN")
			}
			return a, nil
		}
	}
	opts := EgressOptions{AllowedSchemes: HTTPSchemes, Label: "callback URL", Resolve: fake(map[string][]string{
		"public.example": {"93.184.216.34"}, "meta.example": {"169.254.169.254"},
		"mixed.example": {"93.184.216.34", "10.0.0.1"}, "empty.example": {},
	})}
	cases := []struct {
		url, want string // want = "" (ok) or a substring of the 400 message
	}{
		{"https://public.example/hook", ""},
		{"http://93.184.216.34/x", ""},
		{"ftp://public.example", "callback URL scheme 'ftp' is not allowed (allowed: http, https)"},
		{"file:///etc/passwd", "scheme 'file' is not allowed"},
		{"not a url", "invalid callback URL: 'not a url'"},
		{"http://127.0.0.1/", "points at a private/loopback/link-local address"},
		{"http://[::1]:8080/", "points at a private"},
		{"http://169.254.169.254/latest", "points at a private"},
		{"http://0.0.0.0/", "points at a private"},
		{"http://2130706433/", "points at a private"}, // WHATWG numeric host = 127.0.0.1
		{"http://0x7f.1/", "points at a private"},
		{"http://meta.example/", "resolves to a private/loopback/link-local address"},
		{"http://mixed.example/", "resolves to a private"},
		{"http://nx.example/", "callback URL host 'nx.example' does not resolve"},
		{"http://empty.example/", "does not resolve"},
	}
	for _, c := range cases {
		err := AssertSafeEgressURL(ctx, c.url, opts)
		if (c.want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.want)) {
			t.Errorf("%s: %v", c.url, err)
		}
	}

	priv := opts
	priv.AllowPrivate = true
	if AssertSafeEgressURL(ctx, "http://10.0.0.1/", priv) != nil || AssertSafeEgressURL(ctx, "gopher://10.0.0.1/", priv) == nil {
		t.Fatal("allowPrivate must skip the private check but keep the scheme check")
	}
	allow := opts
	allow.Allowlist = []string{"minio.internal", "10.0.0.0/24"}
	allow.Resolve = fake(map[string][]string{"lan.example": {"10.0.0.7"}, "lan2.example": {"10.0.1.7"}})
	for url, ok := range map[string]bool{
		"http://minio.internal/": true, "http://10.0.0.9/": true, "http://lan.example/": true,
		"http://10.0.1.9/": false, "http://lan2.example/": false,
	} {
		if (AssertSafeEgressURL(ctx, url, allow) == nil) != ok {
			t.Errorf("allowlist %s", url)
		}
	}

	mqtt := EgressOptions{AllowedSchemes: MQTTSchemes, Label: "MQTT broker"}
	if AssertSafeEgressURLSync("mqtt://10.0.0.1:1883", mqtt) == nil || AssertSafeEgressURLSync("http://x", mqtt) == nil {
		t.Fatal("sync guard must block private literals and bad schemes")
	}
	if AssertSafeEgressURLSync("mqtts://broker.example:8883", mqtt) != nil || AssertSafeEgressURLSync("mqtt://8.8.8.8", mqtt) != nil {
		t.Fatal("sync guard must pass public literals and unresolved hostnames")
	}

	for raw, want := range map[string]bool{"1": true, "TRUE": true, " yes ": true, "on": true, "0": false, "": false, "y": false} {
		if EnvFlag(raw) != want {
			t.Errorf("EnvFlag(%q)", raw)
		}
	}
	if got := ParseAllowlistEnv(" a, ,b ,, 10.0.0.0/8 "); strings.Join(got, "|") != "a|b|10.0.0.0/8" {
		t.Fatalf("%q", got)
	}
}

func TestWhatwgIPv4(t *testing.T) {
	for in, want := range map[string]string{"2130706433": "127.0.0.1", "0x7f.1": "127.0.0.1", "0177.0.0.1": "127.0.0.1", "10.1": "10.0.0.1", "1.2.3.4.": "1.2.3.4"} {
		if got, ok := whatwgIPv4(in); !ok || got != want {
			t.Errorf("%s → %s %v", in, got, ok)
		}
	}
	for _, in := range []string{"example.com", "1.2.3.4.5", "256.1.1.1", "1.2.3.x"} {
		if _, ok := whatwgIPv4(in); ok {
			t.Errorf("%s parsed as IPv4", in)
		}
	}
}
