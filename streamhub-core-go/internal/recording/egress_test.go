package recording

import (
	"context"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/testutil"
)

// A4: the DRM key-server request (features.drm.key_server_url, tenant
// config) goes out through the egress-guarded client: no 302 to an
// internal address.
func TestDrmKeyServerRefusesRedirectToLoopback(t *testing.T) {
	start, hits := testutil.RedirectToLoopback(t)
	p := NewExternalDrmProvider(extCfg(func(f *contracts.DrmFeatures) { f.KeyServerURL = start }), "", nil)
	if k := p.GetContentKeys(context.Background(), "v"); k != nil {
		t.Fatalf("keys from a redirected request: %+v", k)
	}
	if hits.Load() != 0 {
		t.Fatalf("the 302 reached the loopback target (%d hits)", hits.Load())
	}
}
