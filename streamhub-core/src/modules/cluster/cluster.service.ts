import {
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { JoinNodeDto } from './dto/join-node.dto';
import { NodeStatus } from './dto/patch-node.dto';

/** Max serialized size of a heartbeat `stats` blob (bytes). Over → 413. */
export const MAX_STATS_BYTES = 4096;

/** A node is considered stale once its last heartbeat is older than this. */
export const NODE_STALE_AFTER_SECONDS = 90;

/**
 * One row of the global `nodes` registry (no secrets). `stats` is the parsed
 * last heartbeat blob (null when never reported / unparseable) and `stale` is
 * derived: true when the node has not been seen within
 * {@link NODE_STALE_AFTER_SECONDS} (drives the status dot in the dashboard).
 */
export interface NodeRow {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  stats: Record<string, unknown> | null;
  stale: boolean;
}

/** Raw `nodes` row as stored, plus the SQL-derived staleness flag (0/1). */
interface RawNodeRow {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  stats_json: string | null;
  stale: number;
}

/** LiveKit bootstrap credentials handed to a joining edge node. */
export interface JoinLiveKit {
  apiKey: string;
  apiSecret: string;
  wsUrl: string;
}

/** Payload returned to a node after a successful join. */
export interface JoinPayload {
  nodeId: string;
  name: string;
  redisUrl: string | null;
  publicWsUrl: string | null;
  livekit: JoinLiveKit;
}

/** Result of a join: the payload plus whether a new row was created (201 vs 200). */
export interface JoinResult {
  created: boolean;
  payload: JoinPayload;
}

/** Fields an operator can patch on a registered node (dashboard manager). */
export interface NodePatch {
  name?: string;
  region?: string;
  status?: NodeStatus;
}

/**
 * Cluster overview for the dashboard manager. `clusterToken` is included on
 * purpose — this is a global/superadmin surface and the operator needs the
 * token to build the join one-liner for a new edge box.
 */
export interface ClusterInfo {
  enabled: boolean;
  nodesCount: number;
  clusterToken: string;
  clusterRedisUrl: string | null;
  joinCommand: string;
}

/**
 * Cluster node registry (edge-node join for the one-liner installer) + the
 * dashboard cluster manager.
 *
 * Owns the global `nodes` table: a joining node upserts BY NAME (keeping its id
 * so a re-run of the installer is idempotent) and gets back the bootstrap
 * config it needs to attach to the LiveKit control plane. Heartbeats keep the
 * node marked `active` and carry an optional free-form `stats` blob. The
 * manager surface lists nodes (with parsed stats + a derived `stale` flag),
 * exposes cluster info (join command) and lets an operator patch/remove a node.
 */
@Injectable()
export class ClusterService {
  private readonly logger = new Logger(ClusterService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Register (or refresh) a node BY NAME. Existing → update url/region/status/
   * last_seen and keep the id; new → mint a UUID. `url` falls back to `ip`.
   */
  join(dto: JoinNodeDto): JoinResult {
    const db = this.db.global();
    const url = dto.url ?? dto.ip;
    const region = dto.region ?? null;

    const existing = db
      .prepare('SELECT id FROM nodes WHERE name = ?')
      .get(dto.name) as { id: string } | undefined;

    let nodeId: string;
    let created: boolean;
    if (existing) {
      nodeId = existing.id;
      created = false;
      db.prepare(
        `UPDATE nodes
           SET url = ?, region = ?, status = 'active',
               last_seen_at = datetime('now')
         WHERE id = ?`,
      ).run(url, region, nodeId);
    } else {
      nodeId = randomUUID();
      created = true;
      db.prepare(
        `INSERT INTO nodes (id, name, url, region, status, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
      ).run(nodeId, dto.name, url, region);
    }

    // Log the join (name + ip only). NEVER log the cluster token or apiSecret.
    this.logger.log(
      `cluster join: name=${dto.name} ip=${dto.ip} nodeId=${nodeId} (${created ? 'new' : 'refresh'})`,
    );

    return {
      created,
      payload: {
        nodeId,
        name: dto.name,
        redisUrl: this.config.clusterRedisUrl || null,
        publicWsUrl: this.config.publicWsUrl || null,
        livekit: {
          apiKey: this.config.livekitApiKey,
          apiSecret: this.config.livekitApiSecret,
          wsUrl: this.config.livekitUrl || 'ws://127.0.0.1:7880',
        },
      },
    };
  }

  /**
   * Mark a node alive and refresh `last_seen_at`. When `stats` is supplied it is
   * persisted verbatim (last-write-wins) after a ~4KB size guard; omitted stats
   * leave the previous blob untouched. Unknown node → 404.
   */
  heartbeat(nodeId: string, stats?: Record<string, unknown>): void {
    const db = this.db.global();

    let res: { changes: number };
    if (stats !== undefined) {
      const json = JSON.stringify(stats);
      if (Buffer.byteLength(json, 'utf8') > MAX_STATS_BYTES) {
        throw new PayloadTooLargeException({
          error: `stats payload too large (max ${MAX_STATS_BYTES} bytes serialized)`,
        });
      }
      res = db
        .prepare(
          `UPDATE nodes
             SET status = 'active', last_seen_at = datetime('now'), stats_json = ?
           WHERE id = ?`,
        )
        .run(json, nodeId);
    } else {
      res = db
        .prepare(
          `UPDATE nodes
             SET status = 'active', last_seen_at = datetime('now')
           WHERE id = ?`,
        )
        .run(nodeId);
    }

    if (res.changes === 0) {
      throw new NotFoundException({ error: 'unknown node' });
    }
  }

  /**
   * Every registered node (no secrets), each with its parsed `stats` and a
   * derived `stale` flag. Ordered oldest-first for a stable manager list.
   */
  listNodes(): NodeRow[] {
    const rows = this.db
      .global()
      .prepare(`${SELECT_NODE} ORDER BY created_at ASC, name ASC`)
      .all() as RawNodeRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /** One node by id (enriched), or throws 404. */
  getNode(id: string): NodeRow {
    const row = this.db
      .global()
      .prepare(`${SELECT_NODE} AND id = ?`)
      .get(id) as RawNodeRow | undefined;
    if (!row) throw new NotFoundException({ error: 'unknown node' });
    return this.mapRow(row);
  }

  /** Cluster overview for the dashboard manager (join command, token, counts). */
  info(): ClusterInfo {
    const token = this.config.clusterToken;
    const nodesCount = (
      this.db.global().prepare('SELECT COUNT(*) AS n FROM nodes').get() as {
        n: number;
      }
    ).n;

    // The server can't know its own public IP at runtime → literal placeholder.
    const masterUrl = this.masterUrl();
    const joinCommand =
      'curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- ' +
      `--join --master-token ${token} --master-ip <THIS_SERVER_IP> ` +
      `--master-url ${masterUrl}`;

    return {
      enabled: token.length > 0,
      nodesCount,
      clusterToken: token,
      clusterRedisUrl: this.config.clusterRedisUrl || null,
      joinCommand,
    };
  }

  /** Remove a node from the registry. Unknown node → 404. */
  removeNode(id: string): void {
    const res = this.db
      .global()
      .prepare('DELETE FROM nodes WHERE id = ?')
      .run(id);
    if (res.changes === 0) {
      throw new NotFoundException({ error: 'unknown node' });
    }
    this.logger.log(`cluster node removed: id=${id}`);
  }

  /**
   * Patch a node's name/region/status (dashboard manager). Unknown node → 404;
   * an empty patch is a no-op. Returns the (enriched) updated row.
   */
  updateNode(id: string, patch: NodePatch): NodeRow {
    const db = this.db.global();
    const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id);
    if (!exists) throw new NotFoundException({ error: 'unknown node' });

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      vals.push(patch.name);
    }
    if (patch.region !== undefined) {
      sets.push('region = ?');
      vals.push(patch.region);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      vals.push(patch.status);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(
        ...vals,
        id,
      );
    }
    return this.getNode(id);
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** Master API base for the join command (STREAMHUB_PUBLIC_URL, sane fallbacks). */
  private masterUrl(): string {
    const raw =
      this.config.env('STREAMHUB_PUBLIC_URL') ||
      this.config.publicBaseUrl ||
      '';
    return raw.replace(/\/+$/, '');
  }

  /** Shape a raw DB row into the public NodeRow (parse stats, derive stale). */
  private mapRow(r: RawNodeRow): NodeRow {
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      region: r.region,
      status: r.status,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      stats: this.parseStats(r.stats_json),
      stale: r.stale === 1,
    };
  }

  /** Parse a stored stats blob; a corrupt/absent blob degrades to null. */
  private parseStats(json: string | null): Record<string, unknown> | null {
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * Shared SELECT for a node row + the SQL-derived `stale` flag (last heartbeat
 * older than the threshold, or never seen). Callers append their own filter/
 * order (`AND id = ?`, `ORDER BY …`). julianday()*86400 = age in seconds.
 */
const SELECT_NODE = `
  SELECT id, name, url, region, status, created_at, last_seen_at, stats_json,
    CASE
      WHEN last_seen_at IS NULL THEN 1
      WHEN (julianday('now') - julianday(last_seen_at)) * 86400
             > ${NODE_STALE_AFTER_SECONDS} THEN 1
      ELSE 0
    END AS stale
  FROM nodes
  WHERE 1 = 1`;
