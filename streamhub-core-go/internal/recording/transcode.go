package recording

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/yamljs"
)

// Port of vod-transcode.service.ts: the VOD post-transcode pipeline. The
// LiveKit egress produces ONE MP4/H.264 per recording; everything else is
// generated here from that local source, best-effort, after the VOD is
// already `ready`:
//
//   - transcoding.vod_adaptive → one HLS rendition per ladder step
//     (hls/<base>/<h>p/index.m3u8 + segments) + hls/<base>/master.m3u8;
//   - transcoding.encoding h264+vp8 → <base>.webm (VP8/Opus);
//   - features.drm → the HLS ladder packaged encrypted (shaka CMAF) instead;
//     while DRM is enforced no clear variant (incl. WebM) may ship.
//
// Jobs run on ONE background worker (ffmpeg is CPU-heavy; BullMQ
// concurrency 1 in Node) started by Start(); before Start every Enqueue runs
// inline, which is Node's queue-unavailable fallback.

// TranscodePlan is what the app config asks for.
type TranscodePlan struct {
	Renditions []contracts.VodRendition `json:"renditions"`
	Webm       bool                     `json:"webm"`
}

// TranscodeJob is enqueued after the source MP4 reached S3.
type TranscodeJob struct {
	AppName    string
	VodID      int64
	SourcePath string
	// DeleteSourceAfter honours recording.delete_local_after_upload (the
	// upload job defers the local delete to this job).
	DeleteSourceAfter bool
}

// TranscodeDeps wires VodTranscode.
type TranscodeDeps struct {
	Apps      contracts.AppsService
	S3        contracts.S3Service
	Vods      *Vods
	Variants  *Variants
	Logs      Logs
	Callbacks Callbacks
	Runner    Runner // nil → ExecRunner
	Drm       *DrmService
	Log       *slog.Logger
}

// VodTranscode is VodTranscodeService.
type VodTranscode struct {
	d      TranscodeDeps
	decide func(ctx context.Context, cfg *contracts.AppConfig, assetID string) DrmDecision
	// packager is PackageDrmHls (test seam).
	packager func(ctx context.Context, job ShakaHlsJob) bool

	mu      sync.Mutex
	started bool
	queue   []TranscodeJob
	pending map[string]bool // jobIds queued or running
	wake    chan struct{}
	exited  chan struct{} // closed when the Start worker returns
}

// NewVodTranscode builds the pipeline.
func NewVodTranscode(d TranscodeDeps) *VodTranscode {
	if d.Runner == nil {
		d.Runner = ExecRunner{}
	}
	if d.Drm == nil {
		d.Drm = NewDrmService(nil, d.Runner, d.Log)
	}
	t := &VodTranscode{d: d, pending: map[string]bool{}, wake: make(chan struct{}, 1)}
	t.decide = d.Drm.Decide
	t.packager = func(ctx context.Context, job ShakaHlsJob) bool { return PackageDrmHls(ctx, d.Runner, job) }
	return t
}

// PlanFor resolves the plan; everything is gated on transcoding.enabled.
func (t *VodTranscode) PlanFor(cfg *contracts.AppConfig) TranscodePlan {
	tc := cfg.Transcoding
	if !tc.Enabled {
		return TranscodePlan{Renditions: []contracts.VodRendition{}}
	}
	p := TranscodePlan{Renditions: []contracts.VodRendition{}, Webm: tc.Encoding == "h264+vp8"}
	if tc.VodAdaptive {
		p.Renditions = ResolveVodRenditions(cfg)
	}
	return p
}

// Needed reports whether any post-transcode work is configured.
func (t *VodTranscode) Needed(cfg *contracts.AppConfig) bool {
	p := t.PlanFor(cfg)
	return len(p.Renditions) > 0 || p.Webm
}

func transcodeJobID(j TranscodeJob) string {
	return fmt.Sprintf("vod-variants-%s-%d", j.AppName, j.VodID)
}

// Enqueue queues a job (deduped by job id while queued/running); before
// Start it processes inline.
func (t *VodTranscode) Enqueue(ctx context.Context, job TranscodeJob) {
	t.mu.Lock()
	if !t.started {
		t.mu.Unlock()
		t.logf("warn", "transcode queue unavailable; processing inline")
		t.ProcessJob(ctx, job)
		return
	}
	id := transcodeJobID(job)
	if t.pending[id] {
		t.mu.Unlock()
		return
	}
	t.pending[id] = true
	t.queue = append(t.queue, job)
	t.mu.Unlock()
	select {
	case t.wake <- struct{}{}:
	default:
	}
	write(t.d.Logs, "info", "vod transcode job enqueued", map[string]any{"appName": job.AppName, "vodId": job.VodID})
}

// Start runs the single worker until ctx is cancelled.
func (t *VodTranscode) Start(ctx context.Context) {
	t.mu.Lock()
	if t.started {
		t.mu.Unlock()
		return
	}
	t.started = true
	t.exited = make(chan struct{})
	t.mu.Unlock()
	go func() {
		defer close(t.exited)
		for {
			t.mu.Lock()
			if len(t.queue) == 0 {
				t.mu.Unlock()
				select {
				case <-ctx.Done():
					return
				case <-t.wake:
					continue
				}
			}
			job := t.queue[0]
			t.queue = t.queue[1:]
			t.mu.Unlock()
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.logf("error", fmt.Sprintf("transcode job %s failed: %v", transcodeJobID(job), r))
					}
				}()
				t.ProcessJob(ctx, job)
			}()
			t.mu.Lock()
			delete(t.pending, transcodeJobID(job))
			t.mu.Unlock()
		}
	}()
}

// Done is closed once the worker started by Start has returned (after ctx is
// cancelled and the in-flight job, if any, finished). Nil before Start.
func (t *VodTranscode) Done() <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.exited
}

func (t *VodTranscode) logf(level, msg string) {
	if t.d.Log == nil {
		return
	}
	switch level {
	case "error":
		t.d.Log.Error(msg)
	case "warn":
		t.d.Log.Warn(msg)
	default:
		t.d.Log.Info(msg)
	}
}

type xcRendition struct {
	contracts.VodRendition
	dir string
}

// ProcessJob runs one transcode (never panics on its own failures; the base
// MP4 VOD is never degraded).
func (t *VodTranscode) ProcessJob(ctx context.Context, job TranscodeJob) {
	app, vodID, src := job.AppName, job.VodID, job.SourcePath
	vod, err := t.d.Vods.FindByID(ctx, app, vodID)
	if err != nil || vod == nil {
		t.logf("warn", fmt.Sprintf("transcode job: vod %d (%s) missing", vodID, app))
		return
	}
	if src == "" || !xcExists(src) {
		sp := src
		if sp == "" {
			sp = "(null)"
		}
		write(t.d.Logs, "error", "transcode source missing", map[string]any{"appName": app, "vodId": vodID, "sourcePath": sp})
		return
	}
	cfg, err := t.d.Apps.GetConfig(ctx, app)
	if err != nil {
		write(t.d.Logs, "error", "transcode config load failed", map[string]any{"appName": app, "vodId": vodID, "error": err.Error()})
		return
	}
	plan := t.PlanFor(cfg)
	base := xcBaseNoExt(src)
	workDir := filepath.Join(t.d.Apps.AppDir(app), "transcode", base)

	defer func() {
		_ = os.RemoveAll(workDir)
		if job.DeleteSourceAfter {
			_ = os.Remove(src)
			_ = t.d.Vods.Update(ctx, app, vodID, (&VodPatch{}).Set("local_path", nil))
		}
	}()
	if err := t.run(ctx, job, cfg, plan, base, workDir); err != nil {
		write(t.d.Logs, "error", "vod transcode failed", map[string]any{"appName": app, "vodId": vodID, "error": err.Error()})
		patch := yamljs.NewMap()
		patch.Set("variantsError", err.Error())
		t.updateMeta(ctx, app, vodID, patch)
	}
}

func (t *VodTranscode) run(ctx context.Context, job TranscodeJob, cfg *contracts.AppConfig, plan TranscodePlan, base, workDir string) error {
	app, vodID, src := job.AppName, job.VodID, job.SourcePath
	if len(plan.Renditions) == 0 && !plan.Webm {
		return nil
	}
	if err := os.MkdirAll(workDir, 0o777); err != nil {
		return err
	}
	media := ProbeMedia(ctx, t.d.Runner, src)

	// --- 0. DRM decision (features.drm — default OFF → clear) ---------------
	decision := t.decide(ctx, cfg, base)
	drmEnforced := decision.Mode == DrmEncrypt || decision.Mode == DrmSkip
	switch decision.Mode {
	case DrmClearDegraded:
		write(t.d.Logs, "warn", "drm degraded to clear packaging (fail_open)", map[string]any{"appName": app, "vodId": vodID, "reason": decision.Reason})
	case DrmSkip:
		write(t.d.Logs, "error", "drm packaging skipped (fail-closed)", map[string]any{"appName": app, "vodId": vodID, "reason": decision.Reason})
		p := yamljs.NewMap()
		p.Set("drmError", decision.Reason)
		t.updateMeta(ctx, app, vodID, p)
	}

	// --- 1. HLS ladder --------------------------------------------------------
	var masterKey *string
	var drmSummary *yamljs.Map
	if len(plan.Renditions) > 0 && decision.Mode == DrmEncrypt {
		mk, summary, err := t.packageDrm(ctx, app, vodID, cfg, base, src, workDir, plan.Renditions, decision.Ctx)
		if err != nil {
			return err
		}
		if mk != "" {
			masterKey, drmSummary = &mk, summary
		}
	}
	clearHls := len(plan.Renditions) > 0 && (decision.Mode == DrmClear || decision.Mode == DrmClearDegraded)
	var ok []xcRendition
	if clearHls {
		for _, r := range plan.Renditions {
			dir := filepath.Join(workDir, xcNum(r.Height)+"p")
			if !TranscodeHlsRendition(ctx, t.d.Runner, src, dir, r, 4) || !xcExists(filepath.Join(dir, "index.m3u8")) {
				write(t.d.Logs, "warn", "hls rendition failed", map[string]any{"appName": app, "vodId": vodID, "height": r.Height})
				continue
			}
			ok = append(ok, xcRendition{r, dir})
		}
	}
	for _, r := range ok {
		entries, err := os.ReadDir(r.dir)
		if err != nil {
			return err
		}
		var files []string
		for _, e := range entries {
			if n := e.Name(); strings.HasSuffix(n, ".m3u8") || strings.HasSuffix(n, ".ts") {
				files = append(files, n)
			}
		}
		sort.Strings(files)
		prefix := "hls/" + base + "/" + xcNum(r.Height) + "p/"
		playlistKey := prefix + "index.m3u8"
		segmentKeys := []any{}
		var size float64
		for _, f := range files {
			key := prefix + f
			up, err := t.d.S3.Upload(ctx, cfg.S3, filepath.Join(r.dir, f), key, HlsContentType(f))
			if err != nil {
				return err
			}
			size += float64(up.SizeBytes)
			if key != playlistKey {
				segmentKeys = append(segmentKeys, key)
			}
		}
		extra := yamljs.NewMap()
		extra.Set("segmentKeys", segmentKeys)
		h, b := r.Height, r.BitrateKbps
		if _, err := t.d.Variants.Insert(ctx, app, VariantInsert{
			VodID: vodID, Kind: "rendition", Format: "hls-h264", Height: &h, BitrateKbps: &b,
			FileKey: &playlistKey, SizeBytes: &size, ExtraJSON: xcStringify(extra),
		}); err != nil {
			return err
		}
	}
	if len(ok) > 0 {
		entries := make([]MasterPlaylistEntry, len(ok))
		for i, r := range ok {
			w := WidthForHeight(r.Height, media.Width, media.Height)
			entries[i] = MasterPlaylistEntry{URI: xcNum(r.Height) + "p/index.m3u8", Height: r.Height, BitrateKbps: r.BitrateKbps, Width: &w}
		}
		masterLocal := filepath.Join(workDir, "master.m3u8")
		if err := os.WriteFile(masterLocal, []byte(BuildMasterPlaylist(entries)), 0o644); err != nil {
			return err
		}
		mk := "hls/" + base + "/master.m3u8"
		masterKey = &mk
		up, err := t.d.S3.Upload(ctx, cfg.S3, masterLocal, mk, "application/vnd.apple.mpegurl")
		if err != nil {
			return err
		}
		size := float64(up.SizeBytes)
		if _, err := t.d.Variants.Insert(ctx, app, VariantInsert{VodID: vodID, Kind: "master", Format: "hls", FileKey: &mk, SizeBytes: &size}); err != nil {
			return err
		}
	}

	// --- 2. WebM/VP8 alternate -------------------------------------------------
	var webmKey *string
	if plan.Webm && drmEnforced {
		write(t.d.Logs, "info", "webm alternate skipped (drm enabled — no clear variant may ship)", map[string]any{"appName": app, "vodId": vodID})
	}
	if plan.Webm && !drmEnforced {
		webmLocal := filepath.Join(workDir, base+".webm")
		kbps := 2500.0
		switch {
		case len(ok) > 0:
			kbps = ok[0].BitrateKbps
		case media.Height != nil && *media.Height != 0:
			kbps = BitrateForHeight(*media.Height)
		}
		if TranscodeWebmVp8(ctx, t.d.Runner, src, webmLocal, kbps) && xcExists(webmLocal) {
			wk := base + ".webm"
			webmKey = &wk
			up, err := t.d.S3.Upload(ctx, cfg.S3, webmLocal, wk, "video/webm")
			if err != nil {
				return err
			}
			size := float64(up.SizeBytes)
			if _, err := t.d.Variants.Insert(ctx, app, VariantInsert{
				VodID: vodID, Kind: "alternate", Format: "webm-vp8", Height: media.Height, BitrateKbps: &kbps, FileKey: &wk, SizeBytes: &size,
			}); err != nil {
				return err
			}
		} else {
			write(t.d.Logs, "warn", "webm/vp8 transcode failed", map[string]any{"appName": app, "vodId": vodID})
		}
	}

	// --- 3. bookkeeping + callback ---------------------------------------------
	list, err := t.d.Variants.ListByVod(ctx, app, vodID)
	if err != nil {
		return err
	}
	if len(list) == 0 {
		write(t.d.Logs, "error", "vod transcode produced no variants", map[string]any{"appName": app, "vodId": vodID})
		return nil
	}
	patch := yamljs.NewMap()
	if masterKey != nil {
		patch.Set("hlsMasterKey", *masterKey)
	} else {
		patch.Set("hlsMasterKey", yamljs.Undefined) // `masterKey ?? undefined` drops the key
	}
	patch.Set("variantCount", float64(len(list)))
	if drmSummary != nil {
		patch.Set("drm", drmSummary)
	}
	t.updateMeta(ctx, app, vodID, patch)
	meta := map[string]any{"appName": app, "vodId": vodID, "masterKey": masterKey, "webmKey": webmKey, "variants": len(list)}
	if drmSummary != nil {
		meta["drm"] = drmSummary
	}
	write(t.d.Logs, "info", "vod variants ready", meta)
	t.dispatchVariantsReady(ctx, app, vodID, masterKey, webmKey, list, drmSummary)
	return nil
}

// packageDrm is the encrypted replacement of the clear ladder. A failure is
// logged + recorded (drmError) and yields masterKey "" (never a clear
// fallback); a non-nil error is an S3/DB exception (the outer catch).
func (t *VodTranscode) packageDrm(ctx context.Context, app string, vodID int64, cfg *contracts.AppConfig, base, src, workDir string,
	renditions []contracts.VodRendition, pc *DrmPackagingContext) (string, *yamljs.Map, error) {
	fail := func(reason string) (string, *yamljs.Map, error) {
		write(t.d.Logs, "error", "drm packaging failed", map[string]any{"appName": app, "vodId": vodID, "reason": reason})
		p := yamljs.NewMap()
		p.Set("drmError", reason)
		t.updateMeta(ctx, app, vodID, p)
		return "", nil, nil
	}
	mezzDir, outDir := filepath.Join(workDir, "drm-mezz"), filepath.Join(workDir, "drm-hls")
	type mezz struct {
		contracts.VodRendition
		mp4 string
	}
	var ms []mezz
	for _, r := range renditions {
		mp4 := filepath.Join(mezzDir, xcNum(r.Height)+"p.mp4")
		if !TranscodeRenditionMp4(ctx, t.d.Runner, src, mp4, r) {
			write(t.d.Logs, "warn", "drm mezzanine rendition failed", map[string]any{"appName": app, "vodId": vodID, "height": r.Height})
			continue
		}
		ms = append(ms, mezz{r, mp4})
	}
	if len(ms) == 0 {
		return fail("no mezzanine rendition could be transcoded")
	}
	job := ShakaHlsJob{AudioSourcePath: src, OutDir: outDir, SegmentSeconds: 4, KeyArgs: pc.KeyArgs}
	for _, m := range ms {
		job.Renditions = append(job.Renditions, ShakaRendition{Height: m.Height, MP4: m.mp4})
	}
	if !t.packager(ctx, job) {
		return fail("shaka-packager run failed")
	}
	entries, err := os.ReadDir(outDir)
	if err != nil {
		return "", nil, err
	}
	var files []string
	for _, e := range entries {
		if n := e.Name(); strings.HasSuffix(n, ".m3u8") || strings.HasSuffix(n, ".mp4") || strings.HasSuffix(n, ".m4s") {
			files = append(files, n)
		}
	}
	sort.Strings(files)
	sizeByFile := map[string]float64{}
	has := map[string]bool{}
	for _, f := range files {
		up, err := t.d.S3.Upload(ctx, cfg.S3, filepath.Join(outDir, f), "hls/"+base+"/"+f, HlsContentType(f))
		if err != nil {
			return "", nil, err
		}
		sizeByFile[f] = float64(up.SizeBytes)
		has[f] = true
	}
	keyIDs := make([]any, len(pc.Keys.Keys))
	for i, k := range pc.Keys.Keys {
		keyIDs[i] = k.KeyID
	}
	for _, m := range ms {
		h := xcNum(m.Height)
		if !has[h+"p.m3u8"] {
			continue
		}
		extra := yamljs.NewMap()
		extra.Set("segmentKeys", []any{"hls/" + base + "/" + h + "p.mp4"})
		extra.Set("drm", true)
		height, br := m.Height, m.BitrateKbps
		key := "hls/" + base + "/" + h + "p.m3u8"
		size := sizeByFile[h+"p.m3u8"] + sizeByFile[h+"p.mp4"]
		if _, err := t.d.Variants.Insert(ctx, app, VariantInsert{
			VodID: vodID, Kind: "rendition", Format: "hls-cmaf-" + pc.Scheme, Height: &height, BitrateKbps: &br,
			FileKey: &key, SizeBytes: &size, ExtraJSON: xcStringify(extra),
		}); err != nil {
			return "", nil, err
		}
	}
	masterKey := "hls/" + base + "/master.m3u8"
	summary := yamljs.NewMap()
	summary.Set("scheme", pc.Scheme)
	systems := make([]any, len(pc.Systems))
	for i, s := range pc.Systems {
		systems[i] = s
	}
	summary.Set("systems", systems)
	summary.Set("keyIds", keyIDs)
	summary.Set("licenseUrls", pc.LicenseURLs.toMap())
	if pc.HlsKeyURI != "" {
		summary.Set("hlsKeyUri", pc.HlsKeyURI)
	}
	extra := summary.Clone()
	audio := []any{}
	for _, f := range files {
		if strings.HasPrefix(f, "audio.") {
			audio = append(audio, "hls/"+base+"/"+f)
		}
	}
	extra.Set("audioKeys", audio)
	size := sizeByFile["master.m3u8"]
	if _, err := t.d.Variants.Insert(ctx, app, VariantInsert{
		VodID: vodID, Kind: "master", Format: "hls-drm", FileKey: &masterKey, SizeBytes: &size, ExtraJSON: xcStringify(extra),
	}); err != nil {
		return "", nil, err
	}
	return masterKey, summary, nil
}

// xcVariantView is one entry of the vod_variants_ready payload.
type xcVariantView struct {
	Kind        string   `json:"kind"`
	Format      string   `json:"format"`
	Height      *float64 `json:"height"`
	BitrateKbps *float64 `json:"bitrateKbps"`
	Key         *string  `json:"key"`
	SizeBytes   *float64 `json:"sizeBytes"`
}

// variantsReadyPayload keeps Node's key order.
type variantsReadyPayload struct {
	VodID     int64           `json:"vodId"`
	App       string          `json:"app"`
	Room      *string         `json:"room"`
	StreamID  *string         `json:"streamId"`
	MasterKey *string         `json:"masterKey"`
	WebmKey   *string         `json:"webmKey"`
	Drm       *yamljs.Map     `json:"drm,omitempty"`
	Variants  []xcVariantView `json:"variants"`
}

func (t *VodTranscode) dispatchVariantsReady(ctx context.Context, app string, vodID int64, masterKey, webmKey *string, list []VariantRecord, drm *yamljs.Map) {
	if t.d.Callbacks == nil {
		return
	}
	vod, _ := t.d.Vods.FindByID(ctx, app, vodID)
	p := variantsReadyPayload{VodID: vodID, App: app, MasterKey: masterKey, WebmKey: webmKey, Drm: drm, Variants: []xcVariantView{}}
	if vod != nil {
		p.Room, p.StreamID = vod.Room, vod.StreamID
	}
	for _, v := range list {
		p.Variants = append(p.Variants, xcVariantView{v.Kind, v.Format, v.Height, v.BitrateKbps, v.FileKey, v.SizeBytes})
	}
	if err := t.d.Callbacks.Dispatch(ctx, app, "vod_variants_ready", p); err != nil {
		t.logf("warn", "callback vod_variants_ready failed: "+err.Error())
	}
}

// updateMeta merges patch into metatags_json ({...meta, ...patch}; an
// Undefined patch value drops the key from the output). Best-effort.
func (t *VodTranscode) updateMeta(ctx context.Context, app string, vodID int64, patch *yamljs.Map) {
	vod, err := t.d.Vods.FindByID(ctx, app, vodID)
	if err != nil || vod == nil {
		return
	}
	meta := yamljs.NewMap()
	if vod.MetatagsJSON != nil {
		if v, err := yamljs.ParseJSON([]byte(*vod.MetatagsJSON)); err == nil {
			switch x := v.(type) {
			case *yamljs.Map:
				meta = x
			case []any:
				for i, e := range x {
					meta.Set(strconv.Itoa(i), e)
				}
			}
		}
	}
	for _, k := range patch.Keys() {
		meta.Set(k, patch.Get(k))
	}
	if s := xcStringify(meta); s != nil {
		if err := t.d.Vods.Update(ctx, app, vodID, (&VodPatch{}).Set("metatags_json", *s)); err != nil {
			t.logf("warn", "metatags update failed: "+err.Error())
		}
	}
}

// stringify is JSON.stringify of a value-model tree.
func xcStringify(v any) *string {
	s, err := yamljs.Stringify(v)
	if err != nil {
		return nil
	}
	return &s
}

// basenameNoExt is path.basename(p, path.extname(p)).
func xcBaseNoExt(p string) string {
	b := filepath.Base(p)
	if ext := xcExtname(b); ext != "" {
		return strings.TrimSuffix(b, ext)
	}
	return b
}

// nodeExtname is path.extname over a basename: the last '.' that is not the
// first character ("" for ".bashrc" / "name").
func xcExtname(base string) string {
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return base[i:]
}
