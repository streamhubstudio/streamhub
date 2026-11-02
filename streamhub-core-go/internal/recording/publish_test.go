package recording

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/contracts"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// G6: PublishFile reuses the recording upload flow for a core-made MP4 (a
// clip): probe → snapshot → app S3 under the key prefix → presigned URL →
// a `ready` VOD row with source=clip — and none of the recording callbacks.
func TestPublishFile(t *testing.T) {
	ctx := context.Background()
	h := newRC(t, nil)
	local := filepath.Join(h.dir, "apps", "live", "clips", "clip-cam1-20261029-140000-clp_1.mp4")
	_ = os.MkdirAll(filepath.Dir(local), 0o755)
	_ = os.WriteFile(local, []byte("mp4-bytes"), 0o644)
	tags := yamljs.NewMap()
	tags.Set("source", "clip")
	tags.Set("clipId", "clp_1")
	from := time.Date(2026, 10, 29, 14, 0, 0, 0, time.UTC)

	v, err := h.s.PublishFile(ctx, PublishInput{
		App: "live", StreamID: "cam1/enc", Room: "cam1", Name: filepath.Base(local), KeyPrefix: "clips/",
		Source: VodSourceClip, LocalPath: local, StartedAt: from, EndedAt: from.Add(20 * time.Second), Meta: tags,
	})
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "ready" || v.Source != VodSourceClip || v.FileKey == nil || *v.FileKey != "clips/clip-cam1-20261029-140000-clp_1.mp4" ||
		v.PublicURL == nil || !strings.HasPrefix(*v.PublicURL, "https://signed/clips/") || *v.SizeBytes != 9 || *v.DurationS != 10.5 ||
		*v.StartedAt != "2026-10-29T14:00:00.000Z" || *v.EndedAt != "2026-10-29T14:00:20.000Z" || v.LocalPath != nil || v.AppID != 7 {
		t.Fatalf("%+v", v)
	}
	m := meta(t, v)
	if m["clipId"] != "clp_1" || m["source"] != "clip" || m["room"] != "cam1" || m["width"] != 1280.0 {
		t.Fatalf("metatags %v", m)
	}
	if _, err := os.Stat(local); err == nil {
		t.Fatal("the local clip must be removed after the upload")
	}
	if len(h.cb.events) != 0 {
		t.Fatalf("PublishFile must not dispatch recording callbacks: %v", h.cb.names())
	}

	// S3 failure: the row is failed, the error surfaces, the file is kept.
	_ = os.WriteFile(local, []byte("mp4"), 0o644)
	h.s3.failKey = "clp_2.mp4"
	_, err = h.s.PublishFile(ctx, PublishInput{App: "live", Room: "cam1", Name: "clip-clp_2.mp4", KeyPrefix: "clips/", Source: VodSourceClip, LocalPath: local})
	if err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Fatal(err)
	}
	clip := VodSourceClip
	failed := "failed"
	if n, _ := h.s.vods.Count(ctx, "live", VodFilters{Source: &clip, Status: &failed}); n != 1 {
		t.Fatal("failed clip row", n)
	}

	// No bucket → the recording 409 guard.
	h.apps.cfgs["live"] = rcConfig(func(c *contracts.AppConfig) { c.S3.Bucket = " " })
	err = h.s.CheckStorage(ctx, "live")
	body, _ := json.Marshal(err)
	if st, _ := httpStatus(err); st != 409 || string(body) != `{"error":"storage_not_configured","message":"app 'live' has no S3 storage bucket configured; clips cannot be uploaded","app":"live"}` {
		t.Fatal(st, string(body))
	}
	if _, err := h.s.PublishFile(ctx, PublishInput{App: "live", Room: "cam1", Name: "x.mp4", LocalPath: local}); err == nil {
		t.Fatal("publish without a bucket must fail")
	}
}
