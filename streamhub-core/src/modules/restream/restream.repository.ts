import { Injectable } from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';

/** Lifecycle of a restream destination (per-endpoint, independent of others). */
export type RestreamStatus = 'starting' | 'active' | 'failed' | 'stopped';

/** Raw `restream_targets` row (per-app app.db — see APP_MIGRATIONS #7). */
export interface RestreamTargetRow {
  id: number;
  app: string;
  room: string;
  stream_id: string | null;
  name: string | null;
  platform: string;
  /** FULL destination URL (incl. stream key). NEVER leaves the server. */
  url: string;
  url_masked: string;
  egress_id: string | null;
  status: RestreamStatus;
  error: string | null;
  retries: number;
  started_at: string;
  ended_at: string | null;
}

export interface RestreamInsert {
  app: string;
  room: string;
  streamId: string | null;
  name: string | null;
  platform: string;
  url: string;
  urlMasked: string;
  egressId: string;
}

/**
 * Data access for `restream_targets` (module `restream`). Every method is
 * app-scoped: rows live in the app's own app.db, so cross-app/tenant isolation
 * is structural — one app can never read another app's destinations.
 */
@Injectable()
export class RestreamRepository {
  constructor(private readonly db: DbService) {}

  insert(input: RestreamInsert): RestreamTargetRow {
    const adb = this.db.appDb(input.app);
    const res = adb
      .prepare(
        `INSERT INTO restream_targets
           (app, room, stream_id, name, platform, url, url_masked, egress_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting')`,
      )
      .run(
        input.app,
        input.room,
        input.streamId,
        input.name,
        input.platform,
        input.url,
        input.urlMasked,
        input.egressId,
      );
    return this.byId(input.app, Number(res.lastInsertRowid)) as RestreamTargetRow;
  }

  byId(app: string, id: number): RestreamTargetRow | undefined {
    return this.db
      .appDb(app)
      .prepare('SELECT * FROM restream_targets WHERE id = ?')
      .get(id) as RestreamTargetRow | undefined;
  }

  byEgressId(app: string, egressId: string): RestreamTargetRow | undefined {
    return this.db
      .appDb(app)
      .prepare(
        'SELECT * FROM restream_targets WHERE egress_id = ? ORDER BY id DESC',
      )
      .get(egressId) as RestreamTargetRow | undefined;
  }

  /** Non-stopped destinations of a room (starting/active/failed), newest first. */
  listByRoom(app: string, room: string): RestreamTargetRow[] {
    return this.db
      .appDb(app)
      .prepare(
        `SELECT * FROM restream_targets
          WHERE room = ? AND status != 'stopped'
          ORDER BY id DESC`,
      )
      .all(room) as RestreamTargetRow[];
  }

  /** A live (starting/active) destination of the room with this exact URL. */
  findLiveByUrl(
    app: string,
    room: string,
    url: string,
  ): RestreamTargetRow | undefined {
    return this.db
      .appDb(app)
      .prepare(
        `SELECT * FROM restream_targets
          WHERE room = ? AND url = ? AND status IN ('starting','active')
          ORDER BY id DESC`,
      )
      .get(room, url) as RestreamTargetRow | undefined;
  }

  countLiveByRoom(app: string, room: string): number {
    const row = this.db
      .appDb(app)
      .prepare(
        `SELECT COUNT(*) AS n FROM restream_targets
          WHERE room = ? AND status IN ('starting','active')`,
      )
      .get(room) as { n: number };
    return row?.n ?? 0;
  }

  setStatus(
    app: string,
    id: number,
    status: RestreamStatus,
    error?: string | null,
  ): void {
    const ended = status === 'stopped' || status === 'failed';
    this.db
      .appDb(app)
      .prepare(
        `UPDATE restream_targets
            SET status = ?,
                error = ?,
                ended_at = CASE WHEN ? THEN datetime('now') ELSE ended_at END
          WHERE id = ?`,
      )
      .run(status, error ?? null, ended ? 1 : 0, id);
  }

  /** Point a target at a fresh egress after a retry relaunch. */
  setEgress(app: string, id: number, egressId: string, retries: number): void {
    this.db
      .appDb(app)
      .prepare(
        `UPDATE restream_targets
            SET egress_id = ?, status = 'starting', error = NULL,
                retries = ?, ended_at = NULL
          WHERE id = ?`,
      )
      .run(egressId, retries, id);
  }

  bumpRetries(app: string, id: number, retries: number): void {
    this.db
      .appDb(app)
      .prepare('UPDATE restream_targets SET retries = ? WHERE id = ?')
      .run(retries, id);
  }
}
