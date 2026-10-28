package recording

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/contracts"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/httpx"
	"github.com/streamhubstudio/streamhub/streamhub-core-go/internal/platform/jsx"
)

// VOD listing, detail, download, probe and delete (the controller-facing half
// of recording.service.ts).

// ListQuery is the validated ListVodsDto.
type ListQuery struct {
	VodFilters
	Order, Dir    string
	All           bool
	Limit, Offset *float64
}

// VodPage is the paginated listing.
type VodPage struct {
	Data   []VodRecord
	Total  int64
	Limit  int64
	Offset int64
}

func clampInt(raw *float64, fallback, lo, hi float64) int64 {
	if raw == nil || math.IsNaN(*raw) {
		return int64(fallback)
	}
	return int64(math.Min(math.Max(math.Floor(*raw), lo), hi))
}

// ListVods lists with filters/ordering/paging + the filtered total.
func (s *Service) ListVods(ctx context.Context, app string, q ListQuery) (*VodPage, error) {
	limit := clampInt(q.Limit, 200, 1, 1000)
	offset := clampInt(q.Offset, 0, 0, 9007199254740991)
	data, err := s.vods.List(ctx, app, VodListOptions{VodFilters: q.VodFilters, Order: q.Order, Dir: q.Dir, All: q.All, Limit: limit, Offset: offset})
	if err != nil {
		return nil, err
	}
	total, err := s.vods.Count(ctx, app, q.VodFilters)
	if err != nil {
		return nil, err
	}
	if q.All {
		limit, offset = int64(len(data)), 0
	}
	return &VodPage{data, total, limit, offset}, nil
}

// ListVodIDs implements dbadmin.VodDeleter (listVods(app,{limit,offset})).
func (s *Service) ListVodIDs(ctx context.Context, app string, limit, offset int) ([]int64, error) {
	l, o := float64(limit), float64(offset)
	page, err := s.ListVods(ctx, app, ListQuery{Limit: &l, Offset: &o})
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(page.Data))
	for _, v := range page.Data {
		ids = append(ids, v.ID)
	}
	return ids, nil
}

// Download is a resolved VOD download (S3 presigned or local /raw).
type Download struct {
	Source           string // s3 | local
	URL              string
	Filename         string
	ExpiresInSeconds int64
}

func notFoundVod(id int64) error { return httpx.NotFound(fmt.Sprintf("vod %d not found", id)) }

func notReady(v *VodRecord) error {
	return httpx.Conflict(fmt.Sprintf("vod %d is not ready (status: %s)", v.ID, v.Status))
}

// GetDownload resolves GET /vods/:id/download.
func (s *Service) GetDownload(ctx context.Context, app string, id int64) (*Download, error) {
	vod, err := s.vods.FindByID(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, notFoundVod(id)
	}
	if vod.Status != "ready" {
		return nil, notReady(vod)
	}
	name := downloadFilename(vod, id)
	if vod.FileKey != nil && *vod.FileKey != "" {
		cfg, err := s.loadConfig(ctx, app)
		if err != nil {
			return nil, err
		}
		url, err := s.s3.PresignGet(ctx, cfg.S3, *vod.FileKey, downloadTTL, &contracts.S3PresignOptions{
			ResponseContentDisposition: `attachment; filename="` + name + `"`,
		})
		if err != nil {
			return nil, err
		}
		return &Download{"s3", url, name, downloadTTL}, nil
	}
	if vod.LocalPath != nil && *vod.LocalPath != "" && exists(*vod.LocalPath) {
		return &Download{Source: "local", Filename: name}, nil
	}
	return nil, httpx.NotFound(fmt.Sprintf("vod %d has no downloadable file (no S3 object and no local recording present)", id))
}

// RawFile is the descriptor of GET /vods/:id/raw.
type RawFile struct {
	LocalPath, Filename, ContentType string
}

// OpenLocalRaw resolves GET /vods/:id/raw.
func (s *Service) OpenLocalRaw(ctx context.Context, app string, id int64) (*RawFile, error) {
	vod, err := s.vods.FindByID(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, notFoundVod(id)
	}
	if vod.Status != "ready" {
		return nil, notReady(vod)
	}
	if vod.LocalPath == nil || *vod.LocalPath == "" || !exists(*vod.LocalPath) {
		return nil, httpx.NotFound(fmt.Sprintf("vod %d has no local file to stream", id))
	}
	return &RawFile{*vod.LocalPath, downloadFilename(vod, id), rawContentType(*vod.LocalPath)}, nil
}

var (
	extTail   = regexp.MustCompile(`\.[^./\\]+$`)
	badChars  = regexp.MustCompile(`[\\/"'\r\n\t]+`)
	nonWord   = regexp.MustCompile(`[^\w.\-]+`)
	edgeDotsD = regexp.MustCompile(`^[-.]+|[-.]+$`)
)

// downloadFilename is `<name|room>-<id>.<ext>`, sanitized.
func downloadFilename(v *VodRecord, id int64) string {
	stem := jsTrim(v.Name)
	if stem == "" && v.Room != nil {
		stem = jsTrim(*v.Room)
	}
	if stem == "" {
		stem = "vod"
	}
	stem = extTail.ReplaceAllString(stem, "")
	ext := ""
	if v.Name != "" {
		ext = strings.TrimPrefix(nodeExtname(v.Name), ".")
	}
	if ext == "" && v.Format != nil {
		ext = *v.Format
	}
	if ext == "" {
		ext = "mp4"
	}
	return sanitizeFilename(fmt.Sprintf("%s-%d.%s", stem, id, strings.ToLower(ext)))
}

func sanitizeFilename(name string) string {
	out := badChars.ReplaceAllString(name, "_")
	out = nonWord.ReplaceAllString(out, "-")
	out = edgeDotsD.ReplaceAllString(out, "")
	if out == "" {
		return "vod"
	}
	return out
}

func rawContentType(p string) string {
	switch strings.ToLower(nodeExtname(p)) {
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	}
	return "application/octet-stream"
}

// VariantView is one variant of GET /vods/:id.
type VariantView struct {
	ID          int64    `json:"id"`
	Kind        string   `json:"kind"`
	Format      string   `json:"format"`
	Height      *float64 `json:"height"`
	BitrateKbps *float64 `json:"bitrateKbps"`
	Key         *string  `json:"key"`
	SizeBytes   *float64 `json:"sizeBytes"`
	URL         *string  `json:"url"`
}

// Adaptive is the HLS master entry point.
type VodAdaptive struct {
	MasterKey string  `json:"masterKey"`
	MasterURL *string `json:"masterUrl"`
}

// VodDetail is GET /vods/:id.
type VodDetail struct {
	VodRecord
	URL          *string       `json:"url"`
	PresignedURL *string       `json:"presignedUrl"`
	PublicURLOut *string       `json:"-"`
	VodAdaptive  *VodAdaptive  `json:"adaptive"`
	Variants     []VariantView `json:"variants"`
}

// MarshalJSON keeps the record's own publicUrl column replaced by the
// computed one ({...vod, url, presignedUrl, publicUrl, …} in Node).
func (d VodDetail) MarshalJSON() ([]byte, error) {
	rec := d.VodRecord
	rec.PublicURL = d.PublicURLOut
	type alias struct {
		VodRecord
		URL          *string       `json:"url"`
		PresignedURL *string       `json:"presignedUrl"`
		VodAdaptive  *VodAdaptive  `json:"adaptive"`
		Variants     []VariantView `json:"variants"`
	}
	return json.Marshal(alias{rec, d.URL, d.PresignedURL, d.VodAdaptive, d.Variants})
}

// GetVod is the VOD detail with playback URLs + variants.
func (s *Service) GetVod(ctx context.Context, app string, id int64) (*VodDetail, error) {
	vod, err := s.vods.FindByID(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, notFoundVod(id)
	}
	rows, err := s.variants.ListByVod(ctx, app, id)
	if err != nil {
		return nil, err
	}
	hasKey := vod.FileKey != nil && *vod.FileKey != ""
	var cfg *contracts.AppConfig
	if vod.Status == "ready" && (hasKey || len(rows) > 0) {
		if c, err := s.loadConfig(ctx, app); err == nil {
			cfg = c
		} else {
			s.warn("config load failed: " + err.Error())
		}
	}
	var presigned, public *string
	if cfg != nil && hasKey && vod.Status == "ready" {
		if cfg.S3.PublicURL != "" {
			u := joinPublicURL(cfg.S3.PublicURL, *vod.FileKey)
			public = &u
		}
		if u, err := s.s3.PresignGet(ctx, cfg.S3, *vod.FileKey, presignTTL, nil); err == nil {
			presigned = &u
		} else {
			s.warn("presign failed: " + err.Error())
		}
	}
	url := public
	if url == nil {
		url = presigned
	}
	views := []VariantView{}
	for _, v := range rows {
		views = append(views, VariantView{v.ID, v.Kind, v.Format, v.Height, v.BitrateKbps, v.FileKey, v.SizeBytes,
			s.variantURL(ctx, cfg, v.Kind, v.FileKey)})
	}
	var adaptive *VodAdaptive
	for _, v := range views {
		if v.Kind == "master" && v.Key != nil && *v.Key != "" {
			adaptive = &VodAdaptive{*v.Key, v.URL}
			break
		}
	}
	return &VodDetail{VodRecord: *vod, URL: url, PresignedURL: presigned, PublicURLOut: public, VodAdaptive: adaptive, Variants: views}, nil
}

func (s *Service) variantURL(ctx context.Context, cfg *contracts.AppConfig, kind string, key *string) *string {
	if cfg == nil || key == nil || *key == "" {
		return nil
	}
	if cfg.S3.PublicURL != "" {
		u := joinPublicURL(cfg.S3.PublicURL, *key)
		return &u
	}
	if kind == "rendition" {
		return nil
	}
	u, err := s.s3.PresignGet(ctx, cfg.S3, *key, presignTTL, nil)
	if err != nil {
		s.warn("variant presign failed: " + err.Error())
		return nil
	}
	return &u
}

func joinPublicURL(base, key string) string {
	segs := strings.Split(strings.TrimLeft(key, "/"), "/")
	for i, seg := range segs {
		segs[i] = jsx.EncodeURIComponent(seg)
	}
	return strings.TrimRight(base, "/") + "/" + strings.Join(segs, "/")
}

// ProbedVod is POST /vods/:id/probe.data.
type ProbedVod struct {
	VodRecord
	Probed bool `json:"probed"`
}

// ProbeVod backfills duration/dimensions/format with ffprobe.
func (s *Service) ProbeVod(ctx context.Context, app string, id int64) (*ProbedVod, error) {
	vod, err := s.vods.FindByID(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, notFoundVod(id)
	}
	source := ""
	if vod.LocalPath != nil && *vod.LocalPath != "" && exists(*vod.LocalPath) {
		source = *vod.LocalPath
	} else if vod.FileKey != nil && *vod.FileKey != "" {
		if cfg, err := s.loadConfig(ctx, app); err == nil {
			if u, err := s.s3.PresignGet(ctx, cfg.S3, *vod.FileKey, 600, nil); err == nil {
				source = u
			} else {
				s.warn("probe presign failed: " + err.Error())
			}
		} else {
			s.warn("probe presign failed: " + err.Error())
		}
	}
	if source == "" {
		return nil, httpx.NotFound(fmt.Sprintf("vod %d has no media to probe (no local file and no S3 object)", id))
	}
	m := ProbeMedia(ctx, s.runner, source)
	p := &VodPatch{}
	if m.DurationS != nil {
		p.Set("duration_s", *m.DurationS)
	}
	if m.Width != nil {
		p.Set("width", *m.Width)
	}
	if m.Height != nil {
		p.Set("height", *m.Height)
	}
	if m.Format != nil && (vod.Format == nil || *vod.Format == "") {
		p.Set("format", *m.Format)
	}
	probed := !p.Empty()
	if probed {
		if err := s.vods.Update(ctx, app, id, p); err != nil {
			return nil, err
		}
		write(s.logs, "info", "vod probed", map[string]any{"appName": app, "vodId": id,
			"durationS": nullNum(m.DurationS), "width": nullNum(m.Width), "height": nullNum(m.Height)})
	}
	updated, _ := s.vods.FindByID(ctx, app, id)
	if updated == nil {
		updated = vod
	}
	return &ProbedVod{*updated, probed}, nil
}

// DeleteResult is DELETE /vods/:id (minus the id).
type DeleteResult struct {
	S3Deleted    int64
	LocalDeleted bool
}

// DeleteVod cascades: S3 objects (best-effort) → local files → DB rows.
func (s *Service) DeleteVodCascade(ctx context.Context, app string, id int64) (*DeleteResult, error) {
	vod, err := s.vods.FindByID(ctx, app, id)
	if err != nil {
		return nil, err
	}
	if vod == nil {
		return nil, notFoundVod(id)
	}
	cfg, err := s.loadConfig(ctx, app)
	if err != nil {
		s.warn("config load on delete failed: " + err.Error())
		cfg = nil
	}
	var s3Deleted int64
	if cfg != nil {
		var keys []string
		for _, k := range []*string{vod.FileKey, vod.SnapshotKey} {
			if k != nil && *k != "" {
				keys = append(keys, *k)
			}
		}
		vars, _ := s.variants.ListByVod(ctx, app, id)
		for _, v := range vars {
			if v.FileKey != nil && *v.FileKey != "" {
				keys = append(keys, *v.FileKey)
			}
			keys = append(keys, variantExtraKeys(v.ExtraJSON)...)
		}
		for _, k := range keys {
			if err := s.s3.Delete(ctx, cfg.S3, k); err != nil {
				s.warn(fmt.Sprintf("s3 delete %s failed: %s", k, err))
				continue
			}
			s3Deleted++
		}
	}
	local := s.removeLocalCascade(app, vod.LocalPath)
	if err := s.variants.DeleteByVod(ctx, app, id); err != nil {
		return nil, err
	}
	if err := s.vods.Delete(ctx, app, id); err != nil {
		return nil, err
	}
	write(s.logs, "info", "vod deleted", map[string]any{"appName": app, "vodId": id, "s3Deleted": s3Deleted, "localDeleted": local})
	return &DeleteResult{s3Deleted, local}, nil
}

// DeleteVod implements dbadmin.VodDeleter.
func (s *Service) DeleteVod(ctx context.Context, app string, id int64) (int64, bool, error) {
	r, err := s.DeleteVodCascade(ctx, app, id)
	if err != nil {
		return 0, false, err
	}
	return r.S3Deleted, r.LocalDeleted, nil
}

func variantExtraKeys(raw *string) []string {
	if raw == nil || *raw == "" {
		return nil
	}
	var v struct {
		SegmentKeys []any `json:"segmentKeys"`
	}
	if json.Unmarshal([]byte(*raw), &v) != nil {
		return nil
	}
	var out []string
	for _, k := range v.SegmentKeys {
		if s, ok := k.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func (s *Service) removeLocalCascade(app string, local *string) bool {
	if local == nil || *local == "" {
		return false
	}
	removed := false
	if exists(*local) {
		s.removeLocal(*local)
		removed = true
	}
	base := strings.TrimSuffix(filepath.Base(*local), nodeExtname(*local))
	snap := filepath.Join(s.apps.AppDir(app), "snapshots", base+".jpg")
	if exists(snap) {
		s.removeLocal(snap)
		removed = true
	}
	return removed
}
