package passthrough

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// MPEG-TS-over-UDP source parse / validate / canonicalize
// (mpegts-source.util.ts). The operator's udp:// string is NEVER passed to
// ffmpeg verbatim: every component is allow-listed and the URL rebuilt.
const (
	mpegtsMaxSourceIPs = 16
	mpegtsMinFifo      = 1
	mpegtsMaxFifo      = 100_000_000
)

var allowedQueryKeys = []string{"sources", "block", "localaddr", "fifo_size", "overrun_nonfatal"}

// MpegtsError is a 400-worthy invalid source.
type MpegtsError struct{ msg string }

func (e *MpegtsError) Error() string { return e.msg }

func mpegtsErr(format string, a ...any) error { return &MpegtsError{fmt.Sprintf(format, a...)} }

// MpegtsOptions are the structured source options (DTO fields + url).
// nil = absent; Sources/Block are the comma-separated (or array) lists.
type MpegtsOptions struct {
	URL             string
	Sources         []string
	SourcesRaw      *string
	Block           []string
	BlockRaw        *string
	Localaddr       *string
	FifoSize        *float64
	OverrunNonfatal *bool
}

// ParsedMpegts is the canonical source + its decoded parts.
type ParsedMpegts struct {
	SourceURL       string
	Host            string
	Port            int
	Multicast       bool
	SsmSources      []string
	BlockSources    []string
	Localaddr       string
	FifoSize        *int
	OverrunNonfatal bool
}

var ipv4Shape = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`)

// IsValidIPv4 is the strict dotted quad (no leading zeros, 0..255).
func IsValidIPv4(s string) bool {
	m := ipv4Shape.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	for _, o := range m[1:5] {
		n, _ := strconv.Atoi(o)
		if n > 255 || strconv.Itoa(n) != o {
			return false
		}
	}
	return true
}

// IsMulticastIPv4 is 224.0.0.0/4.
func IsMulticastIPv4(s string) bool {
	if !IsValidIPv4(s) {
		return false
	}
	first, _ := strconv.Atoi(strings.SplitN(s, ".", 2)[0])
	return first >= 224 && first <= 239
}

func normalizeIPList(arr []string, raw *string, label string) ([]string, error) {
	var parts []string
	switch {
	case arr != nil:
		parts = arr
	case raw != nil:
		parts = strings.Split(*raw, ",")
	default:
		return []string{}, nil
	}
	out := []string{}
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) > mpegtsMaxSourceIPs {
		return nil, mpegtsErr("%s accepts at most %d source addresses", label, mpegtsMaxSourceIPs)
	}
	for _, p := range out {
		if !IsValidIPv4(p) {
			return nil, mpegtsErr(`%s must be a comma-separated list of IPv4 addresses (got "%s")`, label, p)
		}
	}
	return out, nil
}

var udpShape = regexp.MustCompile(`(?i)^udp://(@)?([^:/?#]*)(?::(\d+))?(?:\?(.*))?$`)

type rawUDP struct {
	host  string
	port  int
	query map[string]string
}

func parseUDPURL(raw string) (*rawUDP, error) {
	s := strings.TrimSpace(raw)
	m := udpShape.FindStringSubmatchIndex(s)
	if m == nil {
		return nil, mpegtsErr("source must be a udp:// URL, e.g. udp://@239.1.1.1:5000 (multicast) or udp://@:5000 (unicast)")
	}
	group := func(i int) (string, bool) {
		if m[2*i] < 0 {
			return "", false
		}
		return s[m[2*i]:m[2*i+1]], true
	}
	host, _ := group(2)
	portStr, ok := group(3)
	if !ok {
		return nil, mpegtsErr("source udp:// URL must include a port (udp://@HOST:PORT)")
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return nil, mpegtsErr("source port must be between 1 and 65535 (got %s)", portStr)
	}
	query := map[string]string{}
	if q, ok := group(4); ok && q != "" {
		for _, pair := range strings.Split(q, "&") {
			if pair == "" {
				continue
			}
			key, val := pair, ""
			if eq := strings.Index(pair, "="); eq != -1 {
				key = pair[:eq]
				dec, err := url.PathUnescape(pair[eq+1:])
				if err != nil {
					return nil, mpegtsErr("URI malformed")
				}
				val = strings.TrimSpace(dec)
			}
			key = strings.TrimSpace(key)
			allowed := false
			for _, k := range allowedQueryKeys {
				allowed = allowed || k == key
			}
			if !allowed {
				return nil, mpegtsErr(`unsupported query parameter "%s" — allowed: %s`, key, strings.Join(allowedQueryKeys, ", "))
			}
			query[key] = val
		}
	}
	return &rawUDP{host, port, query}, nil
}

func queryPtr(q map[string]string, k string) *string {
	if v, ok := q[k]; ok {
		return &v
	}
	return nil
}

// ParseMpegtsSource validates + canonicalizes a source. Structured fields
// win over the same option in the url query.
func ParseMpegtsSource(o MpegtsOptions) (*ParsedMpegts, error) {
	u, err := parseUDPURL(o.URL)
	if err != nil {
		return nil, err
	}
	// Host: empty (INADDR_ANY unicast) or a literal IPv4 — never a hostname.
	if u.host != "" && !IsValidIPv4(u.host) {
		return nil, mpegtsErr(`source host must be an IPv4 address or empty (got "%s")`, u.host)
	}
	multicast := u.host != "" && IsMulticastIPv4(u.host)

	srcRaw := o.SourcesRaw
	if o.Sources == nil && srcRaw == nil {
		srcRaw = queryPtr(u.query, "sources")
	}
	ssm, err := normalizeIPList(o.Sources, srcRaw, "sources")
	if err != nil {
		return nil, err
	}
	blkRaw := o.BlockRaw
	if o.Block == nil && blkRaw == nil {
		blkRaw = queryPtr(u.query, "block")
	}
	block, err := normalizeIPList(o.Block, blkRaw, "block")
	if err != nil {
		return nil, err
	}
	if (len(ssm) > 0 || len(block) > 0) && !multicast {
		return nil, mpegtsErr("sources=/block= (source-specific multicast) require a multicast group host (224.0.0.0/4)")
	}

	localaddr := ""
	if o.Localaddr != nil {
		localaddr = strings.TrimSpace(*o.Localaddr)
	} else if v, ok := u.query["localaddr"]; ok {
		localaddr = strings.TrimSpace(v)
	}
	if localaddr != "" && !IsValidIPv4(localaddr) {
		return nil, mpegtsErr(`localaddr must be an IPv4 interface address (got "%s")`, localaddr)
	}

	fifo := o.FifoSize
	if fifo == nil {
		if v, ok := u.query["fifo_size"]; ok {
			f := jsNumber(v)
			fifo = &f
		}
	}
	var fifoSize *int
	if fifo != nil {
		f := *fifo
		if f != math.Trunc(f) || math.IsInf(f, 0) || math.IsNaN(f) || f < mpegtsMinFifo || f > mpegtsMaxFifo {
			return nil, mpegtsErr("fifo_size must be an integer in [%d, %d] packets", mpegtsMinFifo, mpegtsMaxFifo)
		}
		n := int(f)
		fifoSize = &n
	}

	overrun := true
	if o.OverrunNonfatal != nil {
		overrun = *o.OverrunNonfatal
	} else if v, ok := u.query["overrun_nonfatal"]; ok {
		overrun = v == "1" || v == "true"
	}

	return &ParsedMpegts{
		SourceURL: BuildUDPURL(u.host, u.port, ssm, block, localaddr, fifoSize, overrun),
		Host:      u.host, Port: u.port, Multicast: multicast, SsmSources: ssm, BlockSources: block,
		Localaddr: localaddr, FifoSize: fifoSize, OverrunNonfatal: overrun,
	}, nil
}

// BuildUDPURL is the canonical ffmpeg receive URL (stable key order;
// overrun_nonfatal always present).
func BuildUDPURL(host string, port int, ssm, block []string, localaddr string, fifoSize *int, overrun bool) string {
	var q []string
	if len(ssm) > 0 {
		q = append(q, "sources="+strings.Join(ssm, ","))
	}
	if len(block) > 0 {
		q = append(q, "block="+strings.Join(block, ","))
	}
	if localaddr != "" {
		q = append(q, "localaddr="+localaddr)
	}
	if fifoSize != nil {
		q = append(q, "fifo_size="+strconv.Itoa(*fifoSize))
	}
	o := 0
	if overrun {
		o = 1
	}
	q = append(q, "overrun_nonfatal="+strconv.Itoa(o))
	return "udp://@" + host + ":" + strconv.Itoa(port) + "?" + strings.Join(q, "&")
}

// jsNumber is Number(s) for a query value ("" → 0, garbage → NaN).
func jsNumber(s string) float64 {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0
	}
	if f, err := strconv.ParseFloat(t, 64); err == nil {
		return f
	}
	if strings.HasPrefix(strings.ToLower(t), "0x") {
		if n, err := strconv.ParseInt(t[2:], 16, 64); err == nil {
			return float64(n)
		}
	}
	return math.NaN()
}
