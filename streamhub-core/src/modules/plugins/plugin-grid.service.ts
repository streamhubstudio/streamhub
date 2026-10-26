/**
 * STREAMHUB GRID — node selection seam for `placement: 'grid'` plugin workers.
 * (Design: https://streamhub.studio/docs/features/NEXTGEN-ADDONS)
 *
 * GRID generalizes the shipped edge-processing pattern (yolo/deface: core
 * spawns a worker that consumes the feed and POSTs results back) to a REMOTE
 * bring-your-own-GPU node. This service is the ORIGIN half of that contract:
 *
 *   1. NODE REGISTRY — reuses the existing cluster `nodes` table + heartbeat
 *      verbatim. A node becomes a GRID node simply by advertising a `grid`
 *      block inside its heartbeat `stats` (POST /api/v1/nodes/:id/heartbeat):
 *
 *        { "grid": { "gpu": true, "vramGb": 24,
 *                    "capabilities": ["cuda", "whisper", "clip"] } }
 *
 *      No schema change, no new endpoint: the ~4KB stats blob is the
 *      capability manifest. `listGridNodes()` filters the registry down to
 *      active, non-stale nodes that advertise that block.
 *
 *   2. SELECTION — `selectNode(requirements)` matches a worker's declared
 *      `worker.grid` requirements (gpu / minVramGb / capabilities / preferred
 *      regions) against the advertised capabilities. Matching is a pure,
 *      exported function (`matchGridNode`) so it stays unit-testable.
 *
 *   3. DISPATCH — `dispatch()` POSTs a resolved spawn spec to the node's GRID
 *      AGENT (`<node.url>/api/v1/grid/workers`, cluster-token auth). The agent
 *      spawns + supervises the worker with the SAME lifecycle machinery the
 *      local manager uses. On any failure/timeout the manager falls back to a
 *      local spawn, so declaring `grid` is always safe on a single-node install.
 *      Implements the shipped seams:
 *
 *      GRID-1 (remote dispatch) — this service POSTs the { pluginId, appName,
 *        command, args, env, ingestToken } body; the agent returns the remote
 *        worker id.
 *      GRID-2 (remote lifecycle, lite) — `stopRemote()` / `remoteStatus()`
 *        proxy stop/status to the owning node; the manager records the lease
 *        (node + remoteId) on WorkerState.
 *      GRID-3 (result feed-back over the wire) — a remote worker cannot reach
 *        the loopback STREAMHUB_INGEST_URL; the manager resolves the spec with
 *        `ctx.originUrl` (the public base) and injects an absolute ingest URL +
 *        the per-start token into the dispatched env.
 *
 *      TODO GRID-4 (ops surface): `/api/v1/grid/*` management routes + the
 *        `_templates/grid` console panel to observe nodes/leases.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { PluginGridRequirements, PluginNodeInfo } from './plugin.contract';

/**
 * Staleness window for grid eligibility — mirrors the cluster registry's
 * NODE_STALE_AFTER_SECONDS (modules/cluster/cluster.service.ts). Kept as a
 * local constant so the plugins module does not import the cluster module;
 * unify via a shared contract if either value ever needs to diverge.
 */
export const GRID_NODE_STALE_AFTER_SECONDS = 90;

/** How long a dispatch / stop / status HTTP call to a grid node may take. */
export const GRID_DISPATCH_TIMEOUT_MS = 8000;

/** A grid-capable node: registry identity + its advertised capabilities. */
export interface GridNodeView extends PluginNodeInfo {
  gpu: boolean;
  /** Advertised GPU VRAM in GiB; null when the node didn't report it. */
  vramGb: number | null;
  capabilities: string[];
}

/**
 * The resolved spawn spec the origin POSTs to a node's grid agent — the exact
 * body of `POST <node.url>/api/v1/grid/workers`. The plugin's `worker.spawn`
 * closure is already evaluated (against the REMOTE ctx) into command/args/env;
 * the wire carries no closures and no cwd (edge paths differ from the origin).
 */
export interface GridSpawnRequest {
  pluginId: string;
  appName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Per-start ingest token (GRID-3) — the worker echoes it to the origin. */
  ingestToken?: string;
}

/** Outcome of a dispatch attempt. */
export interface GridDispatchResult {
  dispatched: boolean;
  node: PluginNodeInfo;
  /** The remote worker id handed back by the agent when dispatched. */
  remoteId?: string;
  /** Human-readable reason when not dispatched. */
  reason?: string;
}

/** Raw row shape read from the global `nodes` table. */
interface RawNodeRow {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  stats_json: string | null;
}

/**
 * Pure matcher: pick the best grid node for a worker's requirements.
 *
 * Hard filters: gpu, minVramGb (unreported VRAM never satisfies a minimum),
 * capabilities (every required tag must be advertised). Soft preference:
 * `regions` only re-orders — a region miss never disqualifies a node.
 * Deterministic order: preferred-region matches first, then larger VRAM,
 * then name (stable tie-break). Returns null when nothing is eligible.
 */
export function matchGridNode(
  nodes: GridNodeView[],
  req?: PluginGridRequirements,
): GridNodeView | null {
  const needGpu = req?.gpu === true || (req?.minVramGb ?? 0) > 0;
  const eligible = nodes.filter((n) => {
    if (needGpu && !n.gpu) return false;
    if (req?.minVramGb !== undefined && req.minVramGb > 0) {
      if (n.vramGb === null || n.vramGb < req.minVramGb) return false;
    }
    for (const cap of req?.capabilities ?? []) {
      if (!n.capabilities.includes(cap)) return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;

  const preferred = new Set(req?.regions ?? []);
  const rank = (n: GridNodeView): number =>
    n.region !== null && preferred.has(n.region) ? 0 : 1;
  eligible.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.vramGb ?? -1) - (a.vramGb ?? -1) ||
      a.name.localeCompare(b.name),
  );
  return eligible[0];
}

@Injectable()
export class PluginGridService {
  private readonly logger = new Logger(PluginGridService.name);

  constructor(
    private readonly db: DbService,
    // Optional so existing manual constructions (unit specs) keep compiling;
    // under Nest DI the @Global ConfigService singleton is injected. Only the
    // remote-dispatch path (dispatch/stopRemote/remoteStatus) reads it.
    private readonly config?: ConfigService,
  ) {}

  /**
   * Every ACTIVE, non-stale registry node that advertises a `grid` stats
   * block. A malformed/absent block simply excludes the node — never throws.
   */
  listGridNodes(): GridNodeView[] {
    const rows = this.db
      .global()
      .prepare(
        `SELECT id, name, url, region, stats_json
           FROM nodes
          WHERE status = 'active'
            AND last_seen_at IS NOT NULL
            AND (julianday('now') - julianday(last_seen_at)) * 86400
                  <= ${GRID_NODE_STALE_AFTER_SECONDS}
          ORDER BY name ASC`,
      )
      .all() as RawNodeRow[];

    const out: GridNodeView[] = [];
    for (const r of rows) {
      const grid = this.parseGridBlock(r.stats_json);
      if (!grid) continue;
      out.push({
        id: r.id,
        name: r.name,
        url: r.url,
        region: r.region,
        gpu: grid.gpu === true,
        vramGb: typeof grid.vramGb === 'number' ? grid.vramGb : null,
        capabilities: Array.isArray(grid.capabilities)
          ? grid.capabilities.filter((c): c is string => typeof c === 'string')
          : [],
      });
    }
    return out;
  }

  /** Best eligible grid node for the requirements, or null. */
  selectNode(req?: PluginGridRequirements): GridNodeView | null {
    return matchGridNode(this.listGridNodes(), req);
  }

  /**
   * GRID-1 — dispatch a resolved spawn spec to a node's grid agent. POSTs to
   * `<node.url>/api/v1/grid/workers` with the cluster token; on `{ id }` back
   * returns `{ dispatched: true, remoteId }`. NEVER throws — any transport
   * error, non-2xx, missing url/token or timeout yields `dispatched: false`
   * with a reason, and the manager falls back to a local spawn.
   */
  async dispatch(
    node: PluginNodeInfo,
    req: GridSpawnRequest,
  ): Promise<GridDispatchResult> {
    const base = this.normalizeNodeUrl(node.url);
    if (!base) {
      return { dispatched: false, node, reason: 'node has no usable http(s) url' };
    }
    const token = this.config?.clusterToken ?? '';
    if (!token) {
      return { dispatched: false, node, reason: 'STREAMHUB_CLUSTER_TOKEN unset' };
    }
    try {
      const res = await this.fetchNode(`${base}/api/v1/grid/workers`, token, {
        method: 'POST',
        body: JSON.stringify({
          pluginId: req.pluginId,
          appName: req.appName,
          command: req.command,
          args: req.args,
          env: req.env,
          ingestToken: req.ingestToken,
        }),
      });
      if (!res.ok) {
        return { dispatched: false, node, reason: `agent returned HTTP ${res.status}` };
      }
      const remoteId = this.readWorkerId(await this.safeJson(res));
      if (!remoteId) {
        return { dispatched: false, node, reason: 'agent did not return a worker id' };
      }
      this.logger.log(
        `grid dispatch OK (plugin '${req.pluginId}', app '${req.appName}', ` +
          `node '${node.name}', remote '${remoteId}')`,
      );
      return { dispatched: true, node, remoteId };
    } catch (err) {
      return {
        dispatched: false,
        node,
        reason: `dispatch error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * GRID-2 (lite) — ask the owning node to stop a remote worker. Best-effort:
   * returns false on any failure (the origin already marks the lease stopped).
   */
  async stopRemote(node: PluginNodeInfo, remoteId: string): Promise<boolean> {
    const base = this.normalizeNodeUrl(node.url);
    const token = this.config?.clusterToken ?? '';
    if (!base || !token) return false;
    try {
      const res = await this.fetchNode(
        `${base}/api/v1/grid/workers/${encodeURIComponent(remoteId)}/stop`,
        token,
        { method: 'POST' },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * GRID-2 (lite) — fetch the live status of a remote worker from its node.
   * Returns the parsed status object, or null on any failure.
   */
  async remoteStatus(
    node: PluginNodeInfo,
    remoteId: string,
  ): Promise<Record<string, unknown> | null> {
    const base = this.normalizeNodeUrl(node.url);
    const token = this.config?.clusterToken ?? '';
    if (!base || !token) return null;
    try {
      const res = await this.fetchNode(
        `${base}/api/v1/grid/workers/${encodeURIComponent(remoteId)}/status`,
        token,
        { method: 'GET' },
      );
      if (!res.ok) return null;
      const body = await this.safeJson(res);
      const data = (body as { data?: unknown })?.data;
      return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Single fetch with a bounded timeout + the cluster-token + JSON headers. */
  private async fetchNode(
    url: string,
    token: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      GRID_DISPATCH_TIMEOUT_MS,
    );
    try {
      return await fetch(url, {
        method: init.method,
        headers: {
          'content-type': 'application/json',
          'x-cluster-token': token,
        },
        body: init.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Read the remote worker id out of the agent's `{ data: { id } }` envelope. */
  private readWorkerId(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const data = (body as { data?: unknown }).data;
    const id =
      data && typeof data === 'object'
        ? (data as { id?: unknown }).id
        : (body as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  /**
   * Validate + normalize a node url to an http(s) origin (SSRF guard, roadmap
   * §2 P2): only http/https are accepted; anything else → null (dispatch
   * declines and the manager falls back to local).
   */
  private normalizeNodeUrl(url: string | null): string | null {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }

  /** Parse the `grid` block out of a stats blob; anything malformed → null. */
  private parseGridBlock(
    json: string | null,
  ): Record<string, unknown> | null {
    if (!json) return null;
    try {
      const stats = JSON.parse(json) as unknown;
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
        return null;
      }
      const grid = (stats as Record<string, unknown>).grid;
      return grid && typeof grid === 'object' && !Array.isArray(grid)
        ? (grid as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
