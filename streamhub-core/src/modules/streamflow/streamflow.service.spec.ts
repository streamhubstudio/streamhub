/**
 * Unit spec — StreamflowService trigger matching + rate limit + manual run.
 *
 * Constructs the service directly (autoStart off, no BullMQ/reconcile) with a
 * REAL StreamflowStore (temp dir) + fake repo/runner/apps/callbacks/logs. Locks
 * down: an event matching a workflow's trigger enqueues one run; disabled plugin
 * / no-match → nothing; the per-app rate limit; the streamflow.* loop guard; and
 * a manual run.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CallbackEvent } from '../../shared/contracts';
import { StreamflowService } from './streamflow.service';
import { StreamflowStore } from './streamflow.store';

const APP = 'live';

function eventTriggerGraph(match: Record<string, unknown> = { event: 'perimeter.intrusion' }) {
  return {
    boxes: [
      { id: 't', type: 'trigger.event', config: match },
      { id: 'n', type: 'action.notify', config: {} },
    ],
    edges: [{ from: 't', to: 'n' }],
  };
}

describe('StreamflowService', () => {
  let tmp: string;
  let appDir: string;
  let store: StreamflowStore;
  let repoGet: jest.Mock;
  let enqueue: jest.Mock;
  let svc: StreamflowService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-svc-'));
    appDir = path.join(tmp, 'apps', APP);
    store = new StreamflowStore();
    repoGet = jest.fn(() => ({ pluginId: 'streamflow', enabled: true, config: {}, installedAt: '', updatedAt: '' }));
    enqueue = jest.fn(async () => 'run-1');

    const config = { redisUrl: 'redis://x' } as never;
    const repo = { get: repoGet } as never;
    const runner = { enqueue } as never;
    const callbacks = { onDispatch: jest.fn(() => () => undefined) } as never;
    const apps = {
      appDir: () => appDir,
      get: jest.fn(async () => ({ name: APP })),
      list: jest.fn(async () => [{ name: APP }]),
    } as never;
    const logs = { write: jest.fn() } as never;

    svc = new StreamflowService(config, store, repo, runner, callbacks, apps, logs);
    svc.autoStart = false;
  });

  afterEach(() => {
    store.onModuleDestroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('enqueues a run when an event matches a workflow trigger', () => {
    store.createWorkflow(APP, appDir, { name: 'W', graph: eventTriggerGraph() });
    svc.onEvent(APP, 'perimeter.intrusion' as CallbackEvent, { room: 'gate' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [app, input] = enqueue.mock.calls[0];
    expect(app).toBe(APP);
    expect(input).toMatchObject({ trigger: { event: 'perimeter.intrusion' }, triggerBoxId: 't' });
  });

  it('fires a trigger.mqtt box on an iot.data event matching the topic', () => {
    store.createWorkflow(APP, appDir, {
      name: 'MQTT',
      graph: {
        boxes: [
          { id: 'm', type: 'trigger.mqtt', config: { topic: 'sensors/+/temp' } },
          { id: 'n', type: 'action.notify', config: {} },
        ],
        edges: [{ from: 'm', to: 'n' }],
      },
    });
    // A non-matching topic → nothing.
    svc.onEvent(APP, 'iot.data' as CallbackEvent, { topic: 'sensors/a/hum' });
    expect(enqueue).not.toHaveBeenCalled();
    // A matching topic → one run, entered at the trigger.mqtt box.
    svc.onEvent(APP, 'iot.data' as CallbackEvent, { topic: 'sensors/a/temp', data: { c: 22 } });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1]).toMatchObject({
      trigger: { event: 'iot.data' },
      triggerBoxId: 'm',
    });
  });

  it('does nothing for a non-matching event', () => {
    store.createWorkflow(APP, appDir, { name: 'W', graph: eventTriggerGraph({ event: 'plate.detected' }) });
    svc.onEvent(APP, 'perimeter.intrusion' as CallbackEvent, {});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when the plugin is disabled', () => {
    repoGet.mockReturnValue({ pluginId: 'streamflow', enabled: false, config: {}, installedAt: '', updatedAt: '' });
    store.createWorkflow(APP, appDir, { name: 'W', graph: eventTriggerGraph() });
    svc.onEvent(APP, 'perimeter.intrusion' as CallbackEvent, {});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips disabled workflows', () => {
    const wf = store.createWorkflow(APP, appDir, { name: 'W', graph: eventTriggerGraph() });
    store.updateWorkflow(APP, appDir, wf.id, { enabled: false });
    svc.onEvent(APP, 'perimeter.intrusion' as CallbackEvent, {});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enforces the per-app rate limit (max_runs_per_min)', () => {
    repoGet.mockReturnValue({
      pluginId: 'streamflow',
      enabled: true,
      config: { max_runs_per_min: 2 },
      installedAt: '',
      updatedAt: '',
    });
    store.createWorkflow(APP, appDir, { name: 'W', graph: eventTriggerGraph() });
    for (let i = 0; i < 5; i++) {
      svc.onEvent(APP, 'perimeter.intrusion' as CallbackEvent, {});
    }
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('never re-triggers on its own streamflow.* events (loop guard)', () => {
    store.createWorkflow(APP, appDir, { name: 'W', graph: eventTriggerGraph({ event: '*' }) });
    svc.onEvent(APP, 'streamflow.run_finished' as CallbackEvent, {});
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('is visible to cluster events (node.offline) dispatched to the app', () => {
    store.createWorkflow(APP, appDir, {
      name: 'C',
      graph: eventTriggerGraph({ event: 'node.offline' }),
    });
    svc.onEvent(APP, 'node.offline' as CallbackEvent, { node: 'edge-1' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('runs a workflow manually', async () => {
    const wf = store.createWorkflow(APP, appDir, {
      name: 'W',
      graph: {
        boxes: [{ id: 'm', type: 'trigger.manual', config: {} }],
        edges: [],
      },
    });
    const run = await svc.manualRun(APP, wf.id, { hello: 'world' });
    expect(enqueue).toHaveBeenCalledWith(
      APP,
      expect.objectContaining({
        workflowId: wf.id,
        trigger: { event: 'trigger.manual', payload: { hello: 'world' } },
        triggerBoxId: 'm',
      }),
    );
    // enqueue is faked → the run row it "created" isn't in the store, so null is fine.
    expect(run === null || typeof run === 'object').toBe(true);
  });
});

/**
 * App-scoping boundary — the security invariant: a workflow only ever runs for
 * ITS OWN app's events. Two apps (distinct appDirs / streamflow.db files); an
 * event dispatched to app B must never enqueue app A's workflow.
 */
describe('StreamflowService — app scoping', () => {
  let tmp: string;
  let store: StreamflowStore;
  let enqueue: jest.Mock;
  let svc: StreamflowService;
  const dirs: Record<string, string> = {};

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-scope-'));
    dirs['appA'] = path.join(tmp, 'apps', 'appA');
    dirs['appB'] = path.join(tmp, 'apps', 'appB');
    store = new StreamflowStore();
    enqueue = jest.fn(async () => 'run-x');

    const config = { redisUrl: 'redis://x' } as never;
    const repo = {
      get: () => ({ pluginId: 'streamflow', enabled: true, config: {}, installedAt: '', updatedAt: '' }),
    } as never;
    const runner = { enqueue } as never;
    const callbacks = { onDispatch: jest.fn(() => () => undefined) } as never;
    const apps = {
      appDir: (app: string) => dirs[app],
      get: jest.fn(async () => ({ name: 'x' })),
      list: jest.fn(async () => [{ name: 'appA' }, { name: 'appB' }]),
    } as never;
    const logs = { write: jest.fn() } as never;

    svc = new StreamflowService(config, store, repo, runner, callbacks, apps, logs);
    svc.autoStart = false;
  });

  afterEach(() => {
    store.onModuleDestroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never fires app A's workflow for an event dispatched to app B", () => {
    store.createWorkflow('appA', dirs['appA'], {
      name: 'A-only',
      graph: {
        boxes: [
          { id: 't', type: 'trigger.event', config: { event: 'stream_started' } },
          { id: 'n', type: 'action.notify', config: {} },
        ],
        edges: [{ from: 't', to: 'n' }],
      },
    });
    // Same event, dispatched to app B → A's workflow must NOT run (cross-app leak).
    svc.onEvent('appB', 'stream_started' as CallbackEvent, {});
    expect(enqueue).not.toHaveBeenCalled();
    // Dispatched to app A → it runs.
    svc.onEvent('appA', 'stream_started' as CallbackEvent, {});
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe('appA');
  });
});
