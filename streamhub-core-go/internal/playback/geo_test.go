package playback

import (
	"bytes"
	"net/netip"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// fakeGeo maps exact IPs to countries.
type fakeGeo map[string]string

func (f fakeGeo) Country(ip netip.Addr) (string, bool) {
	c, ok := f[ip.String()]
	return c, ok
}

var geoIPs = fakeGeo{"190.1.1.1": "AR", "186.2.2.2": "UY", "8.8.8.8": "US", "2800:40::1": "AR"}

func TestCheckGeo(t *testing.T) {
	allowAR := &contracts.GeoFeatures{Allow: []string{"AR", "UY"}}
	denyUS := &contracts.GeoFeatures{Deny: []string{"US"}}
	both := &contracts.GeoFeatures{Allow: []string{"AR", "US"}, Deny: []string{"US"}}
	cases := []struct {
		name string
		geo  CountryLookup
		pol  *contracts.GeoFeatures
		ip   string
		want bool
	}{
		{"no policy", geoIPs, nil, "8.8.8.8", true},
		{"empty lists", geoIPs, &contracts.GeoFeatures{}, "8.8.8.8", true},
		{"no base = feature off", nil, allowAR, "8.8.8.8", true},
		{"allow hit", geoIPs, allowAR, "190.1.1.1", true},
		{"allow hit 2", geoIPs, allowAR, "186.2.2.2", true},
		{"allow ipv6 + mapped", geoIPs, allowAR, "2800:40::1", true},
		{"allow miss", geoIPs, allowAR, "8.8.8.8", false},
		{"allow unknown fails closed", geoIPs, allowAR, "9.9.9.9", false},
		{"allow garbage ip fails closed", geoIPs, allowAR, "not-an-ip", false},
		{"deny hit", geoIPs, denyUS, "8.8.8.8", false},
		{"deny miss", geoIPs, denyUS, "190.1.1.1", true},
		{"deny unknown passes", geoIPs, denyUS, "9.9.9.9", true},
		{"deny wins over allow", geoIPs, both, "8.8.8.8", false},
		{"loopback never blocked", geoIPs, allowAR, "127.0.0.1", true},
		{"LAN never blocked", geoIPs, allowAR, "192.168.0.50", true},
		{"mapped LAN never blocked", geoIPs, allowAR, "::ffff:10.0.0.1", true},
	}
	for _, c := range cases {
		if got := CheckGeo(c.geo, c.pol, c.ip); got.Allowed != c.want {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
	if v := CheckGeo(geoIPs, denyUS, "8.8.8.8"); v.Country != "US" {
		t.Errorf("country not reported: %+v", v)
	}
}

// --- a minimal MaxMind DB, built in the test ---------------------------------
//
// IPv4-only, record size 24, a complete binary trie over the first octet
// (255 nodes): an octet with a country points at its data record, the rest
// are "no data". Enough to exercise the real reader end to end without a
// binary fixture.

func mmdbStr(s string) []byte { return append([]byte{0x40 | byte(len(s))}, s...) }
func mmdbMap(n int) []byte    { return []byte{0xE0 | byte(n)} }

func mmdbUint(typ byte, v uint64) []byte {
	var b []byte
	for x := v; x > 0; x >>= 8 {
		b = append([]byte{byte(x)}, b...)
	}
	if typ <= 7 {
		return append([]byte{typ<<5 | byte(len(b))}, b...)
	}
	return append([]byte{byte(len(b)), typ - 7}, b...) // extended type
}

func buildMMDB(octets map[byte]string, field string) []byte {
	const nodes = 255
	var data bytes.Buffer
	ptr := map[byte]uint32{}
	for o, c := range octets {
		ptr[o] = uint32(nodes + 16 + data.Len())
		data.Write(mmdbMap(1))
		data.Write(mmdbStr(field))
		data.Write(mmdbMap(1))
		data.Write(mmdbStr("iso_code"))
		data.Write(mmdbStr(c))
	}
	rec := func(v uint32) []byte { return []byte{byte(v >> 16), byte(v >> 8), byte(v)} }
	var tree bytes.Buffer
	for n := 0; n < nodes; n++ {
		for side := 1; side <= 2; side++ {
			child := 2*n + side
			if child < nodes {
				tree.Write(rec(uint32(child)))
				continue
			}
			octet := byte(child - nodes)
			if p, ok := ptr[octet]; ok {
				tree.Write(rec(p))
			} else {
				tree.Write(rec(nodes))
			}
		}
	}
	var out bytes.Buffer
	out.Write(tree.Bytes())
	out.Write(make([]byte, 16))
	out.Write(data.Bytes())
	out.WriteString("\xAB\xCD\xEFMaxMind.com")
	out.Write(mmdbMap(7))
	for _, kv := range []struct {
		k string
		v []byte
	}{
		{"node_count", mmdbUint(6, nodes)},
		{"record_size", mmdbUint(5, 24)},
		{"ip_version", mmdbUint(5, 4)},
		{"database_type", mmdbStr("StreamHub-Test-Country")},
		{"binary_format_major_version", mmdbUint(5, 2)},
		{"binary_format_minor_version", mmdbUint(5, 0)},
		{"build_epoch", mmdbUint(9, 1_800_000_000)},
	} {
		out.Write(mmdbStr(kv.k))
		out.Write(kv.v)
	}
	return out.Bytes()
}

func TestGeoIPReadsMaxMindDB(t *testing.T) {
	db, err := OpenGeoIPBytes(buildMMDB(map[byte]string{190: "AR", 186: "uy"}, "country"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for ip, want := range map[string]string{"190.10.20.30": "AR", "186.1.2.3": "UY", "::ffff:190.0.0.1": "AR"} {
		if c, ok := db.Country(netip.MustParseAddr(ip)); !ok || c != want {
			t.Errorf("%s: %q %v", ip, c, ok)
		}
	}
	for _, ip := range []string{"8.8.8.8", "2001:db8::1"} {
		if c, ok := db.Country(netip.MustParseAddr(ip)); ok {
			t.Errorf("%s: unexpected %q", ip, c)
		}
	}
	// registered_country is the fallback when the record has no country.
	reg, err := OpenGeoIPBytes(buildMMDB(map[byte]string{8: "US"}, "registered_country"))
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	if c, ok := reg.Country(netip.MustParseAddr("8.8.8.8")); !ok || c != "US" {
		t.Errorf("registered_country: %q %v", c, ok)
	}
	if _, err := OpenGeoIPBytes([]byte("not a database")); err == nil {
		t.Fatal("garbage must not open")
	}
	if _, err := OpenGeoIP("/nonexistent/GeoLite2-Country.mmdb"); err == nil {
		t.Fatal("missing file must not open")
	}
}
