// Package timezone is shared/timezone.util.ts: the server-side "is this a
// real IANA timezone" check. Node answers it with ICU (Intl), which accepts
// canonical names, zoneinfo links (US/Eastern), any letter case and ES2024
// UTC-offset zones (+05:00). The accepted name set is generated from Node
// into names.txt (gen_names.js), so the answer does not depend on the host's
// zoneinfo.
package timezone

import (
	_ "embed"
	"regexp"
	"strings"
)

//go:embed names.txt
var namesTxt string

//go:embed supported.txt
var supportedTxt string

var (
	known     = map[string]bool{}
	supported []string
)

func init() {
	for _, n := range strings.Fields(namesTxt) {
		known[strings.ToLower(n)] = true
	}
	supported = strings.Fields(supportedTxt)
}

// offsetZone is an ECMA-402 offset time zone: ±HH, ±HHMM or ±HH:MM.
var offsetZone = regexp.MustCompile(`^[+-]([01]\d|2[0-3])(:?[0-5]\d)?$`)

// IsValid reports whether tz is a real IANA zone name. "" is always valid
// (server/host local time).
func IsValid(tz string) bool {
	if tz == "" {
		return true
	}
	return known[strings.ToLower(tz)] || offsetZone.MatchString(tz)
}

// List is Intl.supportedValuesOf('timeZone') ∪ {UTC}, sorted.
func List() []string { return append([]string(nil), supported...) }
