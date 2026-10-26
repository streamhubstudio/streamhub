import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';

/**
 * The role this StreamHub core plays in a cluster.
 *
 *  - `standalone` — a lone node that is its own master (the default; login works).
 *  - `master`     — the cluster origin that owns the global SQLite + serves the
 *                   dashboard; login works.
 *  - `edge`       — a worker node fronted by (and managed from) a master. Login
 *                   is DISABLED on an edge — operators sign in at the master.
 */
export type NodeRole = 'standalone' | 'master' | 'edge';

/** All valid roles (used to coerce untrusted KV / env input). */
export const NODE_ROLES: readonly NodeRole[] = [
  'standalone',
  'master',
  'edge',
] as const;

/** Role assumed when nothing is stored/seeded. */
export const DEFAULT_NODE_ROLE: NodeRole = 'standalone';

/** `_streamhub_meta` keys owned by this service. */
const META_ROLE_KEY = 'node_role';
const META_MASTER_URL_KEY = 'master_url';
const META_MASTER_NODE_ID_KEY = 'master_node_id';

/** Coerce an arbitrary string to a known role, falling back to standalone. */
export function coerceNodeRole(raw: string | null | undefined): NodeRole {
  const v = (raw ?? '').trim().toLowerCase();
  return (NODE_ROLES as readonly string[]).includes(v)
    ? (v as NodeRole)
    : DEFAULT_NODE_ROLE;
}

/**
 * DB-driven cluster ROLE for this node (CLUSTER-ROADMAP §5, step 1).
 *
 * The source of truth is the global `_streamhub_meta` KV (already migrated) —
 * key `node_role` (standalone|master|edge) + `master_url`. Kept out of the
 * numbered DDL migrations (like the per-app split flag) and read/written with
 * direct SQL via `db.global()` so this feature never touches the
 * scaffolder-owned `shared/db`. On first boot (KV empty) it seeds from the env
 * `STREAMHUB_NODE_ROLE` / `STREAMHUB_MASTER_URL`; thereafter the KV is
 * authoritative (so a runtime conversion — join-master / leave — sticks across
 * restarts regardless of the env).
 */
@Injectable()
export class NodeRoleService implements OnModuleInit {
  private readonly logger = new Logger(NodeRoleService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  /** Seed the KV from env on first boot; never crash boot on a hiccup. */
  onModuleInit(): void {
    try {
      this.seedFromEnv();
    } catch (err) {
      this.logger.error(
        `node-role seed failed (continuing): ${(err as Error).message}`,
      );
    }
  }

  /** Current role (KV → default `standalone`). */
  getRole(): NodeRole {
    return coerceNodeRole(this.getMeta(META_ROLE_KEY));
  }

  /** Configured master API base URL, or null when unset/blank. */
  getMasterUrl(): string | null {
    const v = (this.getMeta(META_MASTER_URL_KEY) ?? '').trim();
    return v.length > 0 ? v.replace(/\/+$/, '') : null;
  }

  /** True when this node is a cluster edge (login is locked). */
  isEdge(): boolean {
    return this.getRole() === 'edge';
  }

  /** Persist a new role in the KV (source of truth). */
  setRole(role: NodeRole): void {
    const coerced = coerceNodeRole(role);
    this.setMeta(META_ROLE_KEY, coerced);
    this.logger.log(`node role set to '${coerced}'`);
  }

  /** Persist (or clear, when null/blank) the master URL in the KV. */
  setMasterUrl(url: string | null): void {
    const v = (url ?? '').trim().replace(/\/+$/, '');
    if (v) {
      this.setMeta(META_MASTER_URL_KEY, v);
    } else {
      this.deleteMeta(META_MASTER_URL_KEY);
    }
  }

  /**
   * This edge's node id AT THE MASTER (returned by the master's /cluster/join),
   * used to de-register on leave. Null when this node is not an edge / unknown.
   */
  getMasterNodeId(): string | null {
    const v = (this.getMeta(META_MASTER_NODE_ID_KEY) ?? '').trim();
    return v.length > 0 ? v : null;
  }

  /** Persist (or clear) this edge's node id at the master. */
  setMasterNodeId(id: string | null): void {
    const v = (id ?? '').trim();
    if (v) {
      this.setMeta(META_MASTER_NODE_ID_KEY, v);
    } else {
      this.deleteMeta(META_MASTER_NODE_ID_KEY);
    }
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /**
   * First-boot seed: if `node_role` is not yet in the KV, write it from
   * `STREAMHUB_NODE_ROLE` (coerced, default standalone) and, when supplied,
   * `STREAMHUB_MASTER_URL`. A no-op once the KV holds a role (KV wins over env
   * so a runtime conversion is not undone by a stale env on the next restart).
   */
  private seedFromEnv(): void {
    if (this.getMeta(META_ROLE_KEY) !== undefined) return;
    const role = coerceNodeRole(this.config.env('STREAMHUB_NODE_ROLE'));
    this.setMeta(META_ROLE_KEY, role);
    const masterUrl = (this.config.env('STREAMHUB_MASTER_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (masterUrl) this.setMeta(META_MASTER_URL_KEY, masterUrl);
    this.logger.log(
      `node-role seeded from env: role='${role}'${masterUrl ? ` master='${masterUrl}'` : ''}`,
    );
  }

  private getMeta(key: string): string | undefined {
    try {
      const row = this.db
        .global()
        .prepare('SELECT value FROM _streamhub_meta WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined; // table not created yet
    }
  }

  private setMeta(key: string, value: string): void {
    this.db
      .global()
      .prepare(
        `INSERT INTO _streamhub_meta (key, value, updated_at)
           VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  private deleteMeta(key: string): void {
    this.db.global().prepare('DELETE FROM _streamhub_meta WHERE key = ?').run(key);
  }
}
