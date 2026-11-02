package plugins

import (
	"context"
	"fmt"
	"os"
	"strings"

	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/security"
)

// assertURLFields is the SSRF guard over the configSchema fields declared
// `format: "url"` (M4): the worker POSTs to them from the host (e.g. the
// vendor apps' callbackUrl), so a PATCH that sets one to a private /
// loopback / link-local / metadata target is a 400 — the same guard and
// STREAMHUB_CALLBACK_ALLOW_HOSTS allowlist as the app callback URL. Only
// the keys the PATCH sets are checked (an empty value = unset); next holds
// their validated values.
//
// GO-DIVERGENCE (security): Node had no `format` and stored any URL.
func (s *Service) assertURLFields(ctx context.Context, meta *Meta, patch, next *y.Map) error {
	resolve := security.HostResolver(s.Resolve)
	if resolve == nil {
		resolve = security.DefaultHostResolver
	}
	for _, f := range meta.Fields {
		if f.Format != "url" {
			continue
		}
		if _, set := patch.Lookup(f.Key); !set {
			continue
		}
		v, _ := next.Get(f.Key).(string)
		if v = strings.TrimSpace(v); v == "" {
			continue
		}
		if err := security.AssertSafeEgressURL(ctx, v, security.EgressOptions{
			AllowedSchemes: security.HTTPSchemes,
			Label:          fmt.Sprintf("config field '%s'", f.Key),
			Allowlist:      security.ParseAllowlistEnv(os.Getenv(security.CallbackAllowHostsEnv)),
			Resolve:        resolve,
		}); err != nil {
			return err
		}
	}
	return nil
}
