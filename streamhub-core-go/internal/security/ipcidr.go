// Package security is network security (modules/security): the global IP
// allow/blocklist with CIDR support (ip_rules), the in-app fail2ban with
// escalating bans (ip_bans), the early middleware enforcing both on every
// path, the WebSocket-upgrade verdict, the SSRF egress-URL guard and the
// superadmin /security admin API.
package security

import "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/netaddr"

// The IP/CIDR classification (port of ip-cidr.util.ts) lives in
// platform/netaddr so the egress-guarded dialer of platform/httpx shares it
// without an import cycle; these are the names this package always exposed.

// ParsedIP is an address as an unsigned integer (32 bits v4, 128 bits v6).
type ParsedIP = netaddr.ParsedIP

// ParsedCIDR is a compiled network (host bits zeroed).
type ParsedCIDR = netaddr.ParsedCIDR

// NormalizeIP strips a zone index and the IPv4-mapped IPv6 prefix.
func NormalizeIP(raw string) string { return netaddr.NormalizeIP(raw) }

// ParseIP parses a bare v4/v6 address (nil when invalid).
func ParseIP(raw string) *ParsedIP { return netaddr.ParseIP(raw) }

// ParseCIDR parses a.b.c.d/n, <v6>/n or a bare IP (implied /32 or /128).
func ParseCIDR(raw string) *ParsedCIDR { return netaddr.ParseCIDR(raw) }

// InCIDR reports whether ip falls inside c.
func InCIDR(ip *ParsedIP, c *ParsedCIDR) bool { return netaddr.InCIDR(ip, c) }

// MatchesCIDR is the string convenience form.
func MatchesCIDR(ip, cidr string) bool { return netaddr.MatchesCIDR(ip, cidr) }

// IsPrivateOrLoopback is true for loopback / RFC1918 / link-local / ULA.
func IsPrivateOrLoopback(raw string) bool { return netaddr.IsPrivateOrLoopback(raw) }
