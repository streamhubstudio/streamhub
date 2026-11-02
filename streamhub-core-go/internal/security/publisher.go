package security

// PublisherAllowed is the per-app allowedPublisherCIDR verdict (AntMedia's
// ingest-origin whitelist): an empty list lets every source publish;
// otherwise ip must fall inside one of the entries (a bare IP is /32 or
// /128). An unparsable ip or entry never matches — a typo in the list
// fails closed, it does not open the app.
func PublisherAllowed(cidrs []string, ip string) bool {
	if len(cidrs) == 0 {
		return true
	}
	p := ParseIP(ip)
	if p == nil {
		return false
	}
	for _, raw := range cidrs {
		if c := ParseCIDR(raw); c != nil && InCIDR(p, c) {
			return true
		}
	}
	return false
}
