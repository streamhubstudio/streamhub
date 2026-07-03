import { Injectable } from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';
import { VodRecord, VodStatus } from '../../shared/contracts';

/** Raw snake_case row of the per-app `vods` table. */
interface VodRow {
  id: number;
  app_id: number;
  stream_id: string | null;
  room: string | null;
  name: string;
  file_key: string | null;
  s3_url: string | null;
  public_url: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  format: string | null;
  status: VodStatus;
  local_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  metatags_json: string | null;
  snapshot_key: string | null;
}

/** Fields that may be set on insert. */
export interface VodInsert {
  appId: number;
  streamId: string | null;
  room: string | null;
  name: string;
  status: VodStatus;
  localPath: string | null;
  startedAt: string | null;
  metatagsJson: string | null;
}

/** Partial patch applied on update (only provided keys are written). */
export interface VodPatch {
  fileKey?: string | null;
  s3Url?: string | null;
  publicUrl?: string | null;
  sizeBytes?: number | null;
  durationS?: number | null;
  width?: number | null;
  height?: number | null;
  format?: string | null;
  status?: VodStatus;
  localPath?: string | null;
  endedAt?: string | null;
  metatagsJson?: string | null;
  snapshotKey?: string | null;
}

/** Sortable columns exposed by {@link VodsRepository.list}. */
export type VodOrderField = 'started_at' | 'size_bytes' | 'id';
/** Sort direction. */
export type SortDir = 'asc' | 'desc';

/**
 * Filters applied to VOD listing/count. All optional and AND-combined; every
 * clause is backed by an existing index (idx_vods_room / idx_vods_started_at /
 * idx_vods_status_started).
 */
export interface VodFilters {
  /** Exact room match. */
  room?: string;
  /** Exact status match. */
  status?: VodStatus;
  /** started_at >= since (ISO-8601). */
  since?: string;
  /** started_at <= until (ISO-8601). */
  until?: string;
}

/** Listing options = filters + ordering + paging. */
export interface VodListOptions extends VodFilters {
  /** Max rows (ignored when {@link all}). Defaults to 200. */
  limit?: number;
  /** Rows to skip (ignored when {@link all}). Defaults to 0. */
  offset?: number;
  /** Sort column (default `id`). */
  order?: VodOrderField;
  /** Sort direction (default `desc`). */
  dir?: SortDir;
  /** When true, return EVERY matching row (limit/offset ignored). */
  all?: boolean;
}

/** Whitelist mapping order field → physical column (prevents SQL injection). */
const ORDER_COLUMNS: Record<VodOrderField, string> = {
  started_at: 'started_at',
  size_bytes: 'size_bytes',
  id: 'id',
};

const PATCH_COLUMNS: Record<keyof VodPatch, string> = {
  fileKey: 'file_key',
  s3Url: 's3_url',
  publicUrl: 'public_url',
  sizeBytes: 'size_bytes',
  durationS: 'duration_s',
  width: 'width',
  height: 'height',
  format: 'format',
  status: 'status',
  localPath: 'local_path',
  endedAt: 'ended_at',
  metatagsJson: 'metatags_json',
  snapshotKey: 'snapshot_key',
};

/**
 * Data-access layer for the per-app `vods` table (SPEC §4). Lives in the
 * consolidated per-app database apps/<name>/app.db, reached via the canonical
 * `DbService.appDb(app)` accessor (the legacy standalone vods.db is imported
 * into app.db on first open). better-sqlite3 is synchronous, so methods return
 * directly. One handle per app, owned by DbService (cached).
 */
@Injectable()
export class VodsRepository {
  constructor(private readonly db: DbService) {}

  insert(appName: string, v: VodInsert): number {
    const stmt = this.db.appDb(appName).prepare(
      `INSERT INTO vods
         (app_id, stream_id, room, name, status, local_path, started_at, metatags_json)
       VALUES (@app_id, @stream_id, @room, @name, @status, @local_path, @started_at, @metatags_json)`,
    );
    const info = stmt.run({
      app_id: v.appId,
      stream_id: v.streamId,
      room: v.room,
      name: v.name,
      status: v.status,
      local_path: v.localPath,
      started_at: v.startedAt,
      metatags_json: v.metatagsJson,
    });
    return Number(info.lastInsertRowid);
  }

  update(appName: string, id: number, patch: VodPatch): void {
    const keys = Object.keys(patch) as (keyof VodPatch)[];
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${PATCH_COLUMNS[k]} = @${k}`).join(', ');
    const params: Record<string, unknown> = { id };
    for (const k of keys) params[k] = patch[k] ?? null;
    this.db
      .appDb(appName)
      .prepare(`UPDATE vods SET ${assignments} WHERE id = @id`)
      .run(params);
  }

  findById(appName: string, id: number): VodRecord | null {
    const row = this.db
      .appDb(appName)
      .prepare('SELECT * FROM vods WHERE id = ?')
      .get(id) as VodRow | undefined;
    return row ? this.map(row) : null;
  }

  findByEgressId(appName: string, egressId: string): VodRecord | null {
    const row = this.db
      .appDb(appName)
      .prepare(
        `SELECT * FROM vods
           WHERE json_extract(metatags_json, '$.egressId') = ?
           ORDER BY id DESC LIMIT 1`,
      )
      .get(egressId) as VodRow | undefined;
    return row ? this.map(row) : null;
  }

  /** Latest still-in-progress (recording/uploading) VOD for a stream id. */
  findActiveByStream(appName: string, streamId: string): VodRecord | null {
    const row = this.db
      .appDb(appName)
      .prepare(
        `SELECT * FROM vods
           WHERE stream_id = ? AND status IN ('recording', 'uploading')
           ORDER BY id DESC LIMIT 1`,
      )
      .get(streamId) as VodRow | undefined;
    return row ? this.map(row) : null;
  }

  /**
   * List VODs with optional filters, ordering and paging. Default order is
   * `id DESC` (newest first, preserving the historical behaviour). A stable
   * `id` tiebreak is appended when ordering by started_at/size_bytes so equal
   * keys keep a deterministic order across pages.
   */
  list(appName: string, opts: VodListOptions = {}): VodRecord[] {
    const where = this.buildWhere(opts);
    const column = ORDER_COLUMNS[opts.order ?? 'id'] ?? 'id';
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const orderSql =
      column === 'id'
        ? `ORDER BY id ${dir}`
        : `ORDER BY ${column} ${dir}, id ${dir}`;

    const params = [...where.params];
    let sql = `SELECT * FROM vods${where.sql} ${orderSql}`;
    if (!opts.all) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(opts.limit ?? 200, opts.offset ?? 0);
    }
    const rows = this.db.appDb(appName).prepare(sql).all(...params) as VodRow[];
    return rows.map((r) => this.map(r));
  }

  /** COUNT of VODs matching the given filters (no paging). */
  count(appName: string, filters: VodFilters = {}): number {
    const where = this.buildWhere(filters);
    const row = this.db
      .appDb(appName)
      .prepare(`SELECT COUNT(*) AS n FROM vods${where.sql}`)
      .get(...where.params) as { n: number } | undefined;
    return Number(row?.n) || 0;
  }

  /** Row counts grouped by VOD status (all four keys always present). */
  countByStatus(appName: string): Record<VodStatus, number> {
    const byStatus: Record<VodStatus, number> = {
      recording: 0,
      uploading: 0,
      ready: 0,
      failed: 0,
    };
    const rows = this.db
      .appDb(appName)
      .prepare('SELECT status, COUNT(*) AS n FROM vods GROUP BY status')
      .all() as { status: VodStatus; n: number }[];
    for (const r of rows) {
      if (r.status in byStatus) byStatus[r.status] = Number(r.n) || 0;
    }
    return byStatus;
  }

  /** Build a parameterized WHERE clause from filters (empty string when none). */
  private buildWhere(f: VodFilters): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (f.room !== undefined) {
      clauses.push('room = ?');
      params.push(f.room);
    }
    if (f.status !== undefined) {
      clauses.push('status = ?');
      params.push(f.status);
    }
    if (f.since !== undefined) {
      clauses.push('started_at >= ?');
      params.push(f.since);
    }
    if (f.until !== undefined) {
      clauses.push('started_at <= ?');
      params.push(f.until);
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  delete(appName: string, id: number): void {
    this.db.appDb(appName).prepare('DELETE FROM vods WHERE id = ?').run(id);
  }

  private map(r: VodRow): VodRecord {
    return {
      id: r.id,
      appId: r.app_id,
      streamId: r.stream_id,
      room: r.room,
      name: r.name,
      fileKey: r.file_key,
      s3Url: r.s3_url,
      publicUrl: r.public_url,
      sizeBytes: r.size_bytes,
      durationS: r.duration_s,
      width: r.width,
      height: r.height,
      format: r.format,
      status: r.status,
      localPath: r.local_path,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      metatagsJson: r.metatags_json,
      snapshotKey: r.snapshot_key,
    };
  }
}
