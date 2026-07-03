/**
 * Unit spec — PluginWorkerManager lifecycle events (per-app MQTT/webhooks).
 *
 * The worker-hook now mirrors its lifecycle into the callbacks funnel
 * (plugin_worker_started / plugin_worker_stopped / plugin_worker_error), which
 * fans out to the app webhook AND the MQTT tap. child_process is mocked with a
 * controllable fake child — no real process, no network.
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';

import { ConfigService } from '../../shared/config/config.service';
import { mockCallbacksService, mockLogsService } from '../../../test/helpers';
import { PluginMeta } from './plugin.contract';
import { PluginWorkerManager } from './plugin-worker.manager';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp: any = new EventEmitter();
  cp.pid = 4242;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn(() => {
    cp.emit('exit', 0, 'SIGTERM');
    return true;
  });
  return cp;
}

const meta: PluginMeta = {
  id: 'yolo',
  name: 'YOLO',
  description: '',
  category: 'processor',
  ui: 'player-overlay',
  needsWorker: true,
  configSchema: [],
  worker: { spawn: () => ({ command: 'python', args: ['-m', 'yolo_worker'] }) },
};

const APP = 'live';

describe('PluginWorkerManager — lifecycle events', () => {
  let mgr: PluginWorkerManager;
  let callbacks: ReturnType<typeof mockCallbacksService>;
  let child: ReturnType<typeof fakeChild>;

  function events(): [string, string, Record<string, unknown>][] {
    return callbacks.dispatch.mock.calls as never;
  }

  beforeEach(() => {
    callbacks = mockCallbacksService();
    mgr = new PluginWorkerManager(
      new ConfigService(),
      mockLogsService(),
      callbacks,
    );
    child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);
  });

  afterEach(() => mgr.onModuleDestroy());

  it('emits plugin_worker_started on a successful start', () => {
    mgr.start(meta, APP, '/apps/live', {}, 1);
    expect(callbacks.dispatch).toHaveBeenCalledWith(
      APP,
      'plugin_worker_started',
      { plugin: 'yolo', pid: 4242 },
    );
  });

  it('emits plugin_worker_stopped on a clean exit', () => {
    mgr.start(meta, APP, '/apps/live', {}, 1);
    child.emit('exit', 0, null);
    expect(events().map(([, e]) => e)).toEqual([
      'plugin_worker_started',
      'plugin_worker_stopped',
    ]);
    expect(events()[1][2]).toEqual({
      plugin: 'yolo',
      exitCode: 0,
      signal: null,
    });
  });

  it('emits plugin_worker_stopped (not error) on a manual stop', () => {
    mgr.start(meta, APP, '/apps/live', {}, 1);
    mgr.stop(APP, 'yolo'); // SIGTERM → fake child exits with a signal
    const names = events().map(([, e]) => e);
    expect(names).toEqual(['plugin_worker_started', 'plugin_worker_stopped']);
  });

  it('emits plugin_worker_error on a crash (non-zero exit)', () => {
    mgr.start(meta, APP, '/apps/live', {}, 1);
    child.emit('exit', 2, null);
    const names = events().map(([, e]) => e);
    expect(names).toEqual(['plugin_worker_started', 'plugin_worker_error']);
    expect(events()[1][2]).toMatchObject({ plugin: 'yolo', exitCode: 2 });
  });

  it('emits plugin_worker_error ONCE on a child error followed by a crash exit', () => {
    mgr.start(meta, APP, '/apps/live', {}, 1);
    child.emit('error', new Error('EPIPE'));
    child.emit('exit', 1, null);
    const errors = events().filter(([, e]) => e === 'plugin_worker_error');
    expect(errors).toHaveLength(1);
    expect(errors[0][2]).toEqual({ plugin: 'yolo', error: 'EPIPE' });
  });

  it('emits plugin_worker_error when the spawn itself fails', () => {
    (spawn as jest.Mock).mockImplementation(() => {
      throw new Error('ENOENT: python not found');
    });
    mgr.start(meta, APP, '/apps/live', {}, 1);
    expect(callbacks.dispatch).toHaveBeenCalledWith(
      APP,
      'plugin_worker_error',
      { plugin: 'yolo', error: 'ENOENT: python not found' },
    );
  });

  it('works without the callbacks dependency (optional)', () => {
    const bare = new PluginWorkerManager(new ConfigService(), mockLogsService());
    expect(() => {
      bare.start(meta, APP, '/apps/live', {}, 1);
      child.emit('exit', 0, null);
      bare.onModuleDestroy();
    }).not.toThrow();
  });
});
