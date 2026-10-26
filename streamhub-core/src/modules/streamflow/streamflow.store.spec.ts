/**
 * Unit spec — StreamflowStore (streamflow module).
 *
 * Drives the per-app streamflow.db against a temp dir (fileFor seam). Locks
 * down: workflow CRUD + enabled filter, run/step lifecycle + ordering, bounded
 * history prune (>retention), delete cascade, and the AI monthly-usage budget
 * accumulator.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StreamflowStore, currentMonth } from './streamflow.store';

const APP = 'live';

describe('StreamflowStore', () => {
  let tmp: string;
  let store: StreamflowStore;
  let appDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-store-'));
    appDir = path.join(tmp, 'apps', APP);
    store = new StreamflowStore();
  });

  afterEach(() => {
    store.onModuleDestroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates, lists, gets, updates and deletes workflows', () => {
    const wf = store.createWorkflow(APP, appDir, {
      name: 'Intrusion',
      graph: { boxes: [{ id: 'a' }], edges: [] },
    });
    expect(wf.id).toBeTruthy();
    expect(wf.enabled).toBe(true);
    expect(wf.graph).toEqual({ boxes: [{ id: 'a' }], edges: [] });

    expect(store.listWorkflows(APP, appDir)).toHaveLength(1);
    expect(store.getWorkflow(APP, appDir, wf.id)?.name).toBe('Intrusion');

    const upd = store.updateWorkflow(APP, appDir, wf.id, {
      name: 'Renamed',
      enabled: false,
    });
    expect(upd?.name).toBe('Renamed');
    expect(upd?.enabled).toBe(false);
    expect(store.listEnabled(APP, appDir)).toHaveLength(0);

    expect(store.deleteWorkflow(APP, appDir, wf.id)).toBe(true);
    expect(store.listWorkflows(APP, appDir)).toHaveLength(0);
  });

  it('records a run + ordered steps and reads them back', () => {
    const wf = store.createWorkflow(APP, appDir, { name: 'W' });
    const run = store.createRun(APP, appDir, {
      workflowId: wf.id,
      triggerEvent: 'plate.detected',
      status: 'running',
    });
    expect(run.status).toBe('running');

    store.recordStep(APP, appDir, {
      runId: run.id,
      boxId: 'b1',
      boxType: 'trigger.event',
      status: 'ok',
      input: { x: 1 },
      output: { y: 2 },
      ms: 5,
      seq: 0,
    });
    store.recordStep(APP, appDir, {
      runId: run.id,
      boxId: 'b2',
      boxType: 'action.notify',
      status: 'failed',
      error: 'boom',
      seq: 1,
    });

    store.finishRun(APP, appDir, run.id, 'failed', 'boom');
    const got = store.getRun(APP, appDir, run.id);
    expect(got?.status).toBe('failed');
    expect(got?.error).toBe('boom');
    expect(got?.endedAt).toBeTruthy();

    const steps = store.listSteps(APP, appDir, run.id);
    expect(steps.map((s) => s.boxId)).toEqual(['b1', 'b2']);
    expect(steps[0].output).toEqual({ y: 2 });
    expect(steps[1].status).toBe('failed');
  });

  it('filters runs by workflow and caps the limit', () => {
    const a = store.createWorkflow(APP, appDir, { name: 'A' });
    const b = store.createWorkflow(APP, appDir, { name: 'B' });
    for (let i = 0; i < 3; i++)
      store.createRun(APP, appDir, { workflowId: a.id, triggerEvent: 'e' });
    store.createRun(APP, appDir, { workflowId: b.id, triggerEvent: 'e' });

    expect(store.listRuns(APP, appDir, { workflowId: a.id })).toHaveLength(3);
    expect(store.listRuns(APP, appDir)).toHaveLength(4);
    expect(store.listRuns(APP, appDir, { limit: 2 })).toHaveLength(2);
  });

  it('prunes runs older than the retention window and cascades steps', () => {
    const wf = store.createWorkflow(APP, appDir, { name: 'W' });
    const db = store.db(APP, appDir);
    // One fresh run + one backdated 40 days.
    const fresh = store.createRun(APP, appDir, { workflowId: wf.id, triggerEvent: 'e' });
    const old = store.createRun(APP, appDir, { workflowId: wf.id, triggerEvent: 'e' });
    store.recordStep(APP, appDir, {
      runId: old.id,
      boxId: 'b',
      boxType: 't',
      status: 'ok',
      seq: 0,
    });
    db.prepare(
      "UPDATE runs SET started_at = datetime('now','-40 days') WHERE id = ?",
    ).run(old.id);

    const pruned = store.pruneHistory(APP, appDir, 30);
    expect(pruned).toBe(1);
    expect(store.getRun(APP, appDir, old.id)).toBeNull();
    expect(store.getRun(APP, appDir, fresh.id)).not.toBeNull();
    expect(store.listSteps(APP, appDir, old.id)).toHaveLength(0);
  });

  it('deleting a workflow removes its runs + steps', () => {
    const wf = store.createWorkflow(APP, appDir, { name: 'W' });
    const run = store.createRun(APP, appDir, { workflowId: wf.id, triggerEvent: 'e' });
    store.recordStep(APP, appDir, {
      runId: run.id,
      boxId: 'b',
      boxType: 't',
      status: 'ok',
      seq: 0,
    });
    store.deleteWorkflow(APP, appDir, wf.id);
    expect(store.listRuns(APP, appDir)).toHaveLength(0);
    expect(store.listSteps(APP, appDir, run.id)).toHaveLength(0);
  });

  it('accumulates monthly AI usage for the budget guard', () => {
    const month = currentMonth();
    expect(store.monthlyUsd(APP, appDir)).toBe(0);
    store.addUsage(APP, appDir, 1000, 0.5);
    store.addUsage(APP, appDir, 500, 0.25);
    expect(store.monthlyUsd(APP, appDir, month)).toBeCloseTo(0.75, 5);
    // A different month is a separate bucket.
    expect(store.monthlyUsd(APP, appDir, '1999-01')).toBe(0);
  });
});
