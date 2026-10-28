package recording

import (
	"context"
)

// Boot recovery for the in-process job pools (Node's BullMQ queues lived in
// Redis and survived a restart: waiting jobs resumed and a job active at the
// crash was re-run as "stalled"). Go keeps jobs in memory, so at boot (a
// plane starter, after Run) the durable state is re-derived from app.db:
//
//   - `uploading` rows whose local MP4 is still on disk → upload job
//     (exactly the rows a queued/stalled BullMQ upload job would re-run);
//   - `ready` rows that still hold local_path on an app with
//     delete_local_after_upload AND post-transcode variants enabled → the
//     transcode job (its finally{} always nulls local_path, so a surviving
//     path means the job never finished). Without delete_local_after_upload
//     the pending state is not derivable and nothing is re-queued.
//
// `recording` rows are left alone, as in Node (no reconcile existed there:
// a later egress_ended webhook still finds the row via its egressId).

// RecoverResult counts what was re-queued.
type RecoverResult struct {
	Uploads    int
	Transcodes int
}

// Recover re-enqueues interrupted uploads and transcodes across every app.
func (s *Service) Recover(ctx context.Context) RecoverResult {
	var res RecoverResult
	list, err := s.apps.List(ctx, nil)
	if err != nil {
		s.warn("recover: app list failed: " + err.Error())
		return res
	}
	uploading, ready := "uploading", "ready"
	for _, a := range list {
		rows, err := s.vods.List(ctx, a.Name, VodListOptions{VodFilters: VodFilters{Status: &uploading}, Order: "id", Dir: "asc", All: true})
		if err == nil {
			for _, v := range rows {
				if v.LocalPath != nil && *v.LocalPath != "" && exists(*v.LocalPath) {
					s.queue.enqueue(ctx, uploadJob{a.Name, v.ID})
					res.Uploads++
				}
			}
		}
		cfg, err := s.apps.GetConfig(ctx, a.Name)
		if err != nil || !cfg.Recording.DeleteLocalAfterUpload || s.Transcode == nil || !s.Transcode.Needed(cfg) {
			continue
		}
		rows, err = s.vods.List(ctx, a.Name, VodListOptions{VodFilters: VodFilters{Status: &ready}, Order: "id", Dir: "asc", All: true})
		if err != nil {
			continue
		}
		for _, v := range rows {
			if v.LocalPath != nil && *v.LocalPath != "" && exists(*v.LocalPath) {
				s.Transcode.Enqueue(ctx, TranscodeJob{AppName: a.Name, VodID: v.ID, SourcePath: *v.LocalPath, DeleteSourceAfter: true})
				res.Transcodes++
			}
		}
	}
	if res.Uploads+res.Transcodes > 0 {
		write(s.logs, "info", "recording jobs recovered at boot", map[string]any{"uploads": res.Uploads, "transcodes": res.Transcodes})
	}
	return res
}

// RecoverStarter is Recover as a plane starter.
func (s *Service) RecoverStarter(ctx context.Context) { s.Recover(ctx) }
