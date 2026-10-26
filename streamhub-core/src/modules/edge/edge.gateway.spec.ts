/**
 * Unit — edge/EdgeGateway. Drives the transport with a FAKE socket pair (no real
 * upgrade): upgrade auth decisions, one-connection-per-node takeover, inbound
 * frame routing (register/telemetry/assignment_status), the assign re-offer on
 * (re)connect, and the cmd/log_tail request→reply round-trips.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeGateway, type EdgeSocket } from './edge.gateway';
import { EDGE_MAX_MISSED_PONGS, EDGE_PING_INTERVAL_MS } from './edge.protocol';
import type { ClusterService } from '../cluster/cluster.service';

/** In-memory socket that records sent frames + lets a test drive its events. */
class FakeSocket implements EdgeSocket {
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  terminated = false;
  private readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  /** Sent frames parsed as JSON objects. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  last(type: string): Record<string, unknown> | undefined {
    return [...this.frames()].reverse().find((f) => f.type === type);
  }
}

const TOKEN = 'super-secret';

function makeGateway(env: Record<string, string> = { STREAMHUB_CLUSTER_TOKEN: TOKEN }): {
  ctx: UnitContext;
  gw: EdgeGateway;
  repo: EdgeAssignmentsRepository;
  cluster: { heartbeat: jest.Mock };
} {
  const ctx = makeUnitContext(env);
  const repo = new EdgeAssignmentsRepository(ctx.db);
  const cluster = { heartbeat: jest.fn() };
  const gw = new EdgeGateway(
    undefined,
    ctx.config,
    ctx.db,
    cluster as unknown as ClusterService,
    repo,
    undefined,
  );
  return { ctx, gw, repo, cluster };
}

function insertNode(ctx: UnitContext, id: string): void {
  ctx.db
    .global()
    .prepare("INSERT INTO nodes (id, name, status) VALUES (?, ?, 'active')")
    .run(id, id);
}

describe('edge/EdgeGateway', () => {
  let ctx: UnitContext;
  let gw: EdgeGateway;

  afterEach(() => {
    gw?.onApplicationShutdown();
    ctx?.cleanup();
  });

  describe('authorizeUpgrade', () => {
    it('503 when clustering is disabled (no token)', () => {
      ({ ctx, gw } = makeGateway({ STREAMHUB_CLUSTER_TOKEN: '' }));
      const d = gw.authorizeUpgrade({ url: '/api/v1/edge/ws?nodeId=n1', headers: {} });
      expect(d).toMatchObject({ ok: false, code: 503 });
    });

    it('401 on a wrong/absent token (timing-safe)', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      expect(
        gw.authorizeUpgrade({ url: '/api/v1/edge/ws?nodeId=n1&token=wrong', headers: {} }),
      ).toMatchObject({ ok: false, code: 401 });
      expect(
        gw.authorizeUpgrade({ url: '/api/v1/edge/ws?nodeId=n1', headers: {} }),
      ).toMatchObject({ ok: false, code: 401 });
    });

    it('400 when nodeId is missing, 404 when it is unknown', () => {
      ({ ctx, gw } = makeGateway());
      expect(
        gw.authorizeUpgrade({ url: `/api/v1/edge/ws?token=${TOKEN}`, headers: {} }),
      ).toMatchObject({ ok: false, code: 400 });
      expect(
        gw.authorizeUpgrade({ url: `/api/v1/edge/ws?nodeId=ghost&token=${TOKEN}`, headers: {} }),
      ).toMatchObject({ ok: false, code: 404 });
    });

    it('accepts a known node with a valid token (header or query)', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      expect(
        gw.authorizeUpgrade({
          url: '/api/v1/edge/ws?nodeId=n1',
          headers: { 'x-cluster-token': TOKEN },
        }),
      ).toMatchObject({ ok: true, nodeId: 'n1' });
      expect(
        gw.authorizeUpgrade({ url: `/api/v1/edge/ws?nodeId=n1&token=${TOKEN}`, headers: {} }),
      ).toMatchObject({ ok: true, nodeId: 'n1' });
    });
  });

  describe('connection lifecycle + frame routing', () => {
    it('register freshens the node and re-offers parked assignments', () => {
      let repo: EdgeAssignmentsRepository;
      let cluster: { heartbeat: jest.Mock };
      ({ ctx, gw, repo, cluster } = makeGateway());
      insertNode(ctx, 'n1');
      const parked = repo.create({ nodeId: 'n1', app: 'live', pluginId: 'yolo', status: 'pending' });

      const sock = new FakeSocket();
      gw.accept('n1', sock);
      expect(gw.isConnected('n1')).toBe(true);
      expect(gw.connectedNodeIds()).toEqual(['n1']);

      sock.emit('message', JSON.stringify({ type: 'register', role: 'edge', agentVersion: '1.0.0' }));

      expect(cluster.heartbeat).toHaveBeenCalledWith('n1'); // bare freshen
      const assign = sock.last('assign');
      expect(assign).toBeDefined();
      expect((assign!.assignment as { id: string }).id).toBe(parked.id);
      expect(repo.get(parked.id)?.status).toBe('offered');
    });

    it('persists telemetry stats via the cluster heartbeat path', () => {
      let cluster: { heartbeat: jest.Mock };
      ({ ctx, gw, cluster } = makeGateway());
      insertNode(ctx, 'n1');
      const sock = new FakeSocket();
      gw.accept('n1', sock);

      const stats = { cpu: 0.5, disk: { usedPct: 40, totalGb: 100 } };
      sock.emit('message', JSON.stringify({ type: 'telemetry', stats }));
      expect(cluster.heartbeat).toHaveBeenCalledWith('n1', stats);
    });

    it('routes assignment_status → repo status update', () => {
      let repo: EdgeAssignmentsRepository;
      ({ ctx, gw, repo } = makeGateway());
      insertNode(ctx, 'n1');
      const a = repo.create({ nodeId: 'n1', app: 'live', pluginId: 'yolo', status: 'offered' });
      const sock = new FakeSocket();
      gw.accept('n1', sock);

      sock.emit('message', JSON.stringify({ type: 'assignment_status', id: a.id, status: 'running' }));
      expect(repo.get(a.id)?.status).toBe('running');

      sock.emit(
        'message',
        JSON.stringify({ type: 'assignment_status', id: a.id, status: 'failed', detail: 'crash' }),
      );
      expect(repo.get(a.id)).toMatchObject({ status: 'failed', detail: 'crash' });
    });

    it('newer connection wins: the old socket is closed with 4409', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const first = new FakeSocket();
      const second = new FakeSocket();
      gw.accept('n1', first);
      gw.accept('n1', second);
      expect(first.closed?.code).toBe(4409);
      expect(gw.connectedNodeIds()).toEqual(['n1']);
    });

    it('close records the disconnect and drops the connection', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const sock = new FakeSocket();
      gw.accept('n1', sock);
      sock.emit('close');
      expect(gw.isConnected('n1')).toBe(false);
      expect(gw.lastDisconnectAt('n1')).not.toBeNull();
      expect(gw.disconnectedSince('n1')).not.toBeNull();
    });

    it('ignores malformed frames without crashing', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const sock = new FakeSocket();
      gw.accept('n1', sock);
      expect(() => sock.emit('message', 'not json')).not.toThrow();
      expect(() => sock.emit('message', JSON.stringify([1, 2, 3]))).not.toThrow();
      expect(gw.isConnected('n1')).toBe(true);
    });
  });

  // Half-open windows a core restart / silent network drop can open: the node
  // believes it is connected while the gateway lost it. Both ends must converge.
  describe('half-open + reconnect hardening (F5a)', () => {
    it('a socket error marks the node disconnected (does not wait for close)', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const sock = new FakeSocket();
      gw.accept('n1', sock);

      sock.emit('error', new Error('ECONNRESET'));
      expect(gw.isConnected('n1')).toBe(false);
      expect(gw.lastDisconnectAt('n1')).not.toBeNull();

      // A 'close' that follows the error must be an idempotent no-op.
      expect(() => sock.emit('close')).not.toThrow();
      expect(gw.isConnected('n1')).toBe(false);
    });

    it('3 missed pongs terminate the socket and mark it disconnected', () => {
      jest.useFakeTimers();
      try {
        ({ ctx, gw } = makeGateway());
        insertNode(ctx, 'n1');
        const sock = new FakeSocket();
        gw.accept('n1', sock);

        // No 'pong' ever arrives; advance past MAX_MISSED_PONGS ping intervals.
        jest.advanceTimersByTime(EDGE_PING_INTERVAL_MS * (EDGE_MAX_MISSED_PONGS + 1));

        expect(sock.terminated).toBe(true);
        expect(gw.isConnected('n1')).toBe(false);
        expect(gw.lastDisconnectAt('n1')).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('a pong resets the missed-pong counter so a live node is never terminated', () => {
      jest.useFakeTimers();
      try {
        ({ ctx, gw } = makeGateway());
        insertNode(ctx, 'n1');
        const sock = new FakeSocket();
        gw.accept('n1', sock);

        // Reply pong just before each terminate threshold — stays connected.
        for (let i = 0; i < EDGE_MAX_MISSED_PONGS * 3; i++) {
          jest.advanceTimersByTime(EDGE_PING_INTERVAL_MS);
          sock.emit('pong');
        }
        expect(sock.terminated).toBe(false);
        expect(gw.isConnected('n1')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('re-register from the same node swaps sockets; a late close of the old one does not drop the new', () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const stale = new FakeSocket();
      const fresh = new FakeSocket();

      gw.accept('n1', stale);
      // A reconnect (e.g. after a core restart) accepts a NEW socket for the same
      // node — the stale one is closed with 4409 and the fresh one is now live.
      gw.accept('n1', fresh);
      expect(stale.closed?.code).toBe(4409);
      expect(gw.isConnected('n1')).toBe(true);

      // The stale socket's delayed 'close' must NOT disconnect the node — the
      // fresh connection owns the slot now (the core half-open correctness fix).
      stale.emit('close');
      expect(gw.isConnected('n1')).toBe(true);
      expect(gw.connectedNodeIds()).toEqual(['n1']);

      // And the fresh socket is the one that actually receives frames.
      expect(gw.send('n1', { type: 'ping' })).toBe(true);
      expect(fresh.last('ping')).toBeDefined();
    });
  });

  describe('request → reply', () => {
    it('command resolves when the node replies with cmd_result', async () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const sock = new FakeSocket();
      gw.accept('n1', sock);

      const p = gw.command('n1', 'ping');
      const cmd = sock.last('cmd')!;
      expect(cmd.command).toBe('ping');
      sock.emit(
        'message',
        JSON.stringify({ type: 'cmd_result', cmdId: cmd.cmdId, ok: true, output: 'pong' }),
      );
      await expect(p).resolves.toEqual({ ok: true, output: 'pong' });
    });

    it('logTail resolves with the returned lines', async () => {
      ({ ctx, gw } = makeGateway());
      insertNode(ctx, 'n1');
      const sock = new FakeSocket();
      gw.accept('n1', sock);

      const p = gw.logTail('n1', 10);
      const req = sock.last('log_tail')!;
      expect(req.lines).toBe(10);
      sock.emit(
        'message',
        JSON.stringify({ type: 'log_tail_result', reqId: req.reqId, lines: ['a', 'b'] }),
      );
      await expect(p).resolves.toEqual(['a', 'b']);
    });

    it('command rejects (503) when the node is not connected', async () => {
      ({ ctx, gw } = makeGateway());
      await expect(gw.command('ghost', 'ping')).rejects.toBeDefined();
    });
  });

  describe('send', () => {
    it('returns false for a node that is not connected', () => {
      ({ ctx, gw } = makeGateway());
      expect(gw.send('nobody', { type: 'ping' })).toBe(false);
    });
  });
});
