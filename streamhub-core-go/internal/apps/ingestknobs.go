package apps

import (
	"math"
	"strings"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/validate"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// Publisher restrictions (AntMedia-matrix quick wins, 3.4.0):
// features.allowed_publisher_cidr and features.max_bitrate_accept. Both are
// OFF when absent and written to disk only when set, so an existing
// config.yaml (and every pre-3.4 response) is unchanged.

const (
	allowedPublisherCidrMessage = "allowedPublisherCidr must be a list of IPv4/IPv6 addresses or CIDRs (e.g. 203.0.113.0/24)"
	// MaxPublisherCIDRs caps features.allowed_publisher_cidr on PATCH.
	MaxPublisherCIDRs = 64
)

// resolvePublisherCIDR resolves features.allowed_publisher_cidr: a YAML list
// or an AntMedia-style comma-separated string, trimmed, empties dropped.
// Invalid entries are KEPT (they match nothing — security.PublisherAllowed
// fails closed) so a hand-edited typo never silently opens the app.
func resolvePublisherCIDR(v any) []string {
	var raw []string
	switch x := v.(type) {
	case string:
		raw = strings.Split(x, ",")
	case []any:
		for _, e := range x {
			if !y.IsNullish(e) {
				raw = append(raw, y.ToString(e))
			}
		}
	}
	var out []string
	for _, e := range raw {
		if e = strings.TrimSpace(e); e != "" {
			out = append(out, e)
		}
	}
	return out
}

// resolveMaxBitrateAccept resolves features.max_bitrate_accept (bits/s):
// a finite positive number, floored; anything else is 0 (no cap).
func resolveMaxBitrateAccept(v any) float64 {
	n := y.ToNumber(v)
	if !finite(n) || n <= 0 {
		return 0
	}
	return math.Floor(n)
}

// PublisherFeatureRules validates the publisher-restriction keys of a
// `features` PATCH object — shared by PATCH /apps/:app and PATCH
// /apps/:app/config (the dashboard's), so both accept the same shape.
func PublisherFeatureRules(f *validate.Body) {
	f.Optional("allowedPublisherCidr").Check(validPublisherCIDRs(f.Raw("allowedPublisherCidr")), allowedPublisherCidrMessage).
		ArrayMaxSize(MaxPublisherCIDRs).EachMaxLength(64).EachIsString().IsArray()
	f.Optional("maxBitrateAccept").Min(0).IsInt()
}

// PublisherFeaturePatch maps the validated keys onto fp (absent = untouched).
func PublisherFeaturePatch(f map[string]any, fp *contracts.FeaturesPatch) {
	fp.AllowedPublisherCidr = publisherCIDRPatch(f["allowedPublisherCidr"])
	if n, ok := f["maxBitrateAccept"].(float64); ok {
		fp.MaxBitrateAccept = &n
	}
}

// validPublisherCIDRs is the PATCH check: every entry a string that parses
// as an address or CIDR (a non-array is left to IsArray).
func validPublisherCIDRs(v any) bool {
	list, ok := v.([]any)
	if !ok {
		return true
	}
	for _, e := range list {
		s, isStr := e.(string)
		if !isStr || security.ParseCIDR(s) == nil {
			return false
		}
	}
	return true
}

// publisherCIDRPatch maps the validated PATCH value (nil = untouched).
func publisherCIDRPatch(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}
