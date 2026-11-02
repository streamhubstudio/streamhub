package apps

import (
	"encoding/json"
	"strings"
	"testing"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
)

// G5/G6: features.dvr / features.hls / features.clips resolve to nil until
// config.yaml carries the block (an existing app serializes byte-identical),
// and every value is clamped — garbage never reaches the egress or ffmpeg.
func TestFeaturesDvrHlsClipsResolve(t *testing.T) {
	s, _ := newTestService(t)
	mustCreate(t, s, contracts.CreateAppInput{Name: "live"})

	cfg, err := s.GetConfig(bg, "live")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Features.Dvr != nil || cfg.Features.Hls != nil || cfg.Features.Clips != nil {
		t.Fatalf("fresh app must not resolve the G5/G6 blocks: %+v", cfg.Features)
	}
	if b, _ := json.Marshal(cfg.Features); strings.Contains(string(b), `"dvr":{`) || strings.Contains(string(b), `"hls"`) || strings.Contains(string(b), `"clips"`) {
		t.Fatalf("absent blocks must be omitted from the JSON: %s", b)
	}

	put := func(features string) *contracts.AppConfig {
		t.Helper()
		if _, err := s.PutRawConfig(bg, "live", "name: live\nroom_prefix: live\nfeatures:\n"+features); err != nil {
			t.Fatal(err)
		}
		c, err := s.GetConfig(bg, "live")
		if err != nil {
			t.Fatal(err)
		}
		return c
	}

	c := put("  dvr: {enabled: true}\n  hls: {}\n  clips: {enabled: true}\n")
	if *c.Features.Dvr != (contracts.DvrFeatures{Enabled: true, WindowMinutes: 60}) {
		t.Errorf("dvr defaults = %+v", *c.Features.Dvr)
	}
	if *c.Features.Hls != (contracts.HlsFeatures{SegmentSeconds: 4, ListSize: 0}) {
		t.Errorf("hls defaults = %+v", *c.Features.Hls)
	}
	if *c.Features.Clips != (contracts.ClipsFeatures{Enabled: true, MaxSeconds: 120, MaxConcurrent: 2, MaxQueued: 20}) {
		t.Errorf("clips defaults = %+v", *c.Features.Clips)
	}

	c = put("  dvr: {enabled: yes-ish, window_minutes: 99999}\n  hls: {segment_seconds: 0.4, list_size: -3}\n" +
		"  clips: {enabled: true, max_seconds: 10000, max_concurrent: 0, max_queued: abc}\n")
	if *c.Features.Dvr != (contracts.DvrFeatures{Enabled: false, WindowMinutes: 1440}) {
		t.Errorf("dvr clamp = %+v (only a literal true enables)", *c.Features.Dvr)
	}
	if *c.Features.Hls != (contracts.HlsFeatures{SegmentSeconds: 1, ListSize: 0}) {
		t.Errorf("hls clamp = %+v", *c.Features.Hls)
	}
	if *c.Features.Clips != (contracts.ClipsFeatures{Enabled: true, MaxSeconds: 600, MaxConcurrent: 1, MaxQueued: 20}) {
		t.Errorf("clips clamp = %+v", *c.Features.Clips)
	}

	c = put("  dvr: [1, 2]\n  hls: 6\n")
	if c.Features.Dvr != nil || c.Features.Hls != nil {
		t.Errorf("a non-mapping block is not a block: %+v %+v", c.Features.Dvr, c.Features.Hls)
	}

	// A structured PATCH of the boolean flags keeps the yaml-only blocks.
	put("  dvr: {enabled: true, window_minutes: 30}\n")
	on := true
	merged, err := s.UpdateConfig(bg, "live", contracts.AppConfigPatch{Features: &contracts.FeaturesPatch{Chat: &on}})
	if err != nil {
		t.Fatal(err)
	}
	if merged.Features.Dvr == nil || merged.Features.Dvr.WindowMinutes != 30 || !merged.Features.Chat {
		t.Errorf("patch dropped features.dvr: %+v", merged.Features)
	}
}
