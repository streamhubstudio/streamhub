/**
 * Per-app live-control persistence — `apps/<app>/live-control/live-control.db`
 * (its own SQLite file, NOT app.db). Opened lazily with better-sqlite3 (same
 * engine as DbService) and cached per app — the exact shape used by FleetStore.
 * Owns three tables:
 *
 *   stream_state  — per-stream state machine row (live | paused | finished) plus
 *                   the resolved per-stream cover override. A row exists ONLY
 *                   once a stream has been acted on; ABSENT ⇒ the default `live`.
 *   assets        — uploaded cover assets (image/video) that live in the app S3.
 *   app_settings  — tiny KV for per-app dynamic defaults that reference an asset
 *                   id (defaultPauseAssetId / defaultFinishAssetId).
 *
 * The store is a thin synchronous repository (no I/O beyond SQLite); all S3 /
 * LiveKit / callbacks wiring lives in LiveControlService.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type { Db } from '../../shared/db/db.service';

/** The three viewer-facing states of a stream. Absent row ⇒ `live`. */
export type LiveControlState = 'live' | 'paused' | 'finished';
/** How the cover renders while paused/finished. */
export type CoverMode = 'image' | 'video' | 'text';
/** Kind of an uploaded asset. */
export type AssetKind = 'image' | 'video';

/** A per-stream state row (camelCase view). */
export interface StreamStateRow {
  streamId: string;
  state: LiveControlState;
  /** Per-stream cover override (null ⇒ fall back to the app default). */
  mode: CoverMode | null;
  assetId: number | null;
  cardTitle: string | null;
  cardText: string | null;
  cardColor: string | null;
  room: string | null;
  since: string;
  updatedAt: string;
}

/** An uploaded cover asset (camelCase view). */
export interface AssetRow {
  id: number;
  kind: AssetKind;
  s3Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  label: string | null;
  createdAt: string;
}

/** Partial per-stream override applied on a transition (only present fields). */
export interface StreamOverride {
  mode?: CoverMode | null;
  assetId?: number | null;
  cardTitle?: string | null;
  cardText?: string | null;
  cardColor?: string | null;
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS stream_state (
  stream_id   TEXT PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'live',
  mode        TEXT,
  asset_id    INTEGER,
  card_title  TEXT,
  card_text   TEXT,
  card_color  TEXT,
  room        TEXT,
  since       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  s3_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_settings (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

@Injectable()
export class LiveControlStore implements OnModuleDestroy {
  private readonly dbs = new Map<string, Db>();
  /** Test seam: override the file path resolver (default = <appDir>/live-control/live-control.db). */
  fileFor: (appDir: string) => string = (appDir) =>
    path.join(appDir, 'live-control', 'live-control.db');

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

  /** Open (create + migrate) and cache the per-app live-control.db. */
  db(app: string, appDir: string): Db {
    const cached = this.dbs.get(app);
    if (cached) return cached;
    const file = this.fileFor(appDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(MIGRATION);
    this.dbs.set(app, db);
    return db;
  }

  /** Drop a cached handle (app deleted / plugin disabled). */
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
  // Stream state
  // ---------------------------------------------------------------------------

  /** Current state row, or null when the stream has never been acted on (=live). */
  getState(app: string, appDir: string, streamId: string): StreamStateRow | null {
    const row = this.db(app, appDir)
      .prepare('SELECT * FROM stream_state WHERE stream_id = ?')
      .get(streamId) as RawState | undefined;
    return row ? mapState(row) : null;
  }

  /** Every non-live state row (paused/finished), for the operator list overlay. */
  listStates(app: string, appDir: string): StreamStateRow[] {
    const rows = this.db(app, appDir)
      .prepare('SELECT * FROM stream_state ORDER BY updated_at DESC')
      .all() as RawState[];
    return rows.map(mapState);
  }

  /**
   * Upsert a transition: set the new `state` and apply any per-stream override
   * fields present in `override` (missing fields are preserved on an existing
   * row; on `resume` the override is empty so the previous cover choice is kept
   * but simply not shown). Returns the resulting row.
   */
  setState(
    app: string,
    appDir: string,
    streamId: string,
    state: LiveControlState,
    room: string | null,
    override: StreamOverride = {},
  ): StreamStateRow {
    const db = this.db(app, appDir);
    const now = new Date().toISOString();
    const existing = this.getState(app, appDir, streamId);

    const next = {
      mode: pick(override.mode, existing?.mode ?? null),
      assetId: pick(override.assetId, existing?.assetId ?? null),
      cardTitle: pick(override.cardTitle, existing?.cardTitle ?? null),
      cardText: pick(override.cardText, existing?.cardText ?? null),
      cardColor: pick(override.cardColor, existing?.cardColor ?? null),
      room: room ?? existing?.room ?? null,
    };
    // `since` marks when the CURRENT state began (reset on a real transition).
    const since = existing && existing.state === state ? existing.since : now;

    db.prepare(
      `INSERT INTO stream_state
         (stream_id, state, mode, asset_id, card_title, card_text, card_color, room, since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         state = excluded.state,
         mode = excluded.mode,
         asset_id = excluded.asset_id,
         card_title = excluded.card_title,
         card_text = excluded.card_text,
         card_color = excluded.card_color,
         room = excluded.room,
         since = excluded.since,
         updated_at = excluded.updated_at`,
    ).run(
      streamId,
      state,
      next.mode,
      next.assetId,
      next.cardTitle,
      next.cardText,
      next.cardColor,
      next.room,
      since,
      now,
    );
    return this.getState(app, appDir, streamId) as StreamStateRow;
  }

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------

  listAssets(app: string, appDir: string): AssetRow[] {
    const rows = this.db(app, appDir)
      .prepare('SELECT * FROM assets ORDER BY created_at DESC, id DESC')
      .all() as RawAsset[];
    return rows.map(mapAsset);
  }

  getAsset(app: string, appDir: string, id: number): AssetRow | null {
    const row = this.db(app, appDir)
      .prepare('SELECT * FROM assets WHERE id = ?')
      .get(id) as RawAsset | undefined;
    return row ? mapAsset(row) : null;
  }

  addAsset(
    app: string,
    appDir: string,
    input: Omit<AssetRow, 'id' | 'createdAt'>,
  ): AssetRow {
    const res = this.db(app, appDir)
      .prepare(
        `INSERT INTO assets (kind, s3_key, filename, content_type, size_bytes, label)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.s3Key,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.label,
      );
    return this.getAsset(app, appDir, Number(res.lastInsertRowid)) as AssetRow;
  }

  /** Remove an asset row. Returns the removed row (for its S3 key) or null. */
  removeAsset(app: string, appDir: string, id: number): AssetRow | null {
    const row = this.getAsset(app, appDir, id);
    if (!row) return null;
    this.db(app, appDir).prepare('DELETE FROM assets WHERE id = ?').run(id);
    return row;
  }

  // ---------------------------------------------------------------------------
  // Per-app settings (KV)
  // ---------------------------------------------------------------------------

  getSettings(app: string, appDir: string): Record<string, string> {
    const rows = this.db(app, appDir)
      .prepare('SELECT k, v FROM app_settings')
      .all() as { k: string; v: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.k] = r.v;
    return out;
  }

  setSetting(app: string, appDir: string, key: string, value: string | null): void {
    const db = this.db(app, appDir);
    if (value === null) {
      db.prepare('DELETE FROM app_settings WHERE k = ?').run(key);
      return;
    }
    db.prepare(
      `INSERT INTO app_settings (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(key, value);
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface RawState {
  stream_id: string;
  state: string;
  mode: string | null;
  asset_id: number | null;
  card_title: string | null;
  card_text: string | null;
  card_color: string | null;
  room: string | null;
  since: string;
  updated_at: string;
}

interface RawAsset {
  id: number;
  kind: string;
  s3_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  label: string | null;
  created_at: string;
}

function mapState(r: RawState): StreamStateRow {
  return {
    streamId: r.stream_id,
    state:
      r.state === 'paused' ? 'paused' : r.state === 'finished' ? 'finished' : 'live',
    mode: normMode(r.mode),
    assetId: typeof r.asset_id === 'number' ? r.asset_id : null,
    cardTitle: r.card_title,
    cardText: r.card_text,
    cardColor: r.card_color,
    room: r.room,
    since: r.since,
    updatedAt: r.updated_at,
  };
}

function mapAsset(r: RawAsset): AssetRow {
  return {
    id: r.id,
    kind: r.kind === 'video' ? 'video' : 'image',
    s3Key: r.s3_key,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    label: r.label,
    createdAt: r.created_at,
  };
}

function normMode(v: string | null): CoverMode | null {
  return v === 'image' || v === 'video' || v === 'text' ? v : null;
}

/** Prefer the override value when the field is present (incl. explicit null). */
function pick<T>(override: T | undefined, fallback: T): T {
  return override === undefined ? fallback : override;
}
