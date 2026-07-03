import { Injectable } from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';

/**
 * Kind of a VOD variant row:
 *  - `master`    — the HLS master playlist (the adaptive entry point).
 *  - `rendition` — one HLS rendition (a ladder step: height + bitrate).
 *  - `alternate` — an alternate whole-file encoding (e.g. WebM/VP8).
 */
export type VodVariantKind = 'master' | 'rendition' | 'alternate';

/** Raw snake_case row of the per-app `vod_variants` table. */
interface VodVariantRow {
  id: number;
  vod_id: number;
  kind: VodVariantKind;
  format: string;
  height: number | null;
  bitrate_kbps: number | null;
  file_key: string | null;
  size_bytes: number | null;
  extra_json: string | null;
  created_at: string;
}

/** One generated variant of a VOD (see APP_MIGRATIONS #6). */
export interface VodVariantRecord {
  id: number;
  vodId: number;
  kind: VodVariantKind;
  /** e.g. 'hls' (master), 'hls-h264' (rendition), 'webm-vp8' (alternate). */
  format: string;
  height: number | null;
  bitrateKbps: number | null;
  /** S3 object key: playlist for HLS kinds, the file for alternates. */
  fileKey: string | null;
  sizeBytes: number | null;
  /** Free-form JSON; HLS renditions carry `{ segmentKeys: string[] }`. */
  extraJson: string | null;
  createdAt: string;
}

/** Fields that may be set on insert. */
export interface VodVariantInsert {
  vodId: number;
  kind: VodVariantKind;
  format: string;
  height?: number | null;
  bitrateKbps?: number | null;
  fileKey?: string | null;
  sizeBytes?: number | null;
  extraJson?: string | null;
}

/**
 * Data-access layer for the per-app `vod_variants` table (adaptive VOD /
 * multi-encoding). Same conventions as {@link VodsRepository}: one synchronous
 * better-sqlite3 handle per app via `DbService.appDb(app)`.
 */
@Injectable()
export class VodVariantsRepository {
  constructor(private readonly db: DbService) {}

  insert(appName: string, v: VodVariantInsert): number {
    const info = this.db
      .appDb(appName)
      .prepare(
        `INSERT INTO vod_variants
           (vod_id, kind, format, height, bitrate_kbps, file_key, size_bytes, extra_json)
         VALUES (@vod_id, @kind, @format, @height, @bitrate_kbps, @file_key, @size_bytes, @extra_json)`,
      )
      .run({
        vod_id: v.vodId,
        kind: v.kind,
        format: v.format,
        height: v.height ?? null,
        bitrate_kbps: v.bitrateKbps ?? null,
        file_key: v.fileKey ?? null,
        size_bytes: v.sizeBytes ?? null,
        extra_json: v.extraJson ?? null,
      });
    return Number(info.lastInsertRowid);
  }

  /**
   * All variants of a VOD, master first, then renditions by height DESC, then
   * alternates — a stable, presentation-ready order.
   */
  listByVod(appName: string, vodId: number): VodVariantRecord[] {
    const rows = this.db
      .appDb(appName)
      .prepare(
        `SELECT * FROM vod_variants
           WHERE vod_id = ?
           ORDER BY CASE kind
                      WHEN 'master' THEN 0
                      WHEN 'rendition' THEN 1
                      ELSE 2
                    END,
                    height DESC, id ASC`,
      )
      .all(vodId) as VodVariantRow[];
    return rows.map((r) => this.map(r));
  }

  /** Remove every variant row of a VOD (delete cascade helper). */
  deleteByVod(appName: string, vodId: number): void {
    this.db
      .appDb(appName)
      .prepare('DELETE FROM vod_variants WHERE vod_id = ?')
      .run(vodId);
  }

  private map(r: VodVariantRow): VodVariantRecord {
    return {
      id: r.id,
      vodId: r.vod_id,
      kind: r.kind,
      format: r.format,
      height: r.height,
      bitrateKbps: r.bitrate_kbps,
      fileKey: r.file_key,
      sizeBytes: r.size_bytes,
      extraJson: r.extra_json,
      createdAt: r.created_at,
    };
  }
}
