/**
 * Per-app, PER-MODEL vision persistence — `apps/<app>/<model>/<model>.db` (its
 * own SQLite file, one per vision model-app: occupancy.db / counting.db /
 * crowd.db / demography.db). Opened lazily with better-sqlite3 (same engine as
 * DbService) and cached per (app, model). Each db owns exactly TWO tables:
 *
 *   <model events table> — occupancy_sessions / count_events / crowd_events /
 *                          demography_events (one, keyed by the model).
 *   stream_settings      — per-room config_json overrides (PK room; NO model
 *                          column — the db already IS the model).
 *
 * The event table is bounded HISTORY: each write prunes rows older than
 * {@link RETENTION_DAYS} so a busy app never bloats the file. The store is a
 * thin synchronous repository parametrized by model; all wiring lives in the
 * services. (Edge-as-capability 2.16.0: split out of the old single vision.db.)
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type { Db } from '../../shared/db/db.service';
import type { ModelConfig, VisionModel } from './vision.types';

/** Bounded history horizon (days) for the event tables. */
export const RETENTION_DAYS = 30;

/** Model → its event table name. */
const EVENT_TABLE: Record<VisionModel, string> = {
  occupancy: 'occupancy_sessions',
  counting: 'count_events',
  crowd: 'crowd_events',
  demography: 'demography_events',
};

/** Per-model event-table DDL (each db carries ONLY its own model's table). */
const EVENT_TABLE_DDL: Record<VisionModel, string> = {
  occupancy: `
CREATE TABLE IF NOT EXISTS occupancy_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  zone        TEXT,
  tag         TEXT,
  kind        TEXT,
  node_id     TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  duration_sec REAL,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_occ_ts ON occupancy_sessions(ts);`,
  counting: `
CREATE TABLE IF NOT EXISTS count_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  line        TEXT,
  tag         TEXT,
  direction   TEXT,
  track_id    TEXT,
  inside      INTEGER,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_count_ts ON count_events(ts);`,
  crowd: `
CREATE TABLE IF NOT EXISTS crowd_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  zone        TEXT,
  tag         TEXT,
  count       INTEGER,
  threshold   INTEGER,
  alert       INTEGER NOT NULL DEFAULT 0,
  snapshot_url TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_crowd_ts ON crowd_events(ts);`,
  demography: `
CREATE TABLE IF NOT EXISTS demography_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  tag         TEXT,
  age         REAL,
  age_range   TEXT,
  gender      TEXT,
  emotion     TEXT,
  engine      TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_demo_ts ON demography_events(ts);`,
};

/** Per-model stream-settings table (room-keyed; the db already IS the model). */
const STREAM_SETTINGS_DDL = `
CREATE TABLE IF NOT EXISTS stream_settings (
  room        TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room)
);`;

/** One stored per-room settings row. */
export interface StreamSettingRow {
  room: string;
  config: ModelConfig;
  updatedAt: string;
}

/** A recorded detection event (any table), shaped for the API. */
export interface VisionEventRow {
  id: number;
  model: VisionModel;
  event: string;
  room: string;
  tag: string | null;
  ts: string;
  data: Record<string, unknown>;
}

@Injectable()
export class VisionStore implements OnModuleDestroy {
  /** Handles cached per `${app}::${model}`. */
  private readonly dbs = new Map<string, Db>();
  /**
   * Test seam: override the file path resolver (default =
   * `<appDir>/<model>/<model>.db`).
   */
  fileFor: (appDir: string, model: VisionModel) => string = (appDir, model) =>
    path.join(appDir, model, `${model}.db`);

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

  private key(app: string, model: VisionModel): string {
    return `${app}::${model}`;
  }

  /** Open (create + migrate) and cache the per-(app, model) db. */
  db(app: string, appDir: string, model: VisionModel): Db {
    const cacheKey = this.key(app, model);
    const cached = this.dbs.get(cacheKey);
    if (cached) return cached;
    const file = this.fileFor(appDir, model);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(EVENT_TABLE_DDL[model]);
    db.exec(STREAM_SETTINGS_DDL);
    this.dbs.set(cacheKey, db);
    return db;
  }

  /** Drop every cached handle for an app (all models). */
  close(app: string): void {
    for (const model of Object.keys(EVENT_TABLE) as VisionModel[]) {
      const cacheKey = this.key(app, model);
      const db = this.dbs.get(cacheKey);
      if (!db) continue;
      this.dbs.delete(cacheKey);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stream settings (per room, within a model db)
  // ---------------------------------------------------------------------------

  getSetting(
    app: string,
    appDir: string,
    model: VisionModel,
    room: string,
  ): StreamSettingRow | null {
    const row = this.db(app, appDir, model)
      .prepare(
        'SELECT room, config_json, updated_at FROM stream_settings WHERE room = ?',
      )
      .get(room) as
      | { room: string; config_json: string; updated_at: string }
      | undefined;
    return row ? mapSetting(row) : null;
  }

  /** Upsert a per-room settings row; returns the stored shape. */
  putSetting(
    app: string,
    appDir: string,
    model: VisionModel,
    room: string,
    config: ModelConfig,
  ): StreamSettingRow {
    this.db(app, appDir, model)
      .prepare(
        `INSERT INTO stream_settings (room, config_json, updated_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(room) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(room, JSON.stringify(config ?? {}));
    return this.getSetting(app, appDir, model, room) as StreamSettingRow;
  }

  // ---------------------------------------------------------------------------
  // Event ingest (one method per table, each prunes old rows)
  // ---------------------------------------------------------------------------

  recordOccupancy(
    app: string,
    appDir: string,
    room: string,
    _event: string,
    d: Record<string, unknown>,
  ): void {
    const db = this.db(app, appDir, 'occupancy');
    db.prepare(
      `INSERT INTO occupancy_sessions (room, zone, tag, kind, node_id, duration_sec)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      room,
      str(d.zone),
      str(d.tag),
      str(d.kind),
      str(d.nodeId),
      num(d.durationSec),
    );
    this.prune(db, 'occupancy_sessions');
  }

  recordCount(
    app: string,
    appDir: string,
    room: string,
    event: string,
    d: Record<string, unknown>,
  ): void {
    const db = this.db(app, appDir, 'counting');
    const direction = event === 'count.in' ? 'in' : event === 'count.out' ? 'out' : null;
    db.prepare(
      `INSERT INTO count_events (room, line, tag, direction, track_id, inside)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      room,
      str(d.line),
      str(d.tag),
      direction,
      str(d.trackId),
      num(d.inside),
    );
    this.prune(db, 'count_events');
  }

  recordCrowd(
    app: string,
    appDir: string,
    room: string,
    event: string,
    d: Record<string, unknown>,
  ): void {
    const db = this.db(app, appDir, 'crowd');
    db.prepare(
      `INSERT INTO crowd_events (room, zone, tag, count, threshold, alert, snapshot_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      room,
      str(d.zone),
      str(d.tag),
      num(d.count),
      num(d.threshold),
      event === 'crowd.threshold' ? 1 : 0,
      str(d.snapshotUrl),
    );
    this.prune(db, 'crowd_events');
  }

  recordDemography(
    app: string,
    appDir: string,
    room: string,
    _event: string,
    d: Record<string, unknown>,
  ): void {
    const db = this.db(app, appDir, 'demography');
    db.prepare(
      `INSERT INTO demography_events (room, tag, age, age_range, gender, emotion, engine)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      room,
      str(d.tag),
      num(d.age),
      str(d.ageRange),
      str(d.gender),
      str(d.emotion),
      str(d.engine),
    );
    this.prune(db, 'demography_events');
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Recent events for a model, newest first (capped). */
  recentEvents(
    app: string,
    appDir: string,
    model: VisionModel,
    limit: number,
  ): VisionEventRow[] {
    const db = this.db(app, appDir, model);
    const cap = Math.max(1, Math.min(1000, Math.floor(limit) || 50));
    const table = EVENT_TABLE[model];
    const rows = db
      .prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT ?`)
      .all(cap) as Record<string, unknown>[];
    return rows.map((r) => mapEvent(model, r));
  }

  /** Count of rows since an ISO cutoff for a model (the "today" tiles). */
  countSince(
    app: string,
    appDir: string,
    model: VisionModel,
    sinceIso: string,
  ): number {
    const table = EVENT_TABLE[model];
    const row = this.db(app, appDir, model)
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ts >= ?`)
      .get(sinceIso) as { n: number };
    return row.n;
  }

  /** Delete rows older than {@link RETENTION_DAYS} in a table. */
  private prune(db: Db, table: string): void {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
    db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoff);
  }
}

// ---------------------------------------------------------------------------
// Mappers / coercers
// ---------------------------------------------------------------------------

function mapSetting(r: {
  room: string;
  config_json: string;
  updated_at: string;
}): StreamSettingRow {
  let config: ModelConfig = {};
  try {
    const parsed = JSON.parse(r.config_json ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as ModelConfig;
    }
  } catch {
    /* corrupt cell → empty */
  }
  return {
    room: r.room,
    config,
    updatedAt: r.updated_at,
  };
}

function mapEvent(model: VisionModel, r: Record<string, unknown>): VisionEventRow {
  const { id, room, tag, ts, ...rest } = r;
  const event =
    model === 'counting'
      ? rest.direction === 'in'
        ? 'count.in'
        : rest.direction === 'out'
          ? 'count.out'
          : 'count.occupancy'
      : model === 'crowd'
        ? rest.alert
          ? 'crowd.threshold'
          : 'crowd.count'
        : model === 'occupancy'
          ? rest.ended_at
            ? 'occupancy.session_ended'
            : 'occupancy.session_started'
          : 'demography.face';
  return {
    id: Number(id),
    model,
    event,
    room: String(room ?? ''),
    tag: typeof tag === 'string' ? tag : null,
    ts: String(ts ?? ''),
    data: rest,
  };
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

function num(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
