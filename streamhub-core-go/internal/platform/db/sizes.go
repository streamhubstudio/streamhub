package db

import (
	"context"
	"os"
)

// Port of shared/db/db-sizes.service.ts: on-disk footprint of the SQLite
// files plus the VOD storage rollup (SUM(vods.size_bytes)) per app and
// server-wide. Read-only; never fails (missing files / tables count as 0).

// VodTotals is the VOD rollup of one scope.
type VodTotals struct {
	VodTotalBytes float64 `json:"vodTotalBytes"`
	VodCount      int64   `json:"vodCount"`
}

// AppSizes are one app's DB + VOD sizes.
type AppSizes struct {
	App         string `json:"app"`
	DBSizeBytes int64  `json:"dbSizeBytes"`
	VodTotals
}

// ServerSizes is the server-wide rollup (Dashboard cards).
type ServerSizes struct {
	DBSizeBytes      int64 `json:"dbSizeBytes"`
	AppsDBSizeBytes  int64 `json:"appsDbSizeBytes"`
	TotalDBSizeBytes int64 `json:"totalDbSizeBytes"`
	VodTotals
	Apps []AppSizes `json:"apps"`
}

// AppSizes reports apps/<app>/app.db (+ -wal/-shm) and the app's VOD totals.
func (s *Service) AppSizes(ctx context.Context, app string) AppSizes {
	size := fileGroupSize(s.AppPath(app))
	return AppSizes{App: app, DBSizeBytes: size, VodTotals: s.AppVodTotals(ctx, app)}
}

// ServerSizes reports the global DB, every per-app DB and all VOD storage.
func (s *Service) ServerSizes(ctx context.Context) ServerSizes {
	out := ServerSizes{DBSizeBytes: fileGroupSize(s.GlobalPath()), Apps: []AppSizes{}}
	for _, name := range s.appNames(ctx) {
		a := s.AppSizes(ctx, name)
		out.Apps = append(out.Apps, a)
		out.AppsDBSizeBytes += a.DBSizeBytes
		out.VodTotalBytes += a.VodTotalBytes
		out.VodCount += a.VodCount
	}
	out.TotalDBSizeBytes = out.DBSizeBytes + out.AppsDBSizeBytes
	return out
}

// AppVodTotals is SUM(size_bytes) + COUNT(*) over the app's vods table.
func (s *Service) AppVodTotals(ctx context.Context, app string) VodTotals {
	h, err := s.App(ctx, app)
	if err != nil {
		return VodTotals{}
	}
	var t VodTotals
	if err := h.QueryRowContext(ctx, `SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS count FROM vods`).
		Scan(&t.VodTotalBytes, &t.VodCount); err != nil {
		s.log.Debug("vod totals failed", "app", app, "err", err)
		return VodTotals{}
	}
	return t
}

func (s *Service) appNames(ctx context.Context) []string {
	g, err := s.Global(ctx)
	if err != nil {
		return nil
	}
	rows, err := g.QueryContext(ctx, `SELECT name FROM apps`)
	if err != nil {
		s.log.Warn("app enumeration failed", "err", err)
		return nil
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			names = append(names, n)
		}
	}
	return names
}

// fileGroupSize is a SQLite file plus its -wal / -shm sidecars.
func fileGroupSize(file string) int64 {
	return fileSize(file) + fileSize(file+"-wal") + fileSize(file+"-shm")
}

func fileSize(p string) int64 {
	st, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return st.Size()
}
