/**
 * Per-app fleet persistence — `apps/<app>/fleet/fleet.db` (its own SQLite file,
 * NOT app.db). Opened lazily with better-sqlite3 (same engine as DbService) and
 * cached per app. Owns three tables:
 *
 *   agents           — registry: one row per agent, latest status + telemetry.
 *   telemetry_history — rolling per-agent metric samples (pruned to a cap).
 *   commands         — issued commands + their (async) results.
 *
 * The store is a thin, synchronous repository (like AppPluginsRepository); all
 * MQTT wiring lives in FleetService. Kept as a standalone file DB so a fleet of
 * hundreds of agents' history never bloats the app.db hot path.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type { Db } from '../../shared/db/db.service';
import type { AgentTelemetry, FleetCommandResult } from './fleet.protocol';

export interface AgentRow {
  agentId: string;
  status: 'online' | 'offline';
  version: string | null;
  firstSeen: string;
  lastSeen: string;
  lastStatusAt: string | null;
  telemetry: AgentTelemetry | null;
}

export interface HistoryPoint {
  ts: string;
  cpu: number | null;
  mem: number | null;
  temp: number | null;
  disk: number | null;
  cameras: number | null;
}

export interface CommandRow {
  id: string;
  agentId: string;
  command: string;
  args: Record<string, unknown>;
  status: 'pending' | 'ok' | 'error';
  result: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'offline',
  version       TEXT,
  first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  last_status_at TEXT,
  telemetry_json TEXT
);
CREATE TABLE IF NOT EXISTS telemetry_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  TEXT NOT NULL,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  cpu       REAL,
  mem       REAL,
  temp      REAL,
  disk      REAL,
  cameras   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hist_agent_ts ON telemetry_history(agent_id, id);
CREATE TABLE IF NOT EXISTS commands (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  command     TEXT NOT NULL,
  args_json   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cmd_agent ON commands(agent_id, created_at);
`;

@Injectable()
export class FleetStore implements OnModuleDestroy {
  private readonly dbs = new Map<string, Db>();
  /** Test seam: override the file path resolver (default = <appDir>/fleet/fleet.db). */
  fileFor: (appDir: string) => string = (appDir) =>
    path.join(appDir, 'fleet', 'fleet.db');

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

  /** Open (create + migrate) and cache the per-app fleet.db. */
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

  /** Drop a cached handle (app deleted / fleet disabled). */
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
  // Telemetry ingest
  // ---------------------------------------------------------------------------

  /**
   * Record a telemetry sample: upsert the agent registry row (→ online) and
   * append a history point, pruning the agent's history to `historyCap`.
   */
  recordTelemetry(
    app: string,
    appDir: string,
    agentId: string,
    t: AgentTelemetry,
    historyCap: number,
  ): void {
    const db = this.db(app, appDir);
    const now = new Date().toISOString();
    const version = typeof t.agentVersion === 'string' ? t.agentVersion : null;
    db.prepare(
      `INSERT INTO agents (agent_id, status, version, first_seen, last_seen, telemetry_json)
         VALUES (?, 'online', ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = 'online',
         version = COALESCE(excluded.version, agents.version),
         last_seen = excluded.last_seen,
         telemetry_json = excluded.telemetry_json`,
    ).run(agentId, version, now, now, JSON.stringify(t));

    db.prepare(
      `INSERT INTO telemetry_history (agent_id, ts, cpu, mem, temp, disk, cameras)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      now,
      numOrNull(t.cpu),
      numOrNull(t.mem),
      numOrNull(t.temp),
      numOrNull(t.disk),
      numOrNull(t.cameras),
    );

    // Prune history beyond the cap (keep the newest `historyCap` rows).
    const cap = Math.max(1, Math.floor(historyCap));
    db.prepare(
      `DELETE FROM telemetry_history
         WHERE agent_id = ?
           AND id NOT IN (
             SELECT id FROM telemetry_history
              WHERE agent_id = ? ORDER BY id DESC LIMIT ?
           )`,
    ).run(agentId, agentId, cap);
  }

  /** Apply an explicit status message (online/offline; LWT delivers offline). */
  setStatus(
    app: string,
    appDir: string,
    agentId: string,
    status: 'online' | 'offline',
    version: string | null,
  ): void {
    const db = this.db(app, appDir);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (agent_id, status, version, first_seen, last_seen, last_status_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         status = excluded.status,
         version = COALESCE(excluded.version, agents.version),
         last_status_at = excluded.last_status_at,
         last_seen = CASE WHEN excluded.status = 'online'
                          THEN excluded.last_seen ELSE agents.last_seen END`,
    ).run(agentId, status, version, now, now, now);
  }

  /**
   * Mark agents offline whose last_seen is older than `staleMs` (belt-and-
   * suspenders beyond the LWT). Returns the ids flipped.
   */
  reapStale(app: string, appDir: string, staleMs: number): string[] {
    const db = this.db(app, appDir);
    const cutoff = new Date(Date.now() - Math.max(1000, staleMs)).toISOString();
    const rows = db
      .prepare(
        `SELECT agent_id FROM agents WHERE status = 'online' AND last_seen < ?`,
      )
      .all(cutoff) as { agent_id: string }[];
    if (rows.length) {
      db.prepare(
        `UPDATE agents SET status = 'offline' WHERE status = 'online' AND last_seen < ?`,
      ).run(cutoff);
    }
    return rows.map((r) => r.agent_id);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  listAgents(app: string, appDir: string): AgentRow[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT agent_id, status, version, first_seen, last_seen, last_status_at, telemetry_json
           FROM agents ORDER BY agent_id ASC`,
      )
      .all() as RawAgent[];
    return rows.map(mapAgent);
  }

  getAgent(app: string, appDir: string, agentId: string): AgentRow | null {
    const row = this.db(app, appDir)
      .prepare(
        `SELECT agent_id, status, version, first_seen, last_seen, last_status_at, telemetry_json
           FROM agents WHERE agent_id = ?`,
      )
      .get(agentId) as RawAgent | undefined;
    return row ? mapAgent(row) : null;
  }

  history(
    app: string,
    appDir: string,
    agentId: string,
    limit: number,
  ): HistoryPoint[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT ts, cpu, mem, temp, disk, cameras FROM telemetry_history
           WHERE agent_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(agentId, Math.max(1, Math.min(1000, limit))) as HistRow[];
    // Return oldest→newest for charting.
    return rows
      .map((r) => ({
        ts: r.ts,
        cpu: r.cpu,
        mem: r.mem,
        temp: r.temp,
        disk: r.disk,
        cameras: r.cameras,
      }))
      .reverse();
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  recordCommand(
    app: string,
    appDir: string,
    id: string,
    agentId: string,
    command: string,
    args: Record<string, unknown>,
  ): void {
    this.db(app, appDir)
      .prepare(
        `INSERT INTO commands (id, agent_id, command, args_json, status)
           VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(id, agentId, command, JSON.stringify(args));
  }

  /** Resolve a pending command from an agent's cmd/result message. */
  resolveCommand(
    app: string,
    appDir: string,
    result: FleetCommandResult,
  ): boolean {
    const status = result.ok ? 'ok' : 'error';
    const info = this.db(app, appDir)
      .prepare(
        `UPDATE commands
            SET status = ?, result_json = ?, resolved_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(status, JSON.stringify(result), new Date().toISOString(), result.id);
    return info.changes > 0;
  }

  getCommand(app: string, appDir: string, id: string): CommandRow | null {
    const row = this.db(app, appDir)
      .prepare(
        `SELECT id, agent_id, command, args_json, status, result_json, created_at, resolved_at
           FROM commands WHERE id = ?`,
      )
      .get(id) as RawCommand | undefined;
    return row ? mapCommand(row) : null;
  }

  commandsFor(
    app: string,
    appDir: string,
    agentId: string,
    limit = 20,
  ): CommandRow[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT id, agent_id, command, args_json, status, result_json, created_at, resolved_at
           FROM commands WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, Math.max(1, Math.min(200, limit))) as RawCommand[];
    return rows.map(mapCommand);
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface RawAgent {
  agent_id: string;
  status: string;
  version: string | null;
  first_seen: string;
  last_seen: string;
  last_status_at: string | null;
  telemetry_json: string | null;
}
interface HistRow {
  ts: string;
  cpu: number | null;
  mem: number | null;
  temp: number | null;
  disk: number | null;
  cameras: number | null;
}
interface RawCommand {
  id: string;
  agent_id: string;
  command: string;
  args_json: string | null;
  status: string;
  result_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

function mapAgent(r: RawAgent): AgentRow {
  let telemetry: AgentTelemetry | null = null;
  if (r.telemetry_json) {
    try {
      telemetry = JSON.parse(r.telemetry_json) as AgentTelemetry;
    } catch {
      telemetry = null;
    }
  }
  return {
    agentId: r.agent_id,
    status: r.status === 'online' ? 'online' : 'offline',
    version: r.version,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    lastStatusAt: r.last_status_at,
    telemetry,
  };
}

function mapCommand(r: RawCommand): CommandRow {
  return {
    id: r.id,
    agentId: r.agent_id,
    command: r.command,
    args: parseObj(r.args_json),
    status: r.status === 'ok' ? 'ok' : r.status === 'error' ? 'error' : 'pending',
    result: r.result_json ? parseObj(r.result_json) : null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

function parseObj(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const o = JSON.parse(json);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
