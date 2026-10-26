import { Injectable } from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';

/** Raw `scheduled_events` row (per-app app.db — see APP_MIGRATIONS #9). */
export interface ScheduledEventRow {
  id: number;
  app: string;
  room: string | null;
  title: string | null;
  /** Absolute reveal instant — unix epoch MILLISECONDS, UTC. */
  start_at: number;
  timezone: string;
  message: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** A scheduled event as exposed by the service/API (camelCase, boolean enabled). */
export interface ScheduledEventView {
  id: number;
  room: string | null;
  title: string | null;
  startAt: number;
  timezone: string;
  message: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** New event to insert (already validated by the service). */
export interface ScheduledEventInsert {
  room: string | null;
  title: string | null;
  startAt: number;
  timezone: string;
  message: string | null;
  enabled: boolean;
}

/** Partial patch (only present fields are written). */
export interface ScheduledEventPatch {
  room?: string | null;
  title?: string | null;
  startAt?: number;
  timezone?: string;
  message?: string | null;
  enabled?: boolean;
}

/**
 * Data access for `scheduled_events` (module `scheduled-live`). Every method is
 * app-scoped: rows live in the app's own app.db, so cross-app/tenant isolation
 * is structural — one app can never read another app's agenda.
 */
@Injectable()
export class ScheduledLiveRepository {
  constructor(private readonly db: DbService) {}

  /** Every event of the app, soonest first (operator agenda view). */
  list(app: string): ScheduledEventView[] {
    const rows = this.db
      .appDb(app)
      .prepare('SELECT * FROM scheduled_events ORDER BY start_at ASC')
      .all() as ScheduledEventRow[];
    return rows.map(ScheduledLiveRepository.toView);
  }

  /**
   * Enabled, not-yet-past events for the anonymous player, soonest first.
   * `sinceMs` is the lower bound on start_at (events that revealed before it are
   * dropped). When `room` is given, only events for that room OR global events
   * (room IS NULL) are returned; without a room, every enabled event qualifies.
   */
  listPublic(app: string, room: string | undefined, sinceMs: number): ScheduledEventView[] {
    const adb = this.db.appDb(app);
    const rows = room
      ? (adb
          .prepare(
            `SELECT * FROM scheduled_events
              WHERE enabled = 1 AND start_at >= ?
                AND (room IS NULL OR room = ?)
              ORDER BY start_at ASC`,
          )
          .all(sinceMs, room) as ScheduledEventRow[])
      : (adb
          .prepare(
            `SELECT * FROM scheduled_events
              WHERE enabled = 1 AND start_at >= ?
              ORDER BY start_at ASC`,
          )
          .all(sinceMs) as ScheduledEventRow[]);
    return rows.map(ScheduledLiveRepository.toView);
  }

  get(app: string, id: number): ScheduledEventView | undefined {
    const row = this.db
      .appDb(app)
      .prepare('SELECT * FROM scheduled_events WHERE id = ?')
      .get(id) as ScheduledEventRow | undefined;
    return row ? ScheduledLiveRepository.toView(row) : undefined;
  }

  create(app: string, input: ScheduledEventInsert): ScheduledEventView {
    const res = this.db
      .appDb(app)
      .prepare(
        `INSERT INTO scheduled_events
           (app, room, title, start_at, timezone, message, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        app,
        input.room,
        input.title,
        input.startAt,
        input.timezone,
        input.message,
        input.enabled ? 1 : 0,
      );
    return this.get(app, Number(res.lastInsertRowid)) as ScheduledEventView;
  }

  /** Apply a partial patch. Returns the updated row, or undefined if unknown. */
  update(app: string, id: number, patch: ScheduledEventPatch): ScheduledEventView | undefined {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.room !== undefined) {
      sets.push('room = ?');
      params.push(patch.room);
    }
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.startAt !== undefined) {
      sets.push('start_at = ?');
      params.push(patch.startAt);
    }
    if (patch.timezone !== undefined) {
      sets.push('timezone = ?');
      params.push(patch.timezone);
    }
    if (patch.message !== undefined) {
      sets.push('message = ?');
      params.push(patch.message);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      this.db
        .appDb(app)
        .prepare(`UPDATE scheduled_events SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    return this.get(app, id);
  }

  /** Delete an event. Returns true when a row was actually removed. */
  remove(app: string, id: number): boolean {
    const res = this.db
      .appDb(app)
      .prepare('DELETE FROM scheduled_events WHERE id = ?')
      .run(id);
    return res.changes > 0;
  }

  private static toView(row: ScheduledEventRow): ScheduledEventView {
    return {
      id: row.id,
      room: row.room,
      title: row.title,
      startAt: row.start_at,
      timezone: row.timezone,
      message: row.message,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
