package validate

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

// Port of validator.js isEmail with class-validator's default options
// (allow_display_name=false, allow_utf8_local_part=true, require_tld=true,
// allow_ip_domain=false, allow_underscores=false).

var (
	emailUserUtf8Part   = regexp.MustCompile(`(?i)^[a-z\d!#$%&'*+\-/=?^_` + "`" + `{|}~\x{00A1}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFEF}]+$`)
	quotedEmailUserUtf8 = regexp.MustCompile(`(?i)^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e\x{00A0}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFEF}]|(\\[\x01-\x09\x0b\x0c\x0d-\x7f\x{00A0}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFEF}]))*$`)
	fqdnTLD             = regexp.MustCompile(`(?i)^([a-z\x{00A1}-\x{00A8}\x{00AA}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$`)
	fqdnPart            = regexp.MustCompile(`(?i)^[a-z_\x{00a1}-\x{ffff}0-9-]+$`)
	fullWidth           = regexp.MustCompile(`[\x{ff01}-\x{ff5e}]`)
	allDigits           = regexp.MustCompile(`^\d+$`)
	whitespace          = regexp.MustCompile(`\s`)
)

// IsEmail reports whether s is an email per validator.js defaults.
func IsEmail(s string) bool {
	if utf16Len(s) > 254 {
		return false
	}
	at := strings.LastIndex(s, "@")
	if at < 0 {
		return false
	}
	user, domain := s[:at], s[at+1:]
	if byteLength(user) > 64 || byteLength(domain) > 254 {
		return false
	}
	if !isFQDN(domain) {
		return false
	}
	if len(user) >= 2 && user[0] == '"' && user[len(user)-1] == '"' {
		return quotedEmailUserUtf8.MatchString(user[1 : len(user)-1])
	}
	for _, part := range strings.Split(user, ".") {
		if !emailUserUtf8Part.MatchString(part) {
			return false
		}
	}
	return true
}

func isFQDN(s string) bool {
	parts := strings.Split(s, ".")
	tld := parts[len(parts)-1]
	if len(parts) < 2 || !fqdnTLD.MatchString(tld) || whitespace.MatchString(tld) {
		return false
	}
	if allDigits.MatchString(tld) {
		return false
	}
	for _, p := range parts {
		if utf16Len(p) > 63 || !fqdnPart.MatchString(p) || fullWidth.MatchString(p) ||
			strings.HasPrefix(p, "-") || strings.HasSuffix(p, "-") || strings.Contains(p, "_") {
			return false
		}
	}
	return true
}

// byteLength is validator.js isByteLength (encodeURI length = UTF-8 bytes).
func byteLength(s string) int { return len(s) }

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }
