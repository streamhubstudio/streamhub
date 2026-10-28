package security

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
)

// Port of egress-url.guard.ts — the SSRF guard for server-side egress dials
// (webhook/callback URLs, custom S3 endpoints, MQTT brokers): the URL scheme
// must be allowlisted and the host must not be / resolve to a private,
// loopback, link-local, metadata or unspecified address. Failures are 400s.

// Env knobs read by the sink call sites.
const (
	CallbackAllowHostsEnv     = "STREAMHUB_CALLBACK_ALLOW_HOSTS"
	AllowPrivateS3EndpointEnv = "STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT"
	AllowPrivateMQTTBrokerEnv = "STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER"
)

// HTTPSchemes are the schemes a callback or S3 endpoint may use.
var HTTPSchemes = []string{"http:", "https:"}

// MQTTSchemes are the mqtt.js transports a broker URL may use.
var MQTTSchemes = []string{"mqtt:", "mqtts:", "ws:", "wss:", "tcp:", "tls:"}

// EnvFlag accepts 1/true/yes/on (case-insensitive).
func EnvFlag(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// ParseAllowlistEnv splits a comma list into trimmed non-empty entries.
func ParseAllowlistEnv(raw string) []string {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// HostResolver resolves a hostname (injectable: tests never dial DNS).
type HostResolver func(ctx context.Context, host string) ([]string, error)

// DefaultHostResolver uses the system resolver.
func DefaultHostResolver(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}

// EgressOptions configure one sink.
type EgressOptions struct {
	AllowedSchemes []string // WHATWG protocol strings, with the colon
	Label          string   // e.g. "callback URL"
	AllowPrivate   bool     // skip the private check (scheme still checked)
	Allowlist      []string // hostnames / IPs / CIDRs exempted from the private check
	Resolve        HostResolver
}

// IsForbiddenEgressAddress: private/loopback/link-local or unspecified.
func IsForbiddenEgressAddress(addr string) bool {
	if IsPrivateOrLoopback(addr) {
		return true
	}
	p := ParseIP(addr)
	return p != nil && p.Value.Sign() == 0
}

type compiledAllowlist struct {
	hostnames map[string]bool
	cidrs     []*ParsedCIDR
}

func compileAllowlist(entries []string) compiledAllowlist {
	c := compiledAllowlist{hostnames: map[string]bool{}}
	for _, e := range entries {
		if p := ParseCIDR(e); p != nil {
			c.cidrs = append(c.cidrs, p)
		} else {
			c.hostnames[strings.ToLower(e)] = true
		}
	}
	return c
}

func (c compiledAllowlist) hasAddress(addr string) bool {
	ip := ParseIP(addr)
	if ip == nil {
		return false
	}
	for _, x := range c.cidrs {
		if InCIDR(ip, x) {
			return true
		}
	}
	return false
}

// ParseEgressURL is the synchronous half: parse + scheme check.
func ParseEgressURL(raw string, opts EgressOptions) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || !u.IsAbs() {
		return nil, httpx.BadRequest(fmt.Sprintf("invalid %s: '%s'", opts.Label, raw))
	}
	proto := strings.ToLower(u.Scheme) + ":"
	allowed := false
	for _, s := range opts.AllowedSchemes {
		if s == proto {
			allowed = true
		}
	}
	if !allowed {
		names := make([]string, len(opts.AllowedSchemes))
		for i, s := range opts.AllowedSchemes {
			names[i] = strings.TrimSuffix(s, ":")
		}
		return nil, httpx.BadRequest(fmt.Sprintf("%s scheme '%s' is not allowed (allowed: %s)", opts.Label, strings.TrimSuffix(proto, ":"), strings.Join(names, ", ")))
	}
	if u.Hostname() == "" {
		return nil, httpx.BadRequest(fmt.Sprintf("%s has no host", opts.Label))
	}
	// WHATWG URL lower-cases the host and canonicalises numeric IPv4 forms
	// (http://2130706433/, http://0x7f.1/ → 127.0.0.1); do the same so those
	// are checked as IP literals.
	host := strings.ToLower(u.Hostname())
	if v4, ok := whatwgIPv4(host); ok {
		host = v4
	}
	if u.Port() != "" {
		u.Host = net.JoinHostPort(host, u.Port())
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	return u, nil
}

// whatwgIPv4 is the WHATWG IPv4 parser: 1–4 dot-separated decimal, 0x-hex
// or 0-octal parts, the last one filling the remaining bytes.
func whatwgIPv4(host string) (string, bool) {
	parts := strings.Split(host, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if len(parts) == 0 || len(parts) > 4 {
		return "", false
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		base, digits := 10, p
		switch {
		case strings.HasPrefix(p, "0x") || strings.HasPrefix(p, "0X"):
			base, digits = 16, p[2:]
		case len(p) > 1 && p[0] == '0':
			base, digits = 8, p[1:]
		}
		if p == "" {
			return "", false
		}
		if digits == "" {
			nums[i] = 0
			continue
		}
		n, err := strconv.ParseUint(digits, base, 64)
		if err != nil {
			return "", false
		}
		nums[i] = n
	}
	for _, n := range nums[:len(nums)-1] {
		if n > 255 {
			return "", false
		}
	}
	last := nums[len(nums)-1]
	if last >= 1<<(8*(5-len(nums))) {
		return "", false
	}
	v := last
	for i, n := range nums[:len(nums)-1] {
		v += n << (8 * (3 - i))
	}
	return fmt.Sprintf("%d.%d.%d.%d", v>>24&255, v>>16&255, v>>8&255, v&255), true
}

// AssertSafeEgressURLSync checks scheme + IP-literal hosts only (no DNS).
func AssertSafeEgressURLSync(raw string, opts EgressOptions) error {
	u, err := ParseEgressURL(raw, opts)
	if err != nil || opts.AllowPrivate {
		return err
	}
	host := u.Hostname()
	allow := compileAllowlist(opts.Allowlist)
	if allow.hostnames[strings.ToLower(host)] {
		return nil
	}
	if ParseIP(host) != nil && !allow.hasAddress(host) && IsForbiddenEgressAddress(host) {
		return httpx.BadRequest(opts.Label + " points at a private/loopback/link-local address")
	}
	return nil
}

// AssertSafeEgressURL is the full guard: hostnames are resolved and EVERY
// answer is checked (partial-poison defence).
func AssertSafeEgressURL(ctx context.Context, raw string, opts EgressOptions) error {
	u, err := ParseEgressURL(raw, opts)
	if err != nil || opts.AllowPrivate {
		return err
	}
	host := u.Hostname()
	allow := compileAllowlist(opts.Allowlist)
	if allow.hostnames[strings.ToLower(host)] {
		return nil
	}
	if ParseIP(host) != nil {
		if !allow.hasAddress(host) && IsForbiddenEgressAddress(host) {
			return httpx.BadRequest(opts.Label + " points at a private/loopback/link-local address")
		}
		return nil
	}
	resolve := opts.Resolve
	if resolve == nil {
		resolve = DefaultHostResolver
	}
	addrs, err := resolve(ctx, host)
	if err != nil || len(addrs) == 0 {
		return httpx.BadRequest(fmt.Sprintf("%s host '%s' does not resolve", opts.Label, host))
	}
	for _, a := range addrs {
		if IsForbiddenEgressAddress(a) && !allow.hasAddress(a) {
			return httpx.BadRequest(opts.Label + " resolves to a private/loopback/link-local address")
		}
	}
	return nil
}
