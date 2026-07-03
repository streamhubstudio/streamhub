/**
 * Unit — cluster/ClusterService (edge-node registry over the global `nodes`
 * table). Exercises the service against a real migrated temp SQLite DB (via the
 * harness `makeUnitContext`) with no infra: join upsert-by-name (keeps id +
 * refreshes last_seen), the ip→url fallback, the bootstrap payload (Redis /
 * public ws / LiveKit keys, null when unset), and heartbeat (+404).
 */
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { ClusterService } from './cluster.service';
import type { JoinNodeDto } from './dto/join-node.dto';

/** Raw `nodes` row as physically stored (what `SELECT *` returns). */
interface RawRow {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  stats_json: string | null;
}

const FULL_ENV = {
  STREAMHUB_CLUSTER_TOKEN: 'super-secret-cluster-token',
  STREAMHUB_CLUSTER_REDIS_URL: 'redis://cluster:6379',
  PUBLIC_WS_URL: 'wss://public.example.com',
  LIVEKIT_API_KEY: 'APIkey123',
  LIVEKIT_API_SECRET: 'the-livekit-secret',
  LIVEKIT_URL: 'ws://10.0.0.1:7880',
};

function make(env: Record<string, string> = FULL_ENV): {
  ctx: UnitContext;
  svc: ClusterService;
} {
  const ctx = makeUnitContext(env);
  const svc = ctx.newService(ClusterService, ctx.db, ctx.config);
  return { ctx, svc };
}

function nodeRow(ctx: UnitContext, id: string): RawRow | undefined {
  return ctx.db
    .global()
    .prepare('SELECT * FROM nodes WHERE id = ?')
    .get(id) as RawRow | undefined;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ConfigService snapshots process.env in its ctor and makeTestConfig never
// clears prior keys, so save/restore what we touch to avoid leaking config
// (Redis/LiveKit/ws) into later tests or other spec files.
const TOUCHED = [
  'STREAMHUB_CLUSTER_TOKEN',
  'STREAMHUB_CLUSTER_REDIS_URL',
  'STREAMHUB_PUBLIC_URL',
  'PUBLIC_BASE_URL',
  'PUBLIC_WS_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_URL',
];

describe('cluster/ClusterService', () => {
  let ctx: UnitContext;
  let svc: ClusterService;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of TOUCHED) original[k] = process.env[k];
  });
  afterEach(() => {
    ctx?.cleanup();
    for (const k of TOUCHED) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  describe('join', () => {
    it('creates a new node (UUID id, active) and returns the bootstrap payload', () => {
      ({ ctx, svc } = make());
      const dto: JoinNodeDto = { name: 'edge-1', ip: '203.0.113.10' };

      const { created, payload } = svc.join(dto);

      expect(created).toBe(true);
      expect(payload.nodeId).toMatch(UUID_RE);
      expect(payload.name).toBe('edge-1');
      expect(payload.redisUrl).toBe('redis://cluster:6379');
      expect(payload.publicWsUrl).toBe('wss://public.example.com');
      expect(payload.livekit).toEqual({
        apiKey: 'APIkey123',
        apiSecret: 'the-livekit-secret',
        wsUrl: 'ws://10.0.0.1:7880',
      });

      const row = nodeRow(ctx, payload.nodeId)!;
      expect(row).toMatchObject({
        name: 'edge-1',
        url: '203.0.113.10', // no body.url → falls back to ip
        region: null,
        status: 'active',
      });
      expect(row.last_seen_at).toBeTruthy();
    });

    it('uses body.url when supplied, else stores the ip', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({
        name: 'edge-url',
        ip: '198.51.100.5',
        url: 'https://edge-url.example.com',
        region: 'eu-west',
      });
      const row = nodeRow(ctx, payload.nodeId)!;
      expect(row.url).toBe('https://edge-url.example.com');
      expect(row.region).toBe('eu-west');
    });

    it('accepts an IPv6 address', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'edge-v6', ip: '2001:db8::1' });
      expect(nodeRow(ctx, payload.nodeId)!.url).toBe('2001:db8::1');
    });

    it('upsert BY NAME keeps the id and refreshes url/region/last_seen', () => {
      ({ ctx, svc } = make());
      const first = svc.join({ name: 'edge-x', ip: '10.0.0.9', region: 'a' });
      expect(first.created).toBe(true);

      // Backdate last_seen so the refresh is unambiguously newer.
      ctx.db
        .global()
        .prepare("UPDATE nodes SET last_seen_at = '1999-01-01 00:00:00' WHERE id = ?")
        .run(first.payload.nodeId);

      const second = svc.join({
        name: 'edge-x',
        ip: '10.0.0.9',
        url: 'https://new.example.com',
        region: 'b',
      });

      expect(second.created).toBe(false);
      expect(second.payload.nodeId).toBe(first.payload.nodeId); // id preserved

      const row = nodeRow(ctx, first.payload.nodeId)!;
      expect(row.url).toBe('https://new.example.com');
      expect(row.region).toBe('b');
      expect(row.status).toBe('active');
      expect(row.last_seen_at).not.toBe('1999-01-01 00:00:00'); // refreshed
      expect(row.last_seen_at! > '1999-01-01 00:00:00').toBe(true);

      // Still exactly one row for that name.
      const count = ctx.db
        .global()
        .prepare('SELECT COUNT(*) AS n FROM nodes WHERE name = ?')
        .get('edge-x') as { n: number };
      expect(count.n).toBe(1);
    });

    it('returns null redisUrl/publicWsUrl when those envs are unset', () => {
      ({ ctx, svc } = make({
        STREAMHUB_CLUSTER_TOKEN: 'tok',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      }));
      const { payload } = svc.join({ name: 'edge-min', ip: '192.0.2.1' });
      expect(payload.redisUrl).toBeNull();
      expect(payload.publicWsUrl).toBeNull();
      // wsUrl falls back to the LiveKit default.
      expect(payload.livekit.wsUrl).toBe('ws://127.0.0.1:7880');
    });
  });

  describe('heartbeat', () => {
    it('marks a known node active and refreshes last_seen', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'hb', ip: '203.0.113.7' });
      ctx.db
        .global()
        .prepare("UPDATE nodes SET status='down', last_seen_at='1999-01-01 00:00:00' WHERE id = ?")
        .run(payload.nodeId);

      expect(() => svc.heartbeat(payload.nodeId)).not.toThrow();

      const row = nodeRow(ctx, payload.nodeId)!;
      expect(row.status).toBe('active');
      expect(row.last_seen_at).not.toBe('1999-01-01 00:00:00');
    });

    it('throws 404 for an unknown node', () => {
      ({ ctx, svc } = make());
      expect(() => svc.heartbeat('does-not-exist')).toThrow(NotFoundException);
    });

    // Operator status is authoritative: a heartbeat clears staleness but must
    // never undo a drain/disable (the PoC bug — one heartbeat un-drained a node).
    it('keeps an operator-set draining status but still refreshes last_seen', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'drain', ip: '203.0.113.7' });
      svc.updateNode(payload.nodeId, { status: 'draining' });
      ctx.db
        .global()
        .prepare("UPDATE nodes SET last_seen_at='1999-01-01 00:00:00' WHERE id = ?")
        .run(payload.nodeId);

      svc.heartbeat(payload.nodeId, { cpu: 0.2 });

      const row = nodeRow(ctx, payload.nodeId)!;
      expect(row.status).toBe('draining'); // NOT reverted to active
      expect(row.last_seen_at).not.toBe('1999-01-01 00:00:00'); // staleness cleared
      expect(row.stats_json).toBe('{"cpu":0.2}'); // stats still written
    });

    it('keeps an operator-set disabled status on a bare ping too', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'off', ip: '203.0.113.8' });
      svc.updateNode(payload.nodeId, { status: 'disabled' });
      svc.heartbeat(payload.nodeId); // bare ping (no stats)
      expect(nodeRow(ctx, payload.nodeId)!.status).toBe('disabled');
    });

    it('promotes a non-operator status (down/unknown) back to active', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'flap', ip: '203.0.113.9' });
      ctx.db
        .global()
        .prepare("UPDATE nodes SET status='down' WHERE id = ?")
        .run(payload.nodeId);
      svc.heartbeat(payload.nodeId);
      expect(nodeRow(ctx, payload.nodeId)!.status).toBe('active');
    });

    it('PATCH active restores a drained node; heartbeat then keeps it active', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'cycle', ip: '203.0.113.10' });
      svc.updateNode(payload.nodeId, { status: 'draining' });
      svc.heartbeat(payload.nodeId);
      expect(nodeRow(ctx, payload.nodeId)!.status).toBe('draining');

      svc.updateNode(payload.nodeId, { status: 'active' }); // operator un-drains
      svc.heartbeat(payload.nodeId);
      expect(nodeRow(ctx, payload.nodeId)!.status).toBe('active');
    });
  });

  describe('listNodes', () => {
    it('returns every registered node (all columns)', () => {
      ({ ctx, svc } = make());
      svc.join({ name: 'n1', ip: '203.0.113.1' });
      svc.join({ name: 'n2', ip: '203.0.113.2' });

      const nodes = svc.listNodes();
      expect(nodes.map((n) => n.name).sort()).toEqual(['n1', 'n2']);
      expect(Object.keys(nodes[0]).sort()).toEqual(
        [
          'created_at',
          'id',
          'last_seen_at',
          'name',
          'region',
          'stale',
          'stats',
          'status',
          'url',
        ].sort(),
      );
    });

    it('is empty on a fresh registry', () => {
      ({ ctx, svc } = make());
      expect(svc.listNodes()).toEqual([]);
    });

    it('parses the stored stats blob and derives stale from last_seen_at', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'n1', ip: '203.0.113.1' });
      svc.heartbeat(payload.nodeId, { cpu: 0.5, activeStreams: 3 });

      const fresh = svc.listNodes()[0];
      expect(fresh.stats).toEqual({ cpu: 0.5, activeStreams: 3 });
      expect(fresh.stale).toBe(false); // just heartbeated

      // Backdate the heartbeat past the 90s window → stale, stats still parsed.
      ctx.db
        .global()
        .prepare("UPDATE nodes SET last_seen_at = datetime('now','-120 seconds') WHERE id = ?")
        .run(payload.nodeId);
      const stale = svc.listNodes()[0];
      expect(stale.stale).toBe(true);
      expect(stale.stats).toEqual({ cpu: 0.5, activeStreams: 3 });
    });

    it('reports stats=null and stale=true for a node that never heartbeated', () => {
      ({ ctx, svc } = make());
      // Insert a bare node with a NULL last_seen_at (no join/heartbeat).
      ctx.db
        .global()
        .prepare("INSERT INTO nodes (id, name, status) VALUES ('bare', 'bare', 'unknown')")
        .run();
      const node = svc.listNodes().find((n) => n.id === 'bare')!;
      expect(node.stats).toBeNull();
      expect(node.stale).toBe(true);
    });
  });

  describe('heartbeat with stats', () => {
    it('persists the stats blob (last-write-wins) and refreshes last_seen', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'hb', ip: '203.0.113.7' });

      svc.heartbeat(payload.nodeId, { cpu: 0.1 });
      expect(nodeRow(ctx, payload.nodeId)!.stats_json).toBe('{"cpu":0.1}');

      svc.heartbeat(payload.nodeId, { cpu: 0.9, mem: 0.4 });
      expect(nodeRow(ctx, payload.nodeId)!.stats_json).toBe(
        '{"cpu":0.9,"mem":0.4}',
      );
    });

    it('leaves the previous stats untouched on a bare (no-stats) ping', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'hb', ip: '203.0.113.7' });
      svc.heartbeat(payload.nodeId, { cpu: 0.3 });
      svc.heartbeat(payload.nodeId); // bare ping
      expect(nodeRow(ctx, payload.nodeId)!.stats_json).toBe('{"cpu":0.3}');
    });

    it('rejects an oversized stats blob (413) and writes nothing', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'hb', ip: '203.0.113.7' });
      const huge = { blob: 'x'.repeat(5000) };
      expect(() => svc.heartbeat(payload.nodeId, huge)).toThrow(
        PayloadTooLargeException,
      );
      expect(nodeRow(ctx, payload.nodeId)!.stats_json).toBeNull();
    });
  });

  describe('onModuleInit (origin self-register)', () => {
    it('inserts a stable `origin` row (id/name/region origin, active) with cpu/mem/cores stats', () => {
      ({ ctx, svc } = make()); // FULL_ENV sets STREAMHUB_CLUSTER_TOKEN
      svc.onModuleInit();

      const row = nodeRow(ctx, 'origin')!;
      expect(row).toMatchObject({
        id: 'origin',
        name: 'origin',
        region: 'origin',
        status: 'active',
      });
      expect(row.last_seen_at).toBeTruthy();

      const node = svc.listNodes().find((n) => n.id === 'origin')!;
      expect(node.stale).toBe(false);
      expect(node.stats).toMatchObject({ role: 'origin' });
      // cpu/mem/cores are all present and numeric.
      for (const k of ['cores', 'cpu', 'memTotal', 'memFree']) {
        expect(typeof node.stats![k]).toBe('number');
      }
    });

    it('is a no-op when clustering is disabled (no token)', () => {
      ({ ctx, svc } = make({
        STREAMHUB_CLUSTER_TOKEN: '',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      }));
      svc.onModuleInit();
      expect(nodeRow(ctx, 'origin')).toBeUndefined();
      expect(svc.listNodes()).toEqual([]);
    });

    it('is idempotent across restarts: one row, id stable, last_seen refreshed', () => {
      ({ ctx, svc } = make());
      svc.onModuleInit();
      ctx.db
        .global()
        .prepare("UPDATE nodes SET last_seen_at='1999-01-01 00:00:00' WHERE id='origin'")
        .run();

      svc.onModuleInit(); // "restart"

      const count = ctx.db
        .global()
        .prepare("SELECT COUNT(*) AS n FROM nodes WHERE id='origin'")
        .get() as { n: number };
      expect(count.n).toBe(1);
      const row = nodeRow(ctx, 'origin')!;
      expect(row.last_seen_at! > '1999-01-01 00:00:00').toBe(true);
    });

    it('preserves an operator-set draining status across a later restart', () => {
      ({ ctx, svc } = make());
      svc.onModuleInit();
      svc.updateNode('origin', { status: 'draining' });

      svc.onModuleInit(); // origin restarts while operator-drained

      expect(nodeRow(ctx, 'origin')!.status).toBe('draining');
    });
  });

  describe('info', () => {
    it('enabled=true with the token + join command when the env is set', () => {
      ({ ctx, svc } = make({
        STREAMHUB_CLUSTER_TOKEN: 'clt_secret',
        STREAMHUB_CLUSTER_REDIS_URL: 'redis://cluster:6379',
        STREAMHUB_PUBLIC_URL: 'https://media.example.com/',
      }));
      svc.join({ name: 'n1', ip: '203.0.113.1' });

      const info = svc.info();
      expect(info.enabled).toBe(true);
      expect(info.nodesCount).toBe(1);
      expect(info.clusterToken).toBe('clt_secret');
      expect(info.clusterRedisUrl).toBe('redis://cluster:6379');
      expect(info.joinCommand).toBe(
        'curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- ' +
          '--join --master-token clt_secret --master-ip <THIS_SERVER_IP> ' +
          '--master-url https://media.example.com',
      );
    });

    it('enabled=false and null redis when the token env is unset', () => {
      ({ ctx, svc } = make({ STREAMHUB_CLUSTER_TOKEN: '' }));
      const info = svc.info();
      expect(info.enabled).toBe(false);
      expect(info.clusterToken).toBe('');
      expect(info.clusterRedisUrl).toBeNull();
      expect(info.nodesCount).toBe(0);
    });
  });

  describe('removeNode', () => {
    it('deletes an existing node', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'gone', ip: '203.0.113.1' });
      expect(() => svc.removeNode(payload.nodeId)).not.toThrow();
      expect(nodeRow(ctx, payload.nodeId)).toBeUndefined();
    });

    it('throws 404 for an unknown node', () => {
      ({ ctx, svc } = make());
      expect(() => svc.removeNode('nope')).toThrow(NotFoundException);
    });
  });

  describe('updateNode', () => {
    it('patches name/region/status and returns the enriched row', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'edge', ip: '203.0.113.1' });

      const out = svc.updateNode(payload.nodeId, {
        name: 'edge-renamed',
        region: 'us-east',
        status: 'draining',
      });
      expect(out.name).toBe('edge-renamed');
      expect(out.region).toBe('us-east');
      expect(out.status).toBe('draining');
      // Enriched shape (derived fields present).
      expect(out).toHaveProperty('stale');
      expect(out).toHaveProperty('stats');

      const row = nodeRow(ctx, payload.nodeId)!;
      expect(row.name).toBe('edge-renamed');
      expect(row.status).toBe('draining');
    });

    it('an empty patch is a no-op that returns the current row', () => {
      ({ ctx, svc } = make());
      const { payload } = svc.join({ name: 'edge', ip: '203.0.113.1' });
      const out = svc.updateNode(payload.nodeId, {});
      expect(out.name).toBe('edge');
      expect(out.status).toBe('active');
    });

    it('throws 404 for an unknown node', () => {
      ({ ctx, svc } = make());
      expect(() => svc.updateNode('nope', { status: 'disabled' })).toThrow(
        NotFoundException,
      );
    });
  });
});
