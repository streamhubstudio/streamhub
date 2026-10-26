/**
 * Unit — plugins/PluginGridService (GRID node selection seam, NEXTGEN-ADDONS).
 *
 * Locks down the origin half of the GRID contract against a real migrated
 * temp SQLite DB (harness makeUnitContext):
 *  - a node is grid-capable IFF it is active, non-stale AND advertises a
 *    `grid` block in its heartbeat stats (the cluster `nodes` table is reused
 *    verbatim — no new schema);
 *  - matchGridNode (pure): gpu/minVramGb/capabilities are hard filters,
 *    regions only re-order, ordering is deterministic;
 *  - dispatch() (GRID-1): POSTs the spawn spec to the node's grid agent with
 *    the cluster token; success returns { dispatched, remoteId }, any failure
 *    (bad url, no token, non-2xx, network error) returns { dispatched:false }
 *    so the worker manager falls back to a local spawn.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import {
  GridNodeView,
  GridSpawnRequest,
  PluginGridService,
  matchGridNode,
} from './plugin-grid.service';
import { PluginNodeInfo } from './plugin.contract';

function node(over: Partial<GridNodeView> = {}): GridNodeView {
  return {
    id: over.id ?? 'n1',
    name: over.name ?? 'node-1',
    url: over.url ?? 'https://n1.example.com',
    region: over.region ?? null,
    gpu: over.gpu ?? false,
    vramGb: over.vramGb ?? null,
    capabilities: over.capabilities ?? [],
  };
}

describe('plugins/matchGridNode (pure selection)', () => {
  it('returns null on an empty node list', () => {
    expect(matchGridNode([], { gpu: true })).toBeNull();
  });

  it('no requirements → any node matches (deterministic first)', () => {
    const b = node({ id: 'b', name: 'bbb' });
    const a = node({ id: 'a', name: 'aaa' });
    expect(matchGridNode([b, a])?.id).toBe('a'); // name tie-break
  });

  it('gpu is a hard filter', () => {
    const cpuOnly = node({ id: 'cpu', gpu: false });
    const gpu = node({ id: 'gpu', name: 'zzz', gpu: true });
    expect(matchGridNode([cpuOnly, gpu], { gpu: true })?.id).toBe('gpu');
    expect(matchGridNode([cpuOnly], { gpu: true })).toBeNull();
  });

  it('minVramGb implies GPU and unreported VRAM never satisfies it', () => {
    const noVram = node({ id: 'novram', gpu: true, vramGb: null });
    const small = node({ id: 'small', gpu: true, vramGb: 8 });
    const big = node({ id: 'big', gpu: true, vramGb: 24 });
    expect(matchGridNode([noVram, small, big], { minVramGb: 16 })?.id).toBe(
      'big',
    );
    expect(matchGridNode([noVram, small], { minVramGb: 16 })).toBeNull();
    // implies gpu: a gpu-less node never matches a VRAM minimum
    const cpu = node({ id: 'cpu', gpu: false, vramGb: 64 });
    expect(matchGridNode([cpu], { minVramGb: 1 })).toBeNull();
  });

  it('every required capability must be advertised', () => {
    const partial = node({ id: 'p', capabilities: ['cuda'] });
    const full = node({ id: 'f', name: 'zz', capabilities: ['cuda', 'whisper'] });
    expect(
      matchGridNode([partial, full], { capabilities: ['cuda', 'whisper'] })?.id,
    ).toBe('f');
    expect(
      matchGridNode([partial], { capabilities: ['cuda', 'whisper'] }),
    ).toBeNull();
  });

  it('regions are a soft preference: re-order, never disqualify', () => {
    const eu = node({ id: 'eu', name: 'aa', region: 'eu', vramGb: 8, gpu: true });
    const us = node({ id: 'us', name: 'bb', region: 'us', vramGb: 24, gpu: true });
    // us has more VRAM but eu matches the preferred region → eu wins
    expect(matchGridNode([us, eu], { regions: ['eu'] })?.id).toBe('eu');
    // no node in the preferred region → still returns the best one
    expect(matchGridNode([us, eu], { regions: ['ap'] })?.id).toBe('us');
  });

  it('larger VRAM wins inside the same region rank', () => {
    const small = node({ id: 's', name: 'aa', gpu: true, vramGb: 8 });
    const big = node({ id: 'b', name: 'zz', gpu: true, vramGb: 24 });
    expect(matchGridNode([small, big], { gpu: true })?.id).toBe('b');
  });
});

describe('plugins/PluginGridService (registry-backed)', () => {
  let ctx: UnitContext;
  let svc: PluginGridService;

  const insert = (
    id: string,
    over: {
      status?: string;
      lastSeen?: string | null;
      stats?: unknown;
      region?: string | null;
    } = {},
  ): void => {
    ctx.db
      .global()
      .prepare(
        `INSERT INTO nodes (id, name, url, region, status, last_seen_at, stats_json)
         VALUES (?, ?, ?, ?, ?, ${over.lastSeen === null ? 'NULL' : `datetime('now', ?)`}, ?)`,
      )
      .run(
        ...([
          id,
          `node-${id}`,
          `https://${id}.example.com`,
          over.region ?? null,
          over.status ?? 'active',
          ...(over.lastSeen === null ? [] : [over.lastSeen ?? '-1 seconds']),
          over.stats === undefined ? null : JSON.stringify(over.stats),
        ] as unknown[]),
      );
  };

  beforeEach(() => {
    ctx = makeUnitContext();
    svc = ctx.newService(PluginGridService, ctx.db, ctx.config);
  });
  afterEach(() => ctx.cleanup());

  it('lists only active, fresh nodes that advertise a grid block', () => {
    insert('grid1', {
      stats: { grid: { gpu: true, vramGb: 24, capabilities: ['cuda'] } },
    });
    insert('plain', { stats: { cpu: 0.2 } }); // no grid block
    insert('stale', {
      lastSeen: '-300 seconds',
      stats: { grid: { gpu: true } },
    });
    insert('drained', {
      status: 'draining',
      stats: { grid: { gpu: true } },
    });
    insert('neverSeen', { lastSeen: null, stats: { grid: { gpu: true } } });

    const nodes = svc.listGridNodes();
    expect(nodes.map((n) => n.id)).toEqual(['grid1']);
    expect(nodes[0]).toMatchObject({
      gpu: true,
      vramGb: 24,
      capabilities: ['cuda'],
      url: 'https://grid1.example.com',
    });
  });

  it('degrades malformed stats / grid blocks to non-grid (never throws)', () => {
    insert('badjson', { stats: undefined });
    ctx.db
      .global()
      .prepare(
        `INSERT INTO nodes (id, name, status, last_seen_at, stats_json)
         VALUES ('corrupt', 'corrupt', 'active', datetime('now'), '{nope')`,
      )
      .run();
    insert('gridarray', { stats: { grid: [1, 2] } }); // grid must be an object
    expect(svc.listGridNodes()).toEqual([]);
  });

  it('normalizes a sparse grid block (defaults, non-string caps dropped)', () => {
    insert('sparse', { stats: { grid: { capabilities: ['whisper', 42] } } });
    const [n] = svc.listGridNodes();
    expect(n).toMatchObject({
      id: 'sparse',
      gpu: false,
      vramGb: null,
      capabilities: ['whisper'],
    });
  });

  it('selectNode applies the worker requirements over the registry', () => {
    insert('cpu', { stats: { grid: {} } });
    insert('gpu', { stats: { grid: { gpu: true, vramGb: 24 } } });
    expect(svc.selectNode({ gpu: true })?.id).toBe('gpu');
    expect(svc.selectNode({ minVramGb: 48 })).toBeNull();
  });

});

describe('plugins/PluginGridService.dispatch (GRID-1 remote wire)', () => {
  let ctx: UnitContext;
  let svc: PluginGridService;
  const realFetch = global.fetch;

  const target: PluginNodeInfo = {
    id: 'gpu1',
    name: 'gpu-1',
    url: 'https://gpu1.example.com',
    region: 'eu',
  };
  const req: GridSpawnRequest = {
    pluginId: 'yolo',
    appName: 'live',
    command: 'python3',
    args: ['-m', 'yolo_worker'],
    env: { YOLO_APP: 'live' },
    ingestToken: 'tok-123',
  };

  const mockFetch = (impl: jest.Mock): void => {
    global.fetch = impl as unknown as typeof fetch;
  };
  const jsonRes = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;

  beforeEach(() => {
    ctx = makeUnitContext({ STREAMHUB_CLUSTER_TOKEN: 'cluster-secret' });
    svc = ctx.newService(PluginGridService, ctx.db, ctx.config);
  });
  afterEach(() => {
    global.fetch = realFetch;
    ctx.cleanup();
  });

  it('POSTs the spawn spec to the node agent with the cluster token', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonRes(200, { data: { id: 'remote-9' }, error: null }),
    );
    mockFetch(fetchMock);

    const res = await svc.dispatch(target, req);

    expect(res).toEqual({ dispatched: true, node: target, remoteId: 'remote-9' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gpu1.example.com/api/v1/grid/workers');
    expect(init.method).toBe('POST');
    expect(init.headers['x-cluster-token']).toBe('cluster-secret');
    expect(JSON.parse(init.body)).toMatchObject({
      pluginId: 'yolo',
      appName: 'live',
      command: 'python3',
      ingestToken: 'tok-123',
    });
  });

  it('accepts a bare { id } envelope from the agent', async () => {
    mockFetch(jest.fn().mockResolvedValue(jsonRes(201, { id: 'r2' })));
    const res = await svc.dispatch(target, req);
    expect(res).toEqual({ dispatched: true, node: target, remoteId: 'r2' });
  });

  it('does NOT dispatch when the agent returns a non-2xx', async () => {
    mockFetch(jest.fn().mockResolvedValue(jsonRes(500, { error: 'boom' })));
    const res = await svc.dispatch(target, req);
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain('HTTP 500');
  });

  it('does NOT dispatch when the agent omits a worker id', async () => {
    mockFetch(jest.fn().mockResolvedValue(jsonRes(200, { data: {} })));
    const res = await svc.dispatch(target, req);
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain('worker id');
  });

  it('does NOT dispatch on a transport error (never throws)', async () => {
    mockFetch(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await svc.dispatch(target, req);
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain('ECONNREFUSED');
  });

  it('declines a non-http(s) node url (SSRF guard) without calling fetch', async () => {
    const fetchMock = jest.fn();
    mockFetch(fetchMock);
    const res = await svc.dispatch(
      { ...target, url: 'file:///etc/passwd' },
      req,
    );
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain('url');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines when the cluster token is unset', async () => {
    const noTok = makeUnitContext({ STREAMHUB_CLUSTER_TOKEN: '' });
    const svc2 = noTok.newService(PluginGridService, noTok.db, noTok.config);
    const fetchMock = jest.fn();
    mockFetch(fetchMock);
    const res = await svc2.dispatch(target, req);
    expect(res.dispatched).toBe(false);
    expect(res.reason).toContain('CLUSTER_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
    noTok.cleanup();
  });

  it('stopRemote POSTs the stop route and reports the agent ok', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonRes(200, { data: { id: 'r1' }, error: null }));
    mockFetch(fetchMock);
    const okd = await svc.stopRemote(target, 'r1');
    expect(okd).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gpu1.example.com/api/v1/grid/workers/r1/stop',
    );
  });

  it('stopRemote returns false on any failure', async () => {
    mockFetch(jest.fn().mockRejectedValue(new Error('down')));
    expect(await svc.stopRemote(target, 'r1')).toBe(false);
  });
});
