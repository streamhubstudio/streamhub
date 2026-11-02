package apps

import (
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	y "gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// validateRawLocalDir (validateRaw): recording.local_dir is joined onto the
// app dir and egress writes the MP4s there, so it must be one plain
// directory name (contracts.ValidLocalDir); absent / null / "" mean the
// default. The recording service re-checks containment at launch.
//
// GO-DIVERGENCE (security): Node accepted any string ("../x", "/etc").
func validateRawLocalDir(obj *y.Map) error {
	v := prop(orObject(obj.Get("recording")), "local_dir")
	if y.IsNullish(v) || v == "" {
		return nil
	}
	if s, ok := v.(string); !ok || !contracts.ValidLocalDir(s) {
		return httpx.BadRequest(`"recording.local_dir" must be a single directory name ([A-Za-z0-9._-], 1-64 chars, no "..")`)
	}
	return nil
}
