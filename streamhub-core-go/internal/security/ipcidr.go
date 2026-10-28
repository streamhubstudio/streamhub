// Package security is network security (modules/security): the global IP
// allow/blocklist with CIDR support (ip_rules), the in-app fail2ban with
// escalating bans (ip_bans), the early middleware enforcing both on every
// path, the WebSocket-upgrade verdict, the SSRF egress-URL guard and the
// superadmin /security admin API.
package security

import (
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// Port of ip-cidr.util.ts: both families normalised to an unsigned integer
// so one prefix compare covers v4 and v6; IPv4-mapped IPv6 folds to v4.

// ParsedIP is an address as an unsigned integer (32 bits v4, 128 bits v6).
type ParsedIP struct {
	Version int
	Value   *big.Int
}

// ParsedCIDR is a compiled network (host bits zeroed).
type ParsedCIDR struct {
	Version int
	Network *big.Int
	Prefix  int
	CIDR    string // canonical "<ip>/<prefix>" (ip as entered, normalised)
}

var (
	octetRe  = regexp.MustCompile(`^\d{1,3}$`)
	hexGrpRe = regexp.MustCompile(`^[0-9a-fA-F]{1,4}$`)
	prefixRe = regexp.MustCompile(`^\d{1,3}$`)
)

// NormalizeIP strips a zone index and the IPv4-mapped IPv6 prefix.
func NormalizeIP(raw string) string {
	ip := strings.TrimSpace(raw)
	if i := strings.IndexByte(ip, '%'); i != -1 {
		ip = ip[:i]
	}
	if strings.HasPrefix(strings.ToLower(ip), "::ffff:") && strings.Contains(ip, ".") {
		ip = ip[7:]
	}
	return ip
}

func parseIPv4(ip string) *big.Int {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return nil
	}
	var v uint64
	for _, p := range parts {
		if !octetRe.MatchString(p) {
			return nil
		}
		o, _ := strconv.Atoi(p)
		if o > 255 {
			return nil
		}
		v = v<<8 | uint64(o)
	}
	return new(big.Int).SetUint64(v)
}

func parseIPv6(ip string) *big.Int {
	if !strings.Contains(ip, ":") {
		return nil
	}
	var tail []uint64
	head := ip
	if strings.Contains(ip, ".") {
		last := strings.LastIndex(ip, ":")
		v4 := parseIPv4(ip[last+1:])
		if v4 == nil {
			return nil
		}
		x := v4.Uint64()
		tail = []uint64{x >> 16 & 0xffff, x & 0xffff}
		head = ip[:last]
		if strings.HasSuffix(head, ":") && !strings.HasSuffix(head, "::") {
			head = head[:len(head)-1]
		}
	}
	need := 8 - len(tail)
	if strings.Count(head, "::") > 1 {
		return nil
	}
	var groups []string
	if i := strings.Index(head, "::"); i != -1 {
		left, right := head[:i], head[i+2:]
		var lg, rg []string
		if left != "" {
			lg = strings.Split(left, ":")
		}
		if right != "" {
			rg = strings.Split(right, ":")
		}
		fill := need - len(lg) - len(rg)
		if fill < 0 {
			return nil
		}
		groups = append(groups, lg...)
		for ; fill > 0; fill-- {
			groups = append(groups, "0")
		}
		groups = append(groups, rg...)
	} else if head != "" {
		groups = strings.Split(head, ":")
	}
	if len(groups) != need {
		return nil
	}
	v := new(big.Int)
	for _, g := range groups {
		if !hexGrpRe.MatchString(g) {
			return nil
		}
		n, _ := strconv.ParseUint(g, 16, 16)
		v.Lsh(v, 16).Or(v, new(big.Int).SetUint64(n))
	}
	for _, t := range tail {
		v.Lsh(v, 16).Or(v, new(big.Int).SetUint64(t))
	}
	return v
}

// ParseIP parses a bare v4/v6 address (nil when invalid).
func ParseIP(raw string) *ParsedIP {
	ip := NormalizeIP(raw)
	if ip == "" {
		return nil
	}
	if strings.Contains(ip, ":") {
		if v := parseIPv6(ip); v != nil {
			return &ParsedIP{6, v}
		}
		return nil
	}
	if v := parseIPv4(ip); v != nil {
		return &ParsedIP{4, v}
	}
	return nil
}

// ParseCIDR parses a.b.c.d/n, <v6>/n or a bare IP (implied /32 or /128).
func ParseCIDR(raw string) *ParsedCIDR {
	entry := strings.TrimSpace(raw)
	if entry == "" {
		return nil
	}
	ipPart, prefixPart, hasPrefix := strings.Cut(entry, "/")
	ip := ParseIP(ipPart)
	if ip == nil {
		return nil
	}
	bits := 32
	if ip.Version == 6 {
		bits = 128
	}
	prefix := bits
	if hasPrefix {
		if !prefixRe.MatchString(prefixPart) {
			return nil
		}
		prefix, _ = strconv.Atoi(prefixPart)
		if prefix > bits {
			return nil
		}
	}
	network := new(big.Int)
	if prefix != 0 {
		host := uint(bits - prefix)
		network.Rsh(ip.Value, host).Lsh(network, host)
	}
	return &ParsedCIDR{ip.Version, network, prefix, NormalizeIP(ipPart) + "/" + strconv.Itoa(prefix)}
}

// InCIDR reports whether ip falls inside c.
func InCIDR(ip *ParsedIP, c *ParsedCIDR) bool {
	if ip.Version != c.Version {
		return false
	}
	if c.Prefix == 0 {
		return true
	}
	bits := 32
	if c.Version == 6 {
		bits = 128
	}
	host := uint(bits - c.Prefix)
	v := new(big.Int).Rsh(ip.Value, host)
	return v.Lsh(v, host).Cmp(c.Network) == 0
}

// MatchesCIDR is the string convenience form.
func MatchesCIDR(ip, cidr string) bool {
	p, c := ParseIP(ip), ParseCIDR(cidr)
	return p != nil && c != nil && InCIDR(p, c)
}

// privateCIDRs are always permitted and never auto-banned (the lock-out
// guarantee): loopback, RFC1918, link-local and the IPv6 equivalents.
var privateCIDRs = func() []*ParsedCIDR {
	var out []*ParsedCIDR
	for _, c := range []string{"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"} {
		out = append(out, ParseCIDR(c))
	}
	return out
}()

// IsPrivateOrLoopback is true for loopback / RFC1918 / link-local / ULA.
func IsPrivateOrLoopback(raw string) bool {
	ip := ParseIP(raw)
	if ip == nil {
		return false
	}
	for _, c := range privateCIDRs {
		if InCIDR(ip, c) {
			return true
		}
	}
	return false
}
