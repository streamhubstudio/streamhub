/**
 * Unit specs for PluginWorkerManager. child_process is mocked with a controllable
 * fake child (EventEmitter) so start/stop/logs/status/crash are deterministic and
 * no real process is spawned.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ConfigService } from '../../shared/config/config.service';
import { mockLogsService } from '../../../test/helpers';
import { PluginMeta, PluginNodeInfo } from './plugin.contract';
import { PluginWorkerManager } from './plugin-worker.manager';
import {
  GridDispatchResult,
  GridSpawnRequest,
  PluginGridService,
} from './plugin-grid.service';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp: any = new EventEmitter();
  cp.pid = 999;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn(() => {
    cp.emit('exit', 0, 'SIGTERM');
    return true;
  });
  return cp;
}

const meta: PluginMeta = {
  id: 'wk',
  name: 'Worker',
  description: '',
  category: 'processor',
  ui: 'player-overlay',
  needsWorker: true,
  configSchema: [],
  worker: {
    spawn: (ctx) => ({ command: 'the-cmd', args: ['--app', ctx.app] }),
  },
};

const APP = 'live';

describe('PluginWorkerManager', () => {
  let mgr: PluginWorkerManager;
  let logs: ReturnType<typeof mockLogsService>;
  let child: ReturnType<typeof fakeChild>;

  beforeEach(() => {
    logs = mockLogsService();
    mgr = new PluginWorkerManager(new ConfigService(), logs);
    child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);
  });

  afterEach(() => mgr.onModuleDestroy());

  it('reports stopped for a never-started worker', () => {
    expect(mgr.status(APP, 'wk').status).toBe('stopped');
    expect(mgr.isRunning(APP, 'wk')).toBe(false);
  });

  it('starts and passes the resolved spawn spec + env', () => {
    const state = mgr.start(meta, APP, '/apps/live', { foo: 'bar' }, 7);
    expect(state.status).toBe('running');
    expect(state.pid).toBe(999);
    expect(spawn).toHaveBeenCalledWith(
      'the-cmd',
      ['--app', APP],
      expect.objectContaining({ cwd: '/apps/live' }),
    );
    expect(mgr.isRunning(APP, 'wk')).toBe(true);
  });

  it('threads appTimezone (owner item 11) into the worker context', () => {
    const tzMeta: PluginMeta = {
      ...meta,
      worker: {
        spawn: (ctx) => ({
          command: 'the-cmd',
          args: ['--tz', ctx.appTimezone ?? ''],
        }),
      },
    };
    mgr.start(tzMeta, APP, '/apps/live', {}, null, 'America/Argentina/Buenos_Aires');
    expect(spawn).toHaveBeenCalledWith(
      'the-cmd',
      ['--tz', 'America/Argentina/Buenos_Aires'],
      expect.objectContaining({ cwd: '/apps/live' }),
    );
  });

  it('leaves appTimezone undefined when the caller does not resolve one', () => {
    const tzMeta: PluginMeta = {
      ...meta,
      worker: {
        spawn: (ctx) => ({
          command: 'the-cmd',
          args: ['--tz', ctx.appTimezone ?? '(none)'],
        }),
      },
    };
    mgr.start(tzMeta, APP, '/apps/live', {}, null);
    expect(spawn).toHaveBeenCalledWith(
      'the-cmd',
      ['--tz', '(none)'],
      expect.objectContaining({ cwd: '/apps/live' }),
    );
  });

  it('is idempotent while running', () => {
    mgr.start(meta, APP, '/apps/live', {}, null);
    mgr.start(meta, APP, '/apps/live', {}, null);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('captures stdout/stderr into the ring buffer + LogsService', () => {
    mgr.start(meta, APP, '/apps/live', {}, 3);
    child.stdout.emit('data', Buffer.from('hello\nworld\n'));
    child.stderr.emit('data', Buffer.from('oops\n'));
    const lines = mgr.logs(APP, 'wk').map((l) => l.line);
    expect(lines).toEqual(expect.arrayContaining(['hello', 'world', 'oops']));
    expect(logs.write).toHaveBeenCalledWith(
      'warn',
      'plugin:wk',
      'oops',
      expect.objectContaining({ app: APP, stream: 'stderr' }),
      3,
    );
  });

  it('flags a crash on non-zero exit', () => {
    mgr.start(meta, APP, '/apps/live', {}, null);
    child.emit('exit', 1, null);
    expect(mgr.status(APP, 'wk').status).toBe('crashed');
    expect(mgr.status(APP, 'wk').exitCode).toBe(1);
  });

  it('flags a crash on spawn error', () => {
    mgr.start(meta, APP, '/apps/live', {}, null);
    child.emit('error', new Error('ENOENT'));
    expect(mgr.status(APP, 'wk').status).toBe('crashed');
    expect(mgr.status(APP, 'wk').error).toBe('ENOENT');
  });

  it('stops a running worker', () => {
    mgr.start(meta, APP, '/apps/live', {}, null);
    const s = mgr.stop(APP, 'wk');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(s.status).toBe('stopped');
    expect(mgr.isRunning(APP, 'wk')).toBe(false);
  });

  it('throws for a plugin without a worker', () => {
    const noWorker: PluginMeta = { ...meta, needsWorker: false, worker: undefined };
    expect(() => mgr.start(noWorker, APP, '/apps/live', {}, null)).toThrow();
  });

  it('caps the ring buffer', () => {
    mgr.start(meta, APP, '/apps/live', {}, null);
    for (let i = 0; i < 600; i++) {
      child.stdout.emit('data', Buffer.from(`line-${i}\n`));
    }
    expect(mgr.logs(APP, 'wk', 1000).length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// GRID placement (GRID-1/2/3): remote dispatch, lease, stop-proxy, feed-back.
// ---------------------------------------------------------------------------

const gridNode: PluginNodeInfo = {
  id: 'gpu1',
  name: 'gpu-1',
  url: 'https://gpu1.example.com',
  region: 'eu',
};

const gridMeta: PluginMeta = {
  id: 'yolo',
  name: 'YOLO',
  description: '',
  category: 'processor',
  ui: 'player-overlay',
  needsWorker: true,
  configSchema: [],
  worker: {
    placement: 'grid',
    grid: { gpu: true, capabilities: ['cuda', 'yolo'] },
    // Echo the remote ctx fields into env so the test can assert the manager
    // resolved the spec against the REMOTE context (node + originUrl).
    spawn: (ctx) => ({
      command: 'python3',
      args: ['-m', 'yolo_worker', '--app', ctx.app],
      env: { YOLO_ORIGIN: ctx.originUrl ?? '', YOLO_NODE: ctx.node?.id ?? '' },
    }),
  },
};

/** Flush pending microtasks + one macrotask so the async dispatch resolves. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('PluginWorkerManager — GRID placement', () => {
  let mgr: PluginWorkerManager;
  let logs: ReturnType<typeof mockLogsService>;
  let child: ReturnType<typeof fakeChild>;
  let grid: {
    selectNode: jest.Mock;
    dispatch: jest.Mock;
    stopRemote: jest.Mock;
  };
  const savedPublic = process.env.PUBLIC_BASE_URL;

  const dispatched = (remoteId: string): GridDispatchResult => ({
    dispatched: true,
    node: gridNode,
    remoteId,
  });

  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = 'https://origin.example.com';
    logs = mockLogsService();
    grid = {
      selectNode: jest.fn().mockReturnValue(gridNode),
      dispatch: jest.fn().mockResolvedValue(dispatched('remote-1')),
      stopRemote: jest.fn().mockResolvedValue(true),
    };
    mgr = new PluginWorkerManager(
      new ConfigService(),
      logs,
      undefined,
      grid as unknown as PluginGridService,
    );
    child = fakeChild();
    (spawn as jest.Mock).mockClear();
    (spawn as jest.Mock).mockReturnValue(child);
  });

  afterEach(() => {
    mgr.onModuleDestroy();
    if (savedPublic === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedPublic;
  });

  it('dispatches to the selected grid node and does NOT spawn locally', async () => {
    const state = mgr.start(gridMeta, APP, '/apps/live', {}, 1);
    expect(state.status).toBe('starting'); // async until the agent answers
    await flush();

    expect(grid.selectNode).toHaveBeenCalledWith({
      gpu: true,
      capabilities: ['cuda', 'yolo'],
    });
    expect(grid.dispatch).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled(); // no LOCAL child

    const s = mgr.status(APP, 'yolo');
    expect(s.status).toBe('running');
    expect(s.placement).toBe('grid');
    expect(s.node).toEqual(gridNode);
    expect(s.remoteId).toBe('remote-1');
  });

  it('injects originUrl + the public ingest URL/token into the dispatched env (GRID-3)', async () => {
    mgr.start(gridMeta, APP, '/apps/live', {}, 1);
    await flush();

    const req = grid.dispatch.mock.calls[0][1] as GridSpawnRequest;
    // resolved against the REMOTE ctx (node + originUrl echoed by spawn):
    expect(req.env.YOLO_ORIGIN).toBe('https://origin.example.com');
    expect(req.env.YOLO_NODE).toBe('gpu1');
    // framework feed-back env points at the ORIGIN public base, not loopback:
    expect(req.env.STREAMHUB_INGEST_URL).toBe(
      'https://origin.example.com/api/v1/apps/live/plugins/yolo/live',
    );
    expect(req.env.STREAMHUB_INGEST_URL).not.toContain('127.0.0.1');
    expect(req.ingestToken).toBeTruthy();
    expect(req.env.STREAMHUB_INGEST_TOKEN).toBe(req.ingestToken);
    // and the origin holds the same token so it accepts the worker's pushes:
    expect(mgr.ingestToken(APP, 'yolo')).toBe(req.ingestToken);
  });

  it('falls back to a LOCAL spawn when dispatch fails', async () => {
    grid.dispatch.mockResolvedValue({
      dispatched: false,
      node: gridNode,
      reason: 'agent returned HTTP 500',
    } as GridDispatchResult);

    mgr.start(gridMeta, APP, '/apps/live', {}, 1);
    await flush();

    expect(spawn).toHaveBeenCalledTimes(1); // local fall-back happened
    const s = mgr.status(APP, 'yolo');
    expect(s.status).toBe('running');
    expect(s.placement).toBe('local');
  });

  it('falls back to a LOCAL spawn when no grid node is eligible', () => {
    grid.selectNode.mockReturnValue(null);
    mgr.start(gridMeta, APP, '/apps/live', {}, 1);
    expect(grid.dispatch).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mgr.status(APP, 'yolo').placement).toBe('local');
  });

  it('proxies stop to the owning node and clears the lease (GRID-2)', async () => {
    mgr.start(gridMeta, APP, '/apps/live', {}, 1);
    await flush();

    const s = mgr.stop(APP, 'yolo');
    expect(grid.stopRemote).toHaveBeenCalledWith(gridNode, 'remote-1');
    expect(s.status).toBe('stopped');
    expect(mgr.isRunning(APP, 'yolo')).toBe(false);
    // a dead remote worker's ingest token is no longer accepted:
    expect(mgr.ingestToken(APP, 'yolo')).toBeUndefined();
  });

  it('warns but still dispatches when PUBLIC_BASE_URL is unset (no feed-back env)', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const m = new PluginWorkerManager(
      new ConfigService(),
      logs,
      undefined,
      grid as unknown as PluginGridService,
    );
    m.start(gridMeta, APP, '/apps/live', {}, 1);
    await flush();

    const req = grid.dispatch.mock.calls[0][1] as GridSpawnRequest;
    expect(req.env.STREAMHUB_INGEST_URL).toBeUndefined();
    expect(m.status(APP, 'yolo').placement).toBe('grid');
    m.onModuleDestroy();
  });
});
