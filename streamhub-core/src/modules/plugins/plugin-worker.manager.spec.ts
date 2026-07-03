/**
 * Unit specs for PluginWorkerManager. child_process is mocked with a controllable
 * fake child (EventEmitter) so start/stop/logs/status/crash are deterministic and
 * no real process is spawned.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ConfigService } from '../../shared/config/config.service';
import { mockLogsService } from '../../../test/helpers';
import { PluginMeta } from './plugin.contract';
import { PluginWorkerManager } from './plugin-worker.manager';

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
