package playback

import (
	"net/netip"
	"strings"

	"github.com/oschwald/maxminddb-golang/v2"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// CountryLookup resolves an IP to its ISO 3166-1 alpha-2 country. The
// production one reads a local MaxMind DB (GeoLite2-Country or -City); tests
// inject a fake.
type CountryLookup interface {
	Country(ip netip.Addr) (string, bool)
}

// GeoIP is a CountryLookup over a .mmdb file (pure Go, memory-mapped).
type GeoIP struct {
	r *maxminddb.Reader
}

// OpenGeoIP opens a MaxMind DB (STREAMHUB_GEOIP_DB).
func OpenGeoIP(path string) (*GeoIP, error) {
	r, err := maxminddb.Open(path)
	if err != nil {
		return nil, err
	}
	return &GeoIP{r: r}, nil
}

// OpenGeoIPBytes opens an in-memory MaxMind DB.
func OpenGeoIPBytes(b []byte) (*GeoIP, error) {
	r, err := maxminddb.OpenBytes(b)
	if err != nil {
		return nil, err
	}
	return &GeoIP{r: r}, nil
}

// Close releases the mapping.
func (g *GeoIP) Close() error { return g.r.Close() }

// geoRecord is the slice of a GeoIP2/GeoLite2 Country/City record we read:
// the country of the network, else the country it is registered in
// (anycast / satellite / anonymous ranges carry only the latter).
type geoRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	RegisteredCountry struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"registered_country"`
}

// Country implements CountryLookup.
func (g *GeoIP) Country(ip netip.Addr) (string, bool) {
	res := g.r.Lookup(ip.Unmap())
	if res.Err() != nil || !res.Found() {
		return "", false
	}
	var rec geoRecord
	if err := res.Decode(&rec); err != nil {
		return "", false
	}
	c := rec.Country.ISOCode
	if c == "" {
		c = rec.RegisteredCountry.ISOCode
	}
	c = strings.ToUpper(c)
	return c, c != ""
}

// GeoVerdict is the outcome of a geo check.
type GeoVerdict struct {
	Allowed bool
	Country string // "" when unknown / not looked up
}

// CheckGeo applies features.geo to a client IP:
//   - no policy, an inactive one (both lists empty) or no lookup (no
//     STREAMHUB_GEOIP_DB): allowed — the feature is off;
//   - loopback / private / link-local clients (the LAN, the proxies, the
//     core's own workers) are never geo-blocked: they have no country;
//   - a country in deny is blocked; with a non-empty allow only the listed
//     countries pass, and an address the base does not know is blocked
//     (fail closed: an allowlist is a promise of "only these").
func CheckGeo(lookup CountryLookup, g *contracts.GeoFeatures, ip string) GeoVerdict {
	if !g.Active() || lookup == nil {
		return GeoVerdict{Allowed: true}
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err == nil && isLocal(addr.Unmap()) {
		return GeoVerdict{Allowed: true}
	}
	country, known := countryOf(lookup, ip)
	if known && contains(g.Deny, country) {
		return GeoVerdict{Allowed: false, Country: country}
	}
	if len(g.Allow) > 0 {
		return GeoVerdict{Allowed: known && contains(g.Allow, country), Country: country}
	}
	return GeoVerdict{Allowed: true, Country: country}
}

func isLocal(a netip.Addr) bool {
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsUnspecified()
}

// countryOf looks a textual IP up ("", false: no base, unparsable, local or
// unknown to the base).
func countryOf(lookup CountryLookup, ip string) (string, bool) {
	if lookup == nil {
		return "", false
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil || isLocal(addr.Unmap()) {
		return "", false
	}
	return lookup.Country(addr.Unmap())
}

func contains(list []string, s string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}
