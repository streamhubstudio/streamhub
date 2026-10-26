import {
  GatewayTimeoutException,
  Inject,
  Injectable,
  Logger,
  Optional,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';

import { ConfigService } from '../../shared/config/config.service';
import { DbService } from '../../shared/db/db.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../shared/contracts';
import { clusterTokenMatches } from '../cluster/cluster-token.util';
import { ClusterService } from '../cluster/cluster.service';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import {
  EDGE_MAX_MISSED_PONGS,
  EDGE_PING_INTERVAL_MS,
  EDGE_WS_PATH,
  frameStr,
  type InboundFrame,
  parseFrame,
  toAssignFrame,
} from './edge.protocol';
import type { EdgeAssignmentStatus } from './edge.types';

/**
 * Cooperative multi-gateway upgrade flag. When more than one WS gateway hangs
 * off the core's single HTTP server, each 'upgrade' listener runs for EVERY
 * upgrade; a catch-all that rejects unknown paths (ws-ingest) must not destroy a
 * socket another gateway has already claimed. Whoever handles an upgrade stamps
 * this on the request; the catch-all checks it before destroying.
 */
export const UPGRADE_HANDLED = '__streamhubUpgradeHandled';

/** Minimal socket seam the gateway drives (real `ws.WebSocket` in prod, a fake in specs). */
export interface EdgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping?(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** Result of authorizing a WS upgrade. */
interface UpgradeDecision {
  ok: boolean;
  nodeId: string;
  code: number;
  message: string;
}

/** One live edge connection. */
interface EdgeConn {
  nodeId: string;
  socket: EdgeSocket;
  role?: string;
  agentVersion?: string;
  capabilities: string[];
  connectedAt: number;
  missedPongs: number;
  closed: boolean;
  pingTimer?: ReturnType<typeof setInterval>;
  /** Outstanding request→reply promises keyed by cmdId/reqId. */
  pending: Map<
    string,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >;
}

/**
 * VISION EDGE control channel — a single held WebSocket per edge node at
 * {@link EDGE_WS_PATH}, hung off the core's HTTP server via the `upgrade` event
 * (same raw-ws pattern as ws-ingest; no socket.io, no main.ts change).
 *
 * OWNS transport only: upgrade auth (`X-Cluster-Token` + a known `nodeId`),
 * one-connection-per-node (newer wins), JSON frame routing, keepalive
 * ping/pong, and request→reply for `cmd`/`log_tail`. Higher-level policy lives
 * in the scheduler + watchdog, which read this gateway's liveness accessors and
 * push frames through {@link send}. The gateway itself depends only on leaf
 * collaborators (config/db/cluster/repo), so nothing here cycles back to the
 * scheduler.
 */
@Injectable()
export class EdgeGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(EdgeGateway.name);
  private wss?: WebSocketServer;
  private attached = false;
  private readonly conns = new Map<string, EdgeConn>();
  /** Last time a node's WS dropped (for failover grace + flap detection). */
  private readonly lastDisconnect = new Map<string, number>();

  constructor(
    // NOTE: plain class type on purpose — a union (`HttpAdapterHost |
    // undefined`) makes TS emit `Object` as the design:type, Nest can't
    // resolve it, and @Optional() then silently injects undefined, leaving
    // the whole edge WS plane dead while REST looks healthy (found live).
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly cluster: ClusterService,
    private readonly assignments: EdgeAssignmentsRepository,
    @Optional()
    @Inject(LOGS_SERVICE)
    private readonly logs?: LogsServiceContract,
  ) {}

  onApplicationBootstrap(): void {
    try {
      const server = this.adapterHost?.httpAdapter?.getHttpServer() as
        | HttpServer
        | undefined;
      if (server && typeof server.on === 'function') {
        this.attach(server);
      } else {
        // NEVER skip silently: without the upgrade hook the whole edge plane
        // is dead while the REST surface looks healthy.
        this.logger.warn(
          `edge gateway NOT attached (adapterHost=${!!this.adapterHost} httpAdapter=${!!this
            .adapterHost?.httpAdapter} server=${!!server})`,
        );
      }
    } catch (err) {
      this.logger.warn(`edge gateway not attached: ${String(err)}`);
    }
  }

  onApplicationShutdown(): void {
    for (const conn of this.conns.values()) {
      this.clearConn(conn);
      try {
        conn.socket.terminate();
      } catch {
        /* shutting down */
      }
    }
    this.conns.clear();
    try {
      this.wss?.close();
    } catch {
      /* shutting down */
    }
  }

  /** Attach the edge upgrade router to an HTTP server. Idempotent. */
  attach(server: HttpServer): void {
    if (this.attached) return;
    this.attached = true;
    this.wss = new WebSocketServer({ noServer: true });

    server.on(
      'upgrade',
      (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (pathname !== EDGE_WS_PATH) return; // not ours — another listener handles it
        // Claim this upgrade so a cooperative catch-all won't destroy the socket.
        (req as unknown as Record<string, boolean>)[UPGRADE_HANDLED] = true;

        const decision = this.authorizeUpgrade(req);
        if (!decision.ok) {
          this.rejectUpgrade(socket, decision.code, decision.message);
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.accept(decision.nodeId, ws as unknown as EdgeSocket);
        });
      },
    );
    this.logger.log(`edge gateway listening on ${EDGE_WS_PATH}`);
  }

  // ==========================================================================
  // Upgrade auth
  // ==========================================================================

  /**
   * Authorize a WS upgrade: cluster disabled → 503; wrong/absent token → 401
   * (timing-safe, same util the cluster HTTP plane uses); missing nodeId → 400;
   * unknown nodeId → 404. The token is read from `X-Cluster-Token` or `?token=`.
   */
  authorizeUpgrade(req: {
    url?: string;
    headers?: Record<string, unknown>;
  }): UpgradeDecision {
    const url = req.url ?? '';
    const q = EdgeGateway.query(url);
    const header = req.headers?.['x-cluster-token'];
    const token =
      (typeof header === 'string' ? header : undefined) ??
      q.get('token') ??
      undefined;

    if (!this.config.clusterToken) {
      return { ok: false, nodeId: '', code: 503, message: 'cluster disabled' };
    }
    if (!clusterTokenMatches(token, this.config.clusterToken)) {
      return { ok: false, nodeId: '', code: 401, message: 'invalid cluster token' };
    }
    const nodeId = q.get('nodeId') ?? '';
    if (!nodeId) {
      return { ok: false, nodeId: '', code: 400, message: 'nodeId required' };
    }
    if (!this.nodeExists(nodeId)) {
      return { ok: false, nodeId, code: 404, message: 'unknown node' };
    }
    return { ok: true, nodeId, code: 101, message: 'ok' };
  }

  private nodeExists(nodeId: string): boolean {
    try {
      return !!this.db
        .global()
        .prepare('SELECT 1 FROM nodes WHERE id = ?')
        .get(nodeId);
    } catch {
      return false;
    }
  }

  private rejectUpgrade(socket: Duplex, code: number, message: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    } catch {
      /* peer gone */
    }
    try {
      socket.destroy();
    } catch {
      /* gone */
    }
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================

  /**
   * Accept a validated socket for a node. One connection per node: an existing
   * connection is replaced (newer wins, old gets 4409). Public so specs can
   * drive the lifecycle with a fake socket (no real upgrade).
   */
  accept(nodeId: string, socket: EdgeSocket): void {
    const prev = this.conns.get(nodeId);
    if (prev) {
      prev.closed = true;
      this.clearConn(prev);
      try {
        prev.socket.close(4409, 'replaced by newer connection');
      } catch {
        /* gone */
      }
    }

    const conn: EdgeConn = {
      nodeId,
      socket,
      capabilities: [],
      connectedAt: Date.now(),
      missedPongs: 0,
      closed: false,
      pending: new Map(),
    };
    this.conns.set(nodeId, conn);

    socket.on('message', (data: unknown) => {
      const frame = parseFrame(data);
      if (frame) this.onFrame(conn, frame);
    });
    socket.on('pong', () => {
      conn.missedPongs = 0;
    });
    socket.on('error', () => {
      // A socket error means this connection is dead: mark the node disconnected
      // NOW rather than waiting for a 'close' that a half-open socket may never
      // emit (field F5a). onClose is idempotent — a following 'close', or a stale
      // one after this conn was already replaced, is a guarded no-op.
      this.onClose(nodeId, conn);
    });
    socket.on('close', () => this.onClose(nodeId, conn));

    conn.pingTimer = setInterval(() => this.ping(conn), EDGE_PING_INTERVAL_MS);
    conn.pingTimer.unref?.();

    this.logger.log(`edge node connected: ${nodeId}`);
  }

  /** Keepalive: 3 missed pongs ⇒ dead → terminate (close event finalizes). */
  private ping(conn: EdgeConn): void {
    if (conn.closed) return;
    if (conn.missedPongs >= EDGE_MAX_MISSED_PONGS) {
      this.logger.warn(`edge node ${conn.nodeId} missed pongs — terminating`);
      try {
        conn.socket.terminate();
      } catch {
        /* gone */
      }
      this.onClose(conn.nodeId, conn);
      return;
    }
    conn.missedPongs += 1;
    this.send(conn.nodeId, { type: 'ping' });
  }

  private onClose(nodeId: string, conn: EdgeConn): void {
    // Ignore a stale close from a connection that was already replaced.
    if (this.conns.get(nodeId) !== conn) {
      this.clearConn(conn);
      return;
    }
    conn.closed = true;
    this.clearConn(conn);
    this.conns.delete(nodeId);
    this.lastDisconnect.set(nodeId, Date.now());
    this.logger.log(`edge node disconnected: ${nodeId}`);
  }

  private clearConn(conn: EdgeConn): void {
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.pingTimer = undefined;
    for (const { timer } of conn.pending.values()) clearTimeout(timer);
    conn.pending.clear();
  }

  // ==========================================================================
  // Inbound frame routing
  // ==========================================================================

  private onFrame(conn: EdgeConn, frame: InboundFrame): void {
    switch (frame.type) {
      case 'register':
        return this.onRegister(conn, frame);
      case 'telemetry':
        return this.onTelemetry(conn, frame);
      case 'assignment_status':
        return this.onAssignmentStatus(frame);
      case 'cmd_result':
        return this.onCmdResult(conn, frame);
      case 'log_tail_result':
        return this.onLogTailResult(conn, frame);
      case 'pong':
        conn.missedPongs = 0;
        return;
      default:
        this.logger.debug(`edge ${conn.nodeId}: ignoring frame '${frame.type}'`);
    }
  }

  private onRegister(conn: EdgeConn, frame: InboundFrame): void {
    conn.role = frameStr(frame, 'role');
    conn.agentVersion = frameStr(frame, 'agentVersion');
    conn.capabilities = Array.isArray(frame.capabilities)
      ? frame.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    // Freshen liveness (bare heartbeat), then re-offer any parked work.
    try {
      this.cluster.heartbeat(conn.nodeId);
    } catch {
      /* node vanished mid-session — the watchdog will reconcile */
    }
    this.reoffer(conn.nodeId);
  }

  private onTelemetry(conn: EdgeConn, frame: InboundFrame): void {
    const stats = frame.stats;
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return;
    try {
      this.cluster.heartbeat(conn.nodeId, stats as Record<string, unknown>);
    } catch (err) {
      this.logger.debug(
        `telemetry persist for ${conn.nodeId} failed: ${(err as Error).message}`,
      );
    }
  }

  private onAssignmentStatus(frame: InboundFrame): void {
    const id = frameStr(frame, 'id');
    const status = frameStr(frame, 'status');
    if (!id || !status) return;
    if (!['running', 'stopped', 'failed'].includes(status)) return;
    this.assignments.updateStatus(
      id,
      status as EdgeAssignmentStatus,
      frameStr(frame, 'detail') ?? null,
    );
  }

  private onCmdResult(conn: EdgeConn, frame: InboundFrame): void {
    const cmdId = frameStr(frame, 'cmdId');
    if (!cmdId) return;
    this.resolvePending(conn, cmdId, {
      ok: frame.ok === true,
      output: frameStr(frame, 'output'),
    });
  }

  private onLogTailResult(conn: EdgeConn, frame: InboundFrame): void {
    const reqId = frameStr(frame, 'reqId');
    if (!reqId) return;
    const lines = Array.isArray(frame.lines)
      ? frame.lines.filter((l): l is string => typeof l === 'string')
      : [];
    this.resolvePending(conn, reqId, lines);
  }

  /** Re-offer every pending/offered assignment to a (re)connected node. */
  private reoffer(nodeId: string): void {
    const parked = this.assignments.pendingOrOfferedByNode(nodeId);
    for (const a of parked) {
      if (this.send(nodeId, toAssignFrame(a))) {
        this.assignments.updateStatus(a.id, 'offered');
      }
    }
    if (parked.length > 0) {
      this.logger.log(`re-offered ${parked.length} assignment(s) to ${nodeId}`);
    }
  }

  // ==========================================================================
  // Outbound (used by the scheduler / watchdog / controller)
  // ==========================================================================

  /** Is a node connected over the WS channel right now? */
  isConnected(nodeId: string): boolean {
    const conn = this.conns.get(nodeId);
    return !!conn && !conn.closed;
  }

  /** All currently-connected node ids. */
  connectedNodeIds(): string[] {
    return [...this.conns.keys()];
  }

  /** When the node's current connection was established (ms), or null. */
  connectedSince(nodeId: string): number | null {
    return this.conns.get(nodeId)?.connectedAt ?? null;
  }

  /** When the node's WS last dropped (ms), or null if it never has. */
  lastDisconnectAt(nodeId: string): number | null {
    return this.lastDisconnect.get(nodeId) ?? null;
  }

  /**
   * How long the node has been WS-disconnected: the ms timestamp of its last
   * drop, or null when it is connected now or was never connected. Drives the
   * watchdog's failover grace.
   */
  disconnectedSince(nodeId: string): number | null {
    if (this.isConnected(nodeId)) return null;
    return this.lastDisconnect.get(nodeId) ?? null;
  }

  /** Send a frame to a node. Returns false when it is not connected. */
  send(nodeId: string, frame: Record<string, unknown>): boolean {
    const conn = this.conns.get(nodeId);
    if (!conn || conn.closed) return false;
    try {
      conn.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Push a `revoke` frame for an assignment. */
  revoke(nodeId: string, id: string): boolean {
    return this.send(nodeId, { type: 'revoke', id });
  }

  /**
   * Run a node command over the WS channel and await its `cmd_result`. Rejects
   * with 503 (not connected) or 504 (no reply within `timeoutMs`, default 5s).
   */
  async command(
    nodeId: string,
    command: 'restart' | 'reboot' | 'ping',
    args?: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; output?: string }> {
    const cmdId = randomUUID();
    return this.request<{ ok: boolean; output?: string }>(
      nodeId,
      { type: 'cmd', cmdId, command, ...(args ? { args } : {}) },
      cmdId,
      timeoutMs,
    );
  }

  /**
   * Request the tail of a node's edge-runtime log over the WS channel. Rejects
   * with 503 (not connected) or 504 (no reply within `timeoutMs`, default 5s).
   */
  async logTail(nodeId: string, lines: number, timeoutMs = 5000): Promise<string[]> {
    const reqId = randomUUID();
    return this.request<string[]>(
      nodeId,
      { type: 'log_tail', reqId, lines },
      reqId,
      timeoutMs,
    );
  }

  /** Force-disconnect a node (operator/testing). */
  disconnect(nodeId: string): void {
    const conn = this.conns.get(nodeId);
    if (!conn) return;
    try {
      conn.socket.close(1000, 'disconnected by master');
    } catch {
      try {
        conn.socket.terminate();
      } catch {
        /* gone */
      }
    }
    this.onClose(nodeId, conn);
  }

  /** Generic request→reply over the channel, keyed by cmdId/reqId. */
  private request<T>(
    nodeId: string,
    frame: Record<string, unknown>,
    id: string,
    timeoutMs: number,
  ): Promise<T> {
    const conn = this.conns.get(nodeId);
    if (!conn || conn.closed) {
      return Promise.reject(
        new ServiceUnavailableException({ error: 'node not connected' }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(
          new GatewayTimeoutException({ error: 'edge did not respond in time' }),
        );
      }, timeoutMs);
      timer.unref?.();
      conn.pending.set(id, { resolve: resolve as (v: unknown) => void, timer });
      if (!this.send(nodeId, frame)) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(
          new ServiceUnavailableException({ error: 'node not connected' }),
        );
      }
    });
  }

  private resolvePending(conn: EdgeConn, id: string, value: unknown): void {
    const pending = conn.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    conn.pending.delete(id);
    pending.resolve(value);
  }

  private static query(url: string): URLSearchParams {
    const i = url.indexOf('?');
    return new URLSearchParams(i >= 0 ? url.slice(i + 1) : '');
  }
}
