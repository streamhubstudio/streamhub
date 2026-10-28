package recording

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strings"
)

// Port of vods.repository.ts + vod-variants.repository.ts: the per-app
// `vods` and `vod_variants` tables (apps/<app>/app.db).

// VodStatus is recording | uploading | ready | failed.
type VodStatus = string

// VodRecord is the contract VodRecord (camelCase, nullable columns as null).
type VodRecord struct {
	ID           int64    `json:"id"`
	AppID        int64    `json:"appId"`
	StreamID     *string  `json:"streamId"`
	Room         *string  `json:"room"`
	Name         string   `json:"name"`
	FileKey      *string  `json:"fileKey"`
	S3URL        *string  `json:"s3Url"`
	PublicURL    *string  `json:"publicUrl"`
	SizeBytes    *float64 `json:"sizeBytes"`
	DurationS    *float64 `json:"durationS"`
	Width        *float64 `json:"width"`
	Height       *float64 `json:"height"`
	Format       *string  `json:"format"`
	Status       string   `json:"status"`
	LocalPath    *string  `json:"localPath"`
	StartedAt    *string  `json:"startedAt"`
	EndedAt      *string  `json:"endedAt"`
	MetatagsJSON *string  `json:"metatagsJson"`
	SnapshotKey  *string  `json:"snapshotKey"`
}

// VodInsert is a new `recording` row.
type VodInsert struct {
	AppID        int64
	StreamID     *string
	Room         *string
	Name         string
	Status       string
	LocalPath    *string
	StartedAt    *string
	MetatagsJSON *string
}

// VodPatch is a partial update: only Set columns are written (nil values
// write NULL, like Node's `patch[k] ?? null`). Column order = PATCH_COLUMNS
// insertion order of the caller's object keys is irrelevant to the result.
type VodPatch struct {
	cols []string
	vals []any
}

// Set adds column = value (value nil → NULL).
func (p *VodPatch) Set(col string, value any) *VodPatch {
	p.cols = append(p.cols, col)
	p.vals = append(p.vals, value)
	return p
}

// Empty reports a no-op patch.
func (p *VodPatch) Empty() bool { return len(p.cols) == 0 }

// VodFilters filter list/count (nil = no filter).
type VodFilters struct {
	Room, Status, Since, Until *string
}

// VodListOptions page/sort a listing.
type VodListOptions struct {
	VodFilters
	Order, Dir string // started_at|size_bytes|id ; asc|desc
	All        bool
	Limit      int64
	Offset     int64
}

// AppDBFunc opens an app database (db.Service.App).
type AppDBFunc func(ctx context.Context, app string) (*sql.DB, error)

// Vods is the vods table repository.
type Vods struct{ appDB AppDBFunc }

// NewVods builds the repository.
func NewVods(appDB AppDBFunc) *Vods { return &Vods{appDB: appDB} }

const vodCols = `id, app_id, stream_id, room, name, file_key, s3_url, public_url, size_bytes, duration_s, width, height, format, status, local_path, started_at, ended_at, metatags_json, snapshot_key`

func scanVod(sc interface{ Scan(...any) error }) (*VodRecord, error) {
	var v VodRecord
	var sid, room, fk, s3u, pu, fmtS, lp, sa, ea, mj, sk sql.NullString
	var size, dur, w, h sql.NullFloat64
	if err := sc.Scan(&v.ID, &v.AppID, &sid, &room, &v.Name, &fk, &s3u, &pu, &size, &dur, &w, &h, &fmtS, &v.Status, &lp, &sa, &ea, &mj, &sk); err != nil {
		return nil, err
	}
	v.StreamID, v.Room, v.FileKey, v.S3URL, v.PublicURL = ns(sid), ns(room), ns(fk), ns(s3u), ns(pu)
	v.SizeBytes, v.DurationS, v.Width, v.Height = nf(size), nf(dur), nf(w), nf(h)
	v.Format, v.LocalPath, v.StartedAt, v.EndedAt, v.MetatagsJSON, v.SnapshotKey = ns(fmtS), ns(lp), ns(sa), ns(ea), ns(mj), ns(sk)
	return &v, nil
}

func ns(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func nf(f sql.NullFloat64) *float64 {
	if !f.Valid {
		return nil
	}
	return &f.Float64
}

// Insert adds a row and returns its id.
func (r *Vods) Insert(ctx context.Context, app string, v VodInsert) (int64, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return 0, err
	}
	res, err := h.ExecContext(ctx, `INSERT INTO vods
         (app_id, stream_id, room, name, status, local_path, started_at, metatags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, v.AppID, v.StreamID, v.Room, v.Name, v.Status, v.LocalPath, v.StartedAt, v.MetatagsJSON)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// Update applies a partial patch (no-op when empty).
func (r *Vods) Update(ctx context.Context, app string, id int64, p *VodPatch) error {
	if p == nil || p.Empty() {
		return nil
	}
	h, err := r.appDB(ctx, app)
	if err != nil {
		return err
	}
	set := make([]string, len(p.cols))
	for i, c := range p.cols {
		set[i] = c + " = ?"
	}
	_, err = h.ExecContext(ctx, `UPDATE vods SET `+strings.Join(set, ", ")+` WHERE id = ?`, append(append([]any{}, p.vals...), id)...)
	return err
}

func (r *Vods) one(ctx context.Context, app, q string, args ...any) (*VodRecord, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	v, err := scanVod(h.QueryRowContext(ctx, q, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return v, err
}

// FindByID returns the row or nil.
func (r *Vods) FindByID(ctx context.Context, app string, id int64) (*VodRecord, error) {
	return r.one(ctx, app, `SELECT `+vodCols+` FROM vods WHERE id = ?`, id)
}

// FindByEgressID is the newest row whose metatags.egressId matches.
func (r *Vods) FindByEgressID(ctx context.Context, app, egressID string) (*VodRecord, error) {
	return r.one(ctx, app, `SELECT `+vodCols+` FROM vods
           WHERE json_extract(metatags_json, '$.egressId') = ?
           ORDER BY id DESC LIMIT 1`, egressID)
}

// FindActiveByStream is the newest recording/uploading row of a stream.
func (r *Vods) FindActiveByStream(ctx context.Context, app, streamID string) (*VodRecord, error) {
	return r.one(ctx, app, `SELECT `+vodCols+` FROM vods
           WHERE stream_id = ? AND status IN ('recording', 'uploading')
           ORDER BY id DESC LIMIT 1`, streamID)
}

func buildWhere(f VodFilters) (string, []any) {
	var clauses []string
	var params []any
	add := func(clause string, v *string) {
		if v != nil {
			clauses = append(clauses, clause)
			params = append(params, *v)
		}
	}
	add("room = ?", f.Room)
	add("status = ?", f.Status)
	add("started_at >= ?", f.Since)
	add("started_at <= ?", f.Until)
	if len(clauses) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), params
}

// List returns a filtered, ordered page (or everything with All).
func (r *Vods) List(ctx context.Context, app string, o VodListOptions) ([]VodRecord, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	where, params := buildWhere(o.VodFilters)
	column := "id"
	switch o.Order {
	case "started_at", "size_bytes":
		column = o.Order
	}
	dir := "DESC"
	if o.Dir == "asc" {
		dir = "ASC"
	}
	order := "ORDER BY id " + dir
	if column != "id" {
		order = "ORDER BY " + column + " " + dir + ", id " + dir
	}
	q := `SELECT ` + vodCols + ` FROM vods` + where + ` ` + order
	if !o.All {
		q += ` LIMIT ? OFFSET ?`
		params = append(params, o.Limit, o.Offset)
	}
	rows, err := h.QueryContext(ctx, q, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []VodRecord{}
	for rows.Next() {
		v, err := scanVod(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

// Count is the filtered row count.
func (r *Vods) Count(ctx context.Context, app string, f VodFilters) (int64, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return 0, err
	}
	where, params := buildWhere(f)
	var n int64
	err = h.QueryRowContext(ctx, `SELECT COUNT(*) AS n FROM vods`+where, params...).Scan(&n)
	return n, err
}

// ByStatus is countByStatus (all four keys, fixed order).
type VodsByStatus struct {
	Recording int64 `json:"recording"`
	Uploading int64 `json:"uploading"`
	Ready     int64 `json:"ready"`
	Failed    int64 `json:"failed"`
}

// CountByStatus groups rows by status.
func (r *Vods) CountByStatus(ctx context.Context, app string) (VodsByStatus, error) {
	var out VodsByStatus
	h, err := r.appDB(ctx, app)
	if err != nil {
		return out, err
	}
	rows, err := h.QueryContext(ctx, `SELECT status, COUNT(*) AS n FROM vods GROUP BY status`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var n int64
		if rows.Scan(&st, &n) != nil {
			continue
		}
		switch st {
		case "recording":
			out.Recording = n
		case "uploading":
			out.Uploading = n
		case "ready":
			out.Ready = n
		case "failed":
			out.Failed = n
		}
	}
	return out, rows.Err()
}

// ListExpired: terminal rows started strictly before cutoff, oldest first.
func (r *Vods) ListExpired(ctx context.Context, app, cutoffISO string, limit int) ([]int64, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT id FROM vods
           WHERE status IN ('ready', 'failed')
             AND started_at IS NOT NULL
             AND started_at < ?
           ORDER BY started_at ASC
           LIMIT ?`, cutoffISO, int(math.Max(1, float64(limit))))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// Delete removes a row.
func (r *Vods) Delete(ctx context.Context, app string, id int64) error {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM vods WHERE id = ?`, id)
	return err
}

// ---------------------------------------------------------------------------
// vod_variants
// ---------------------------------------------------------------------------

// VariantKind is master | rendition | alternate.
type VariantKind = string

// VariantRecord is a vod_variants row.
type VariantRecord struct {
	ID          int64    `json:"id"`
	VodID       int64    `json:"vodId"`
	Kind        string   `json:"kind"`
	Format      string   `json:"format"`
	Height      *float64 `json:"height"`
	BitrateKbps *float64 `json:"bitrateKbps"`
	FileKey     *string  `json:"fileKey"`
	SizeBytes   *float64 `json:"sizeBytes"`
	ExtraJSON   *string  `json:"extraJson"`
	CreatedAt   string   `json:"createdAt"`
}

// VariantInsert is a new variant row (nil → NULL).
type VariantInsert struct {
	VodID       int64
	Kind        string
	Format      string
	Height      *float64
	BitrateKbps *float64
	FileKey     *string
	SizeBytes   *float64
	ExtraJSON   *string
}

// Variants is the vod_variants repository.
type Variants struct{ appDB AppDBFunc }

// NewVariants builds the repository.
func NewVariants(appDB AppDBFunc) *Variants { return &Variants{appDB: appDB} }

// Insert adds a variant row.
func (r *Variants) Insert(ctx context.Context, app string, v VariantInsert) (int64, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return 0, err
	}
	res, err := h.ExecContext(ctx, `INSERT INTO vod_variants
           (vod_id, kind, format, height, bitrate_kbps, file_key, size_bytes, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, v.VodID, v.Kind, v.Format, v.Height, v.BitrateKbps, v.FileKey, v.SizeBytes, v.ExtraJSON)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListByVod: master, renditions (height DESC), alternates.
func (r *Variants) ListByVod(ctx context.Context, app string, vodID int64) ([]VariantRecord, error) {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return nil, err
	}
	rows, err := h.QueryContext(ctx, `SELECT id, vod_id, kind, format, height, bitrate_kbps, file_key, size_bytes, extra_json, created_at
           FROM vod_variants
           WHERE vod_id = ?
           ORDER BY CASE kind
                      WHEN 'master' THEN 0
                      WHEN 'rendition' THEN 1
                      ELSE 2
                    END,
                    height DESC, id ASC`, vodID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []VariantRecord{}
	for rows.Next() {
		var v VariantRecord
		var hgt, br, sz sql.NullFloat64
		var fk, ej sql.NullString
		if err := rows.Scan(&v.ID, &v.VodID, &v.Kind, &v.Format, &hgt, &br, &fk, &sz, &ej, &v.CreatedAt); err != nil {
			return nil, err
		}
		v.Height, v.BitrateKbps, v.SizeBytes, v.FileKey, v.ExtraJSON = nf(hgt), nf(br), nf(sz), ns(fk), ns(ej)
		out = append(out, v)
	}
	return out, rows.Err()
}

// DeleteByVod removes every variant of a VOD.
func (r *Variants) DeleteByVod(ctx context.Context, app string, vodID int64) error {
	h, err := r.appDB(ctx, app)
	if err != nil {
		return err
	}
	_, err = h.ExecContext(ctx, `DELETE FROM vod_variants WHERE vod_id = ?`, vodID)
	return err
}
