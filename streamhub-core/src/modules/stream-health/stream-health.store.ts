/**
 * Per-app stream-health persistence — `apps/<app>/stream-health/
 * stream-health.db` (better-sqlite3, same engine as DbService; WAL). Opened
 * lazily and cached per app, following the vision-apps store idiom. Two
 * tables:
 *
 *   health_events    — bounded HISTORY of dispatched health.* transitions
 *                      (each write prunes rows older than {@link RETENTION_DAYS});
 *   stream_settings  — per-room threshold OVERRIDES (PK room, partial JSON).
 *
 * The WORKER opens the same file READ-ONLY (node:sqlite) to pick up per-room
 * overrides each cycle — so writes here are visible to a running probe without
 * a restart. The store is a thin synchronous repository; wiring lives in
 * StreamHealthService.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type { Db } from '../../shared/db/db.service';
import type { HealthThresholds } from './stream-health.thresholds';

/** Bounded history horizon (days) for health_events. */
export const RETENTION_DAYS = 30;

const DDL = `
CREATE TABLE IF NOT EXISTS health_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  room      TEXT NOT NULL,
  event     TEXT NOT NULL,
  status    TEXT,
  reasons   TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  ts        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_health_events_ts ON health_events(ts);
CREATE INDEX IF NOT EXISTS idx_health_events_room ON health_events(room);
CREATE TABLE IF NOT EXISTS stream_settings (
  room        TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room)
);`;

/** One recorded health.* transition, shaped for the API. */
export interface HealthEventRow {
  id: number;
  room: string;
  event: string;
  /** Rollup status carried by the event ('degraded'|'critical'|'healthy'|null). */
  status: string | null;
  /** Comma-joined reason codes carried by the event (may be null). */
  reasons: string | null;
  ts: string;
  data: Record<string, unknown>;
}

/** One stored per-room override row. */
export interface HealthSettingRow {
  room: string;
  override: Partial<HealthThresholds>;
  updatedAt: string;
}

@Injectable()
export class StreamHealthStore implements OnModuleDestroy {
  private readonly dbs = new Map<string, Db>();

  /** Test seam: override the file path resolver. */
  fileFor: (appDir: string) => string = (appDir) =>
    path.join(appDir, 'stream-health', 'stream-health.db');

  onModuleDestroy(): void {
    for (const db of this.dbs.values()) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    this.dbs.clear();
  }

  /** Open (create + migrate) and cache the per-app db. */
  db(app: string, appDir: string): Db {
    const cached = this.dbs.get(app);
    if (cached) return cached;
    const file = this.fileFor(appDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(DDL);
    this.dbs.set(app, db);
    return db;
  }

  /** Drop the cached handle for an app. */
  close(app: string): void {
    const db = this.dbs.get(app);
    if (!db) return;
    this.dbs.delete(app);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------------------------------------------------------------------------
  // Events (bounded history)
  // ---------------------------------------------------------------------------

  /** Record one dispatched health.* event; prunes expired rows on the way. */
  record(
    app: string,
    appDir: string,
    room: string,
    event: string,
    data: Record<string, unknown>,
  ): void {
    const db = this.db(app, appDir);
    const status = typeof data.status === 'string' ? data.status : null;
    const reasons = Array.isArray(data.reasons)
      ? data.reasons.map((r) => String(r)).join(',')
      : null;
    // ts is written EXPLICITLY as ISO-8601 (UTC) so the `ts >= ?` cutoff
    // comparisons compare like-with-like — sqlite's datetime('now') default
    // ('YYYY-MM-DD HH:MM:SS') would sort BELOW any same-day ISO cutoff.
    db.prepare(
      `INSERT INTO health_events (room, event, status, reasons, data_json, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(room, event, status, reasons, safeJson(data), new Date().toISOString());
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 86400_000,
    ).toISOString();
    db.prepare('DELETE FROM health_events WHERE ts < ?').run(cutoff);
  }

  /** Recent events, newest first (capped), optionally scoped to one room. */
  recentEvents(
    app: string,
    appDir: string,
    limit: number,
    room?: string,
  ): HealthEventRow[] {
    const cap = Math.max(1, Math.min(1000, Math.floor(limit) || 50));
    const db = this.db(app, appDir);
    const rows = (
      room
        ? db
            .prepare(
              'SELECT * FROM health_events WHERE room = ? ORDER BY id DESC LIMIT ?',
            )
            .all(room, cap)
        : db.prepare('SELECT * FROM health_events ORDER BY id DESC LIMIT ?').all(cap)
    ) as Record<string, unknown>[];
    return rows.map(mapEvent);
  }

  /** Count of events since an ISO cutoff (the "today" tile). */
  countSince(app: string, appDir: string, sinceIso: string): number {
    const row = this.db(app, appDir)
      .prepare('SELECT COUNT(*) AS n FROM health_events WHERE ts >= ?')
      .get(sinceIso) as { n: number };
    return row.n;
  }

  /** Rooms seen in the event history since a cutoff, with their latest event. */
  roomsSince(
    app: string,
    appDir: string,
    sinceIso: string,
  ): { room: string; lastEvent: string; lastTs: string }[] {
    return this.db(app, appDir)
      .prepare(
        `SELECT room, event AS lastEvent, ts AS lastTs FROM health_events
          WHERE id IN (SELECT MAX(id) FROM health_events WHERE ts >= ? GROUP BY room)
          ORDER BY room`,
      )
      .all(sinceIso) as { room: string; lastEvent: string; lastTs: string }[];
  }

  // ---------------------------------------------------------------------------
  // Per-room threshold overrides
  // ---------------------------------------------------------------------------

  getSetting(app: string, appDir: string, room: string): HealthSettingRow | null {
    const row = this.db(app, appDir)
      .prepare(
        'SELECT room, config_json, updated_at FROM stream_settings WHERE room = ?',
      )
      .get(room) as
      | { room: string; config_json: string; updated_at: string }
      | undefined;
    return row ? mapSetting(row) : null;
  }

  /** Upsert a per-room override (an empty object clears every override key). */
  putSetting(
    app: string,
    appDir: string,
    room: string,
    override: Partial<HealthThresholds>,
  ): HealthSettingRow {
    this.db(app, appDir)
      .prepare(
        `INSERT INTO stream_settings (room, config_json, updated_at)
           VALUES (?, ?, ?)
         ON CONFLICT(room) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(room, JSON.stringify(override ?? {}), new Date().toISOString());
    return this.getSetting(app, appDir, room) as HealthSettingRow;
  }

  /** Every room with a stored override. */
  listSettings(app: string, appDir: string): HealthSettingRow[] {
    const rows = this.db(app, appDir)
      .prepare('SELECT room, config_json, updated_at FROM stream_settings ORDER BY room')
      .all() as { room: string; config_json: string; updated_at: string }[];
    return rows.map(mapSetting);
  }
}

// ---------------------------------------------------------------------------

function mapEvent(r: Record<string, unknown>): HealthEventRow {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(r.data_json ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt cell → empty */
  }
  return {
    id: Number(r.id),
    room: String(r.room ?? ''),
    event: String(r.event ?? ''),
    status: typeof r.status === 'string' ? r.status : null,
    reasons: typeof r.reasons === 'string' ? r.reasons : null,
    ts: String(r.ts ?? ''),
    data,
  };
}

function mapSetting(r: {
  room: string;
  config_json: string;
  updated_at: string;
}): HealthSettingRow {
  let override: Partial<HealthThresholds> = {};
  try {
    const parsed = JSON.parse(r.config_json ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      override = parsed as Partial<HealthThresholds>;
    }
  } catch {
    /* corrupt cell → empty */
  }
  return { room: r.room, override, updatedAt: r.updated_at };
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data ?? {});
  } catch {
    return '{}';
  }
}
