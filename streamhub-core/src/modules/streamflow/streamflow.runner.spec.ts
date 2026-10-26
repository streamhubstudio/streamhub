/**
 * Unit spec — StreamflowRunner end-to-end run execution.
 *
 * Constructs the runner directly (autoStart off → no BullMQ) with a REAL store
 * (temp dir) + fake core services. Drives a full run through enqueue→execute:
 *  - a linear trigger→condition(true)→emit flow persists ok + ordered steps and
 *    dispatches run_started / the emit event / run_finished;
 *  - a box that throws marks the run failed, records the failing step's error,
 *    and dispatches run_failed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StreamflowRunner } from './streamflow.runner';
import { StreamflowSecretsService } from './streamflow-secrets.service';
import { StreamflowStore } from './streamflow.store';

const APP = 'live';

function makeRunner(over: Record<string, unknown> = {}): {
  runner: StreamflowRunner;
  store: StreamflowStore;
  appDir: string;
  dispatch: jest.Mock;
  snapshot: jest.Mock;
  cleanup: () => void;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-run-'));
  const appDir = path.join(tmp, 'apps', APP);
  const store = new StreamflowStore();
  const dispatch = jest.fn(async () => undefined);
  const snapshot = jest.fn(async () => ({ key: 'k', url: 'http://s/k.jpg' }));

  const config = { redisUrl: 'redis://x', publicBaseUrl: '' } as never;
  const repo = { get: () => ({ config: { ai_model: 'gpt-4o-mini' } }) } as never;
  const s3 = { uploadBuffer: jest.fn(), presignGet: jest.fn() } as never;
  const ai = { chat: jest.fn(async () => ({ text: 'ok', usageTokens: 1, estUsd: 0 })) } as never;
  const callbacks = { dispatch } as never;
  const apps = { appDir: () => appDir, getConfig: async () => ({ s3: {} }) } as never;
  const streams = { snapshot } as never;
  const logs = { write: jest.fn() } as never;
  const notifier = { notify: jest.fn(async () => undefined) } as never;

  const runner = new StreamflowRunner(
    config,
    store,
    repo,
    s3,
    ai,
    callbacks,
    apps,
    streams,
    logs,
    notifier,
  );
  runner.autoStart = false;
  runner.hostResolver = async () => ['93.184.216.34'];
  Object.assign(runner, over);

  return {
    runner,
    store,
    appDir,
    dispatch,
    snapshot,
    cleanup: () => {
      store.onModuleDestroy();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('StreamflowRunner.execute', () => {
  it('runs a linear trigger→condition(true)→emit flow to ok', async () => {
    const { runner, store, appDir, dispatch, cleanup } = makeRunner();
    try {
      const wf = store.createWorkflow(APP, appDir, {
        name: 'Flow',
        graph: {
          boxes: [
            { id: 't', type: 'trigger.event', config: {} },
            { id: 'c', type: 'logic.condition', config: { rules: [{ field: 'trigger.conf', op: 'gt', value: 0.5 }] } },
            { id: 'e', type: 'action.emit', config: { event: 'streamflow.output', payload: { ok: true } } },
          ],
          edges: [
            { from: 't', to: 'c' },
            { from: 'c', fromPort: 'true', to: 'e' },
          ],
        },
      });

      const runId = await runner.enqueue(APP, {
        workflowId: wf.id,
        trigger: { event: 'perimeter.intrusion', payload: { conf: 0.9, room: 'gate' } },
        triggerBoxId: 't',
      });

      const run = store.getRun(APP, appDir, runId);
      expect(run?.status).toBe('ok');
      const steps = store.listSteps(APP, appDir, runId);
      expect(steps.map((s) => s.boxId)).toEqual(['t', 'c', 'e']);
      expect(steps.every((s) => s.status === 'ok')).toBe(true);

      const events = dispatch.mock.calls.map((c) => c[1]);
      expect(events).toContain('streamflow.run_started');
      expect(events).toContain('streamflow.output');
      expect(events).toContain('streamflow.run_finished');
    } finally {
      cleanup();
    }
  });

  it('does NOT take the false branch when the condition is false', async () => {
    const { runner, store, appDir, cleanup } = makeRunner();
    try {
      const wf = store.createWorkflow(APP, appDir, {
        name: 'Flow',
        graph: {
          boxes: [
            { id: 't', type: 'trigger.event', config: {} },
            { id: 'c', type: 'logic.condition', config: { rules: [{ field: 'trigger.conf', op: 'gt', value: 0.95 }] } },
            { id: 'e', type: 'action.emit', config: {} },
          ],
          edges: [
            { from: 't', to: 'c' },
            { from: 'c', fromPort: 'true', to: 'e' },
          ],
        },
      });
      const runId = await runner.enqueue(APP, {
        workflowId: wf.id,
        trigger: { event: 'x', payload: { conf: 0.9 } },
        triggerBoxId: 't',
      });
      const steps = store.listSteps(APP, appDir, runId);
      expect(steps.map((s) => s.boxId)).toEqual(['t', 'c']); // 'e' never ran
      expect(store.getRun(APP, appDir, runId)?.status).toBe('ok');
    } finally {
      cleanup();
    }
  });

  it('expands {{secret.NAME}} at run time; step input keeps the ref, output is scrubbed', async () => {
    const { runner, store, appDir, cleanup } = makeRunner();
    try {
      // A real secrets service over the SAME store, holding TOKEN.
      const secrets = new StreamflowSecretsService(
        { jwtSecret: 'jwt-x' } as never,
        store,
        { get: async () => ({ name: APP }), appDir: () => appDir } as never,
      );
      await secrets.put(APP, 'TOKEN', 'shh-secret-value');
      (runner as unknown as { secrets: StreamflowSecretsService }).secrets = secrets;

      const wf = store.createWorkflow(APP, appDir, {
        name: 'Flow',
        graph: {
          boxes: [
            { id: 't', type: 'trigger.manual', config: {} },
            { id: 'v', type: 'logic.setvar', config: { set: { 'vars.k': '{{secret.TOKEN}}' } } },
          ],
          edges: [{ from: 't', to: 'v' }],
        },
      });
      const runId = await runner.enqueue(APP, {
        workflowId: wf.id,
        trigger: { event: 'trigger.manual', payload: {} },
        triggerBoxId: 't',
      });

      const steps = store.listSteps(APP, appDir, runId);
      const setvar = steps.find((s) => s.boxId === 'v')!;
      // The persisted INPUT keeps the ref (never the value).
      expect(JSON.stringify(setvar.input)).toContain('{{secret.TOKEN}}');
      expect(JSON.stringify(setvar.input)).not.toContain('shh-secret-value');
      // The persisted OUTPUT is scrubbed (the executor DID see the plaintext, but
      // the resolved value never lands in run history).
      expect(JSON.stringify(setvar.output)).not.toContain('shh-secret-value');
      expect(JSON.stringify(setvar.output)).toContain('[redacted]');
    } finally {
      cleanup();
    }
  });

  it('marks the run failed and records the step error when a box throws', async () => {
    const snapshot = jest.fn(async () => {
      throw new Error('camera down');
    });
    const { runner, store, appDir, dispatch, cleanup } = makeRunner({ });
    // Swap the streams dep to the throwing one via the private field.
    (runner as unknown as { streams: { snapshot: jest.Mock } }).streams = { snapshot };
    try {
      const wf = store.createWorkflow(APP, appDir, {
        name: 'Flow',
        graph: {
          boxes: [
            { id: 't', type: 'trigger.event', config: {} },
            { id: 's', type: 'action.snapshot', config: { room: 'gate' } },
          ],
          edges: [{ from: 't', to: 's' }],
        },
      });
      const runId = await runner.enqueue(APP, {
        workflowId: wf.id,
        trigger: { event: 'perimeter.intrusion', payload: { room: 'gate' } },
        triggerBoxId: 't',
      });

      const run = store.getRun(APP, appDir, runId);
      expect(run?.status).toBe('failed');
      expect(run?.error).toContain('camera down');
      const steps = store.listSteps(APP, appDir, runId);
      const failed = steps.find((s) => s.boxId === 's');
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toContain('camera down');
      expect(dispatch.mock.calls.map((c) => c[1])).toContain('streamflow.run_failed');
    } finally {
      cleanup();
    }
  });
});
