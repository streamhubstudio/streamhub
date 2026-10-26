import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { DbService } from '../../shared/db/db.service';
import type { EdgeAssignment, EdgeAssignmentStatus } from './edge.types';

/** Statuses that count as "occupying" a node (capacity + failover set). */
export const ACTIVE_STATUSES: readonly EdgeAssignmentStatus[] = [
  'offered',
  'running',
] as const;

/** Raw `edge_assignments` row as stored. */
interface RawAssignmentRow {
  id: string;
  node_id: string;
  app: string;
  plugin_id: string;
  stream_id: string | null;
  config_json: string | null;
  status: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields for creating a new assignment. */
export interface CreateAssignmentInput {
  nodeId: string;
  app: string;
  pluginId: string;
  streamId?: string | null;
  config?: Record<string, unknown>;
  status: EdgeAssignmentStatus;
}

/**
 * CRUD over the GLOBAL `edge_assignments` table (the JOIN between the global
 * `nodes` plane and the per-tenant apps). One row = one worker workload placed
 * on one node. Rows survive master restarts so the scheduler can re-offer work
 * to an edge that reconnects.
 *
 * `config_json` stores ONLY the user config; the wire spawn spec is resolved on
 * the fly ({@link resolveSpawnSpec}) and never persisted.
 */
@Injectable()
export class EdgeAssignmentsRepository {
  constructor(private readonly db: DbService) {}

  /** Insert a new assignment (uuid id) and return the enriched row. */
  create(input: CreateAssignmentInput): EdgeAssignment {
    const id = randomUUID();
    this.db
      .global()
      .prepare(
        `INSERT INTO edge_assignments
           (id, node_id, app, plugin_id, stream_id, config_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.nodeId,
        input.app,
        input.pluginId,
        input.streamId ?? null,
        JSON.stringify(input.config ?? {}),
        input.status,
      );
    return this.get(id) as EdgeAssignment;
  }

  /** One assignment by id, or null. */
  get(id: string): EdgeAssignment | null {
    const row = this.db
      .global()
      .prepare('SELECT * FROM edge_assignments WHERE id = ?')
      .get(id) as RawAssignmentRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Every assignment (optionally filtered by app), newest first. */
  list(app?: string): EdgeAssignment[] {
    const db = this.db.global();
    const rows = (
      app
        ? db
            .prepare(
              'SELECT * FROM edge_assignments WHERE app = ? ORDER BY created_at DESC, id ASC',
            )
            .all(app)
        : db
            .prepare(
              'SELECT * FROM edge_assignments ORDER BY created_at DESC, id ASC',
            )
            .all()
    ) as RawAssignmentRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Assignments on a node in the given statuses. */
  listByNode(nodeId: string, statuses?: EdgeAssignmentStatus[]): EdgeAssignment[] {
    const rows = this.db
      .global()
      .prepare('SELECT * FROM edge_assignments WHERE node_id = ?')
      .all(nodeId) as RawAssignmentRow[];
    const mapped = rows.map((r) => this.mapRow(r));
    if (!statuses) return mapped;
    const set = new Set(statuses);
    return mapped.filter((a) => set.has(a.status));
  }

  /** Pending + offered assignments on a node (re-offered when it reconnects). */
  /** Every UNPLACED assignment (status pending, no node) — the retry set. */
  pendingUnplaced(): EdgeAssignment[] {
    const rows = this.db
      .global()
      .prepare(
        "SELECT * FROM edge_assignments WHERE status = 'pending' AND (node_id = '' OR node_id IS NULL) ORDER BY created_at ASC",
      )
      .all() as RawAssignmentRow[];
    return rows.map((r) => this.mapRow(r));
  }

  pendingOrOfferedByNode(nodeId: string): EdgeAssignment[] {
    return this.listByNode(nodeId, ['pending', 'offered']);
  }

  /** Offered + running assignments on a node (the failover set). */
  activeByNode(nodeId: string): EdgeAssignment[] {
    return this.listByNode(nodeId, [...ACTIVE_STATUSES]);
  }

  /** Count of offered+running assignments on a node (the capacity numerator). */
  activeCountByNode(nodeId: string): number {
    const row = this.db
      .global()
      .prepare(
        `SELECT COUNT(*) AS n FROM edge_assignments
          WHERE node_id = ? AND status IN ('offered','running')`,
      )
      .get(nodeId) as { n: number };
    return row.n;
  }

  /** Set an assignment's status (+ optional detail). No-op on unknown id. */
  updateStatus(
    id: string,
    status: EdgeAssignmentStatus,
    detail?: string | null,
  ): void {
    this.db
      .global()
      .prepare(
        `UPDATE edge_assignments
            SET status = ?, detail = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(status, detail ?? null, id);
  }

  /** Move an assignment to another node with a new status (failover). */
  reassign(id: string, nodeId: string, status: EdgeAssignmentStatus): void {
    this.db
      .global()
      .prepare(
        `UPDATE edge_assignments
            SET node_id = ?, status = ?, detail = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(nodeId, status, id);
  }

  private mapRow(r: RawAssignmentRow): EdgeAssignment {
    return {
      id: r.id,
      nodeId: r.node_id,
      app: r.app,
      pluginId: r.plugin_id,
      streamId: r.stream_id,
      config: this.parseConfig(r.config_json),
      status: r.status as EdgeAssignmentStatus,
      detail: r.detail,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private parseConfig(json: string | null): Record<string, unknown> {
    if (!json) return {};
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
