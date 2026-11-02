package recording

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/httpx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/jsx"
	"gitlab.com/digitalhub_com_ar/vision-media-server/streamhub-core-go/internal/platform/yamljs"
)

// PublishFile is the recording upload flow (probe → snapshot → the app's S3
// bucket → presigned URL → `ready` VOD row) for a media file the core made
// itself — the G6 clips — instead of an egress. It never dispatches the
// recording_* / vod_ready callbacks (the caller owns its own event) nor
// queues a transcode: a clip is a short `-c copy` cut, already playable.

// PublishInput is one finished local MP4 to publish.
type PublishInput struct {
	App       string
	StreamID  string // "" = NULL
	Room      string
	Name      string // VOD name; also the S3 key's basename
	KeyPrefix string // S3 key prefix under the app prefix (e.g. "clips/")
	Source    string // VodSourceClip …
	LocalPath string
	StartedAt time.Time
	EndedAt   time.Time
	// Meta is merged into metatags_json (then app/room/media fields).
	Meta *yamljs.Map
	// KeepLocal leaves the local file in place (default: removed on success).
	KeepLocal bool
}

// CheckStorage is the bucket guard StartRecording applies (409
// storage_not_configured), for callers that must refuse before queueing.
func (s *Service) CheckStorage(ctx context.Context, app string) error {
	cfg, err := s.loadConfig(ctx, app)
	if err != nil {
		return err
	}
	if jsTrim(cfg.S3.Bucket) == "" {
		return &httpx.Error{Status: 409, Body: storageNotConfigured{
			"storage_not_configured",
			fmt.Sprintf("app '%s' has no S3 storage bucket configured; clips cannot be uploaded", app),
			app,
		}}
	}
	return nil
}

// PublishFile inserts the VOD row (`uploading`), uploads and marks it
// `ready`; on an upload failure the row is `failed` and the error returned.
func (s *Service) PublishFile(ctx context.Context, in PublishInput) (*VodRecord, error) {
	if err := s.CheckStorage(ctx, in.App); err != nil {
		return nil, err
	}
	cfg, err := s.loadConfig(ctx, in.App)
	if err != nil {
		return nil, err
	}
	meta := yamljs.NewMap()
	if in.Meta != nil {
		meta = in.Meta.Clone()
	}
	mj, _ := yamljs.Stringify(meta)
	var streamID *string
	if in.StreamID != "" {
		streamID = str(in.StreamID)
	}
	id, err := s.vods.Insert(ctx, in.App, VodInsert{
		AppID: s.resolveAppID(ctx, in.App), StreamID: streamID, Room: str(in.Room), Name: in.Name,
		Status: "uploading", LocalPath: str(in.LocalPath), StartedAt: str(jsx.ISO(in.StartedAt)), MetatagsJSON: &mj, Source: in.Source,
	})
	if err != nil {
		return nil, err
	}
	vod, err := s.vods.FindByID(ctx, in.App, id)
	if err != nil || vod == nil {
		return nil, fmt.Errorf("vod %d vanished after insert", id)
	}
	fail := func(err error) (*VodRecord, error) {
		_ = s.vods.Update(ctx, in.App, id, (&VodPatch{}).Set("status", "failed"))
		write(s.logs, "error", "publish failed", map[string]any{"appName": in.App, "vodId": id, "detail": err.Error()})
		return nil, err
	}
	media := ProbeMedia(ctx, s.runner, in.LocalPath)
	snapKey, snapLocal := s.buildSnapshot(ctx, in.App, cfg, vod, in.LocalPath)
	up, err := s.s3.Upload(ctx, cfg.S3, in.LocalPath, in.KeyPrefix+filepath.Base(in.Name), "video/mp4")
	if err != nil {
		return fail(err)
	}
	publicURL := up.URL
	if p, err := s.s3.PresignGet(ctx, cfg.S3, up.Key, presignTTL, nil); err == nil {
		publicURL = p
	} else {
		s.warn("presign failed: " + err.Error())
	}
	var localPath any = in.LocalPath
	if !in.KeepLocal {
		s.removeLocal(in.LocalPath)
		localPath = nil
	}
	s.removeLocal(snapLocal)
	meta.Set("room", in.Room)
	meta.Set("app", in.App)
	meta.Set("durationS", nullNum(media.DurationS))
	meta.Set("width", nullNum(media.Width))
	meta.Set("height", nullNum(media.Height))
	meta.Set("codec", nullStr(media.Format))
	mj, _ = yamljs.Stringify(meta)
	p := (&VodPatch{}).Set("status", "ready").Set("file_key", up.Key).Set("s3_url", up.URL).Set("public_url", publicURL).
		Set("size_bytes", up.SizeBytes).Set("duration_s", ptrVal(media.DurationS)).Set("width", ptrVal(media.Width)).
		Set("height", ptrVal(media.Height)).Set("format", ptrVal(media.Format)).Set("snapshot_key", ptrVal(snapKey)).
		Set("local_path", localPath).Set("ended_at", jsx.ISO(in.EndedAt)).Set("metatags_json", mj)
	if err := s.vods.Update(ctx, in.App, id, p); err != nil {
		return fail(err)
	}
	write(s.logs, "info", "vod ready", map[string]any{"appName": in.App, "vodId": id, "fileKey": up.Key, "sizeBytes": up.SizeBytes, "source": in.Source})
	if m := get(s.opt.Metrics); m != nil {
		m.VodGenerated(in.App)
	}
	return s.vods.FindByID(ctx, in.App, id)
}
