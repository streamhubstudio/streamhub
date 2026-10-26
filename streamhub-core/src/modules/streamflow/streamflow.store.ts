/**
 * Per-app Streamflow persistence — `apps/<app>/streamflow/streamflow.db` (its
 * own SQLite file, NOT app.db). Opened lazily with better-sqlite3 (same engine
 * as DbService) and cached per app. Mirrors the FleetStore shape (thin,
 * synchronous repository; all engine wiring lives in the service/runner). Owns:
 *
 *   workflows  — one row per saved workflow (name + enabled + graph_json).
 *   runs       — one row per execution (trigger + status + timing + error).
 *   run_steps  — per-box step record within a run (in/out/ms/error).
 *   ai_usage   — per calendar-month estimated AI spend (budget guard state).
 *
 * History (runs + run_steps) is bounded: `pruneHistory` deletes runs older than
 * a retention window (default 30d) and cascades their steps.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import type { Db } from '../../shared/db/db.service';

export type RunStatus = 'queued' | 'running' | 'ok' | 'failed';
export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface WorkflowRow {
  id: string;
  name: string;
  enabled: boolean;
  graph: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: string;
  workflowId: string;
  triggerEvent: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface StepRow {
  id: string;
  runId: string;
  boxId: string;
  boxType: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  ms: number | null;
  error: string | null;
}

const RETENTION_DAYS_DEFAULT = 30;

const MIGRATION = `
CREATE TABLE IF NOT EXISTS workflows (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  graph_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  trigger_event TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued',
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_wf ON runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  box_id      TEXT NOT NULL,
  box_type    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ok',
  input_json  TEXT,
  output_json TEXT,
  ms          INTEGER,
  error       TEXT,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id, seq);
CREATE TABLE IF NOT EXISTS ai_usage (
  month    TEXT PRIMARY KEY,
  tokens   INTEGER NOT NULL DEFAULT 0,
  est_usd  REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS secrets (
  name        TEXT PRIMARY KEY,
  value_enc   TEXT NOT NULL,
  last4       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** Public (masked) metadata about a stored secret — NEVER carries the value. */
export interface SecretMetaRow {
  name: string;
  last4: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class StreamflowStore implements OnModuleDestroy {
  private readonly dbs = new Map<string, Db>();
  /** Test seam: override the file path resolver (default = <appDir>/streamflow/streamflow.db). */
  fileFor: (appDir: string) => string = (appDir) =>
    path.join(appDir, 'streamflow', 'streamflow.db');

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

  /** Open (create + migrate) and cache the per-app streamflow.db. */
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
  // Workflows CRUD
  // ---------------------------------------------------------------------------

  createWorkflow(
    app: string,
    appDir: string,
    input: { name: string; enabled?: boolean; graph?: unknown },
  ): WorkflowRow {
    const id = randomUUID();
    this.db(app, appDir)
      .prepare(
        `INSERT INTO workflows (id, name, enabled, graph_json)
           VALUES (?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.name ?? 'Untitled'),
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.graph ?? emptyGraph()),
      );
    return this.getWorkflow(app, appDir, id) as WorkflowRow;
  }

  listWorkflows(app: string, appDir: string): WorkflowRow[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT id, name, enabled, graph_json, created_at, updated_at
           FROM workflows ORDER BY created_at ASC`,
      )
      .all() as RawWorkflow[];
    return rows.map(mapWorkflow);
  }

  /** Enabled workflows only — the hot path for trigger matching. */
  listEnabled(app: string, appDir: string): WorkflowRow[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT id, name, enabled, graph_json, created_at, updated_at
           FROM workflows WHERE enabled = 1 ORDER BY created_at ASC`,
      )
      .all() as RawWorkflow[];
    return rows.map(mapWorkflow);
  }

  getWorkflow(app: string, appDir: string, id: string): WorkflowRow | null {
    const row = this.db(app, appDir)
      .prepare(
        `SELECT id, name, enabled, graph_json, created_at, updated_at
           FROM workflows WHERE id = ?`,
      )
      .get(id) as RawWorkflow | undefined;
    return row ? mapWorkflow(row) : null;
  }

  updateWorkflow(
    app: string,
    appDir: string,
    id: string,
    patch: { name?: string; enabled?: boolean; graph?: unknown },
  ): WorkflowRow | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(String(patch.name));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.graph !== undefined) {
      sets.push('graph_json = ?');
      params.push(JSON.stringify(patch.graph));
    }
    if (sets.length) {
      sets.push("updated_at = datetime('now')");
      params.push(id);
      this.db(app, appDir)
        .prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`)
        .run(...(params as never[]));
    }
    return this.getWorkflow(app, appDir, id);
  }

  deleteWorkflow(app: string, appDir: string, id: string): boolean {
    const db = this.db(app, appDir);
    const info = db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    // Cascade the workflow's run history.
    const runs = db
      .prepare('SELECT id FROM runs WHERE workflow_id = ?')
      .all(id) as { id: string }[];
    for (const r of runs) {
      db.prepare('DELETE FROM run_steps WHERE run_id = ?').run(r.id);
    }
    db.prepare('DELETE FROM runs WHERE workflow_id = ?').run(id);
    return info.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Runs + steps
  // ---------------------------------------------------------------------------

  createRun(
    app: string,
    appDir: string,
    input: { id?: string; workflowId: string; triggerEvent: string; status?: RunStatus },
  ): RunRow {
    const id = input.id ?? randomUUID();
    this.db(app, appDir)
      .prepare(
        `INSERT INTO runs (id, workflow_id, trigger_event, status)
           VALUES (?, ?, ?, ?)`,
      )
      .run(id, input.workflowId, input.triggerEvent, input.status ?? 'queued');
    return this.getRun(app, appDir, id) as RunRow;
  }

  finishRun(
    app: string,
    appDir: string,
    id: string,
    status: RunStatus,
    error: string | null,
  ): void {
    this.db(app, appDir)
      .prepare(
        `UPDATE runs SET status = ?, ended_at = datetime('now'), error = ?
           WHERE id = ?`,
      )
      .run(status, error, id);
  }

  setRunStatus(app: string, appDir: string, id: string, status: RunStatus): void {
    this.db(app, appDir)
      .prepare('UPDATE runs SET status = ? WHERE id = ?')
      .run(status, id);
  }

  getRun(app: string, appDir: string, id: string): RunRow | null {
    const row = this.db(app, appDir)
      .prepare(
        `SELECT id, workflow_id, trigger_event, status, started_at, ended_at, error
           FROM runs WHERE id = ?`,
      )
      .get(id) as RawRun | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(
    app: string,
    appDir: string,
    opts: { workflowId?: string; limit?: number } = {},
  ): RunRow[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    const where = opts.workflowId ? 'WHERE workflow_id = ?' : '';
    const params: unknown[] = opts.workflowId ? [opts.workflowId, limit] : [limit];
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT id, workflow_id, trigger_event, status, started_at, ended_at, error
           FROM runs ${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...(params as never[])) as RawRun[];
    return rows.map(mapRun);
  }

  recordStep(
    app: string,
    appDir: string,
    step: {
      runId: string;
      boxId: string;
      boxType: string;
      status: StepStatus;
      input?: unknown;
      output?: unknown;
      ms?: number | null;
      error?: string | null;
      seq: number;
    },
  ): void {
    this.db(app, appDir)
      .prepare(
        `INSERT INTO run_steps
           (id, run_id, box_id, box_type, status, input_json, output_json, ms, error, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        step.runId,
        step.boxId,
        step.boxType,
        step.status,
        step.input === undefined ? null : safeJson(step.input),
        step.output === undefined ? null : safeJson(step.output),
        typeof step.ms === 'number' ? Math.round(step.ms) : null,
        step.error ?? null,
        step.seq,
      );
  }

  listSteps(app: string, appDir: string, runId: string): StepRow[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT id, run_id, box_id, box_type, status, input_json, output_json, ms, error
           FROM run_steps WHERE run_id = ? ORDER BY seq ASC, rowid ASC`,
      )
      .all(runId) as RawStep[];
    return rows.map(mapStep);
  }

  /** Delete runs (and their steps) older than `retentionDays`. Returns count. */
  pruneHistory(
    app: string,
    appDir: string,
    retentionDays = RETENTION_DAYS_DEFAULT,
  ): number {
    const db = this.db(app, appDir);
    const days = Math.max(1, Math.floor(retentionDays));
    const stale = db
      .prepare(
        `SELECT id FROM runs WHERE started_at < datetime('now', ?)`,
      )
      .all(`-${days} days`) as { id: string }[];
    if (!stale.length) return 0;
    const del = db.prepare('DELETE FROM run_steps WHERE run_id = ?');
    for (const r of stale) del.run(r.id);
    db.prepare(`DELETE FROM runs WHERE started_at < datetime('now', ?)`).run(
      `-${days} days`,
    );
    return stale.length;
  }

  // ---------------------------------------------------------------------------
  // Secrets (per app, encrypted at rest — value_enc is ciphertext, NEVER plain)
  // ---------------------------------------------------------------------------

  /** Upsert an encrypted secret. `valueEnc` MUST already be ciphertext. */
  setSecret(
    app: string,
    appDir: string,
    name: string,
    valueEnc: string,
    last4: string,
  ): void {
    this.db(app, appDir)
      .prepare(
        `INSERT INTO secrets (name, value_enc, last4)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             value_enc  = excluded.value_enc,
             last4      = excluded.last4,
             updated_at = datetime('now')`,
      )
      .run(name, valueEnc, last4);
  }

  /** Masked metadata for every secret (no ciphertext, no value). */
  listSecretMeta(app: string, appDir: string): SecretMetaRow[] {
    const rows = this.db(app, appDir)
      .prepare(
        `SELECT name, last4, created_at, updated_at
           FROM secrets ORDER BY name ASC`,
      )
      .all() as { name: string; last4: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({
      name: r.name,
      last4: r.last4,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** The ciphertext for one secret (internal — run-time resolution only). */
  getSecretEnc(app: string, appDir: string, name: string): string | null {
    const row = this.db(app, appDir)
      .prepare('SELECT value_enc FROM secrets WHERE name = ?')
      .get(name) as { value_enc: string } | undefined;
    return row ? row.value_enc : null;
  }

  /** Remove a secret. Returns true when a row was deleted. */
  deleteSecret(app: string, appDir: string, name: string): boolean {
    const info = this.db(app, appDir)
      .prepare('DELETE FROM secrets WHERE name = ?')
      .run(name);
    return info.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // AI budget (per calendar month)
  // ---------------------------------------------------------------------------

  /** Estimated USD spent this month (0 when nothing recorded). */
  monthlyUsd(app: string, appDir: string, month = currentMonth()): number {
    const row = this.db(app, appDir)
      .prepare('SELECT est_usd FROM ai_usage WHERE month = ?')
      .get(month) as { est_usd: number } | undefined;
    return row ? row.est_usd : 0;
  }

  /** Add estimated usage to the current month bucket (upsert). */
  addUsage(
    app: string,
    appDir: string,
    tokens: number,
    usd: number,
    month = currentMonth(),
  ): void {
    this.db(app, appDir)
      .prepare(
        `INSERT INTO ai_usage (month, tokens, est_usd) VALUES (?, ?, ?)
           ON CONFLICT(month) DO UPDATE SET
             tokens = ai_usage.tokens + excluded.tokens,
             est_usd = ai_usage.est_usd + excluded.est_usd`,
      )
      .run(month, Math.max(0, Math.round(tokens)), Math.max(0, usd));
  }
}

// ---------------------------------------------------------------------------
// Row mappers + helpers
// ---------------------------------------------------------------------------

interface RawWorkflow {
  id: string;
  name: string;
  enabled: number;
  graph_json: string;
  created_at: string;
  updated_at: string;
}
interface RawRun {
  id: string;
  workflow_id: string;
  trigger_event: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}
interface RawStep {
  id: string;
  run_id: string;
  box_id: string;
  box_type: string;
  status: string;
  input_json: string | null;
  output_json: string | null;
  ms: number | null;
  error: string | null;
}

function mapWorkflow(r: RawWorkflow): WorkflowRow {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    graph: parseJson(r.graph_json) ?? emptyGraph(),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapRun(r: RawRun): RunRow {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    triggerEvent: r.trigger_event,
    status: normalizeRunStatus(r.status),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    error: r.error,
  };
}

function mapStep(r: RawStep): StepRow {
  return {
    id: r.id,
    runId: r.run_id,
    boxId: r.box_id,
    boxType: r.box_type,
    status: normalizeStepStatus(r.status),
    input: parseJson(r.input_json),
    output: parseJson(r.output_json),
    ms: r.ms,
    error: r.error,
  };
}

function normalizeRunStatus(s: string): RunStatus {
  return s === 'running' || s === 'ok' || s === 'failed' ? s : 'queued';
}
function normalizeStepStatus(s: string): StepStatus {
  return s === 'failed' || s === 'skipped' ? s : 'ok';
}

function emptyGraph(): { boxes: unknown[]; edges: unknown[] } {
  return { boxes: [], edges: [] };
}

function parseJson(json: string | null): unknown {
  if (json === null || json === undefined) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** JSON.stringify that never throws (circular / BigInt → null). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
