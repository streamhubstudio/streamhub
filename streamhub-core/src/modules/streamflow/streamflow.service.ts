/**
 * StreamflowService — the engine front door.
 *
 *  - onModuleInit taps CallbacksService.onDispatch (the single event funnel):
 *    every dispatched event is matched against the enabled workflows' trigger
 *    boxes (event + optional room/tags/predicate) and, per-app rate-limited, a
 *    run is enqueued on the StreamflowRunner.
 *  - manual runs (Run button / POST …/run) and schedule triggers (BullMQ
 *    repeatable) also enqueue through the runner.
 *  - owns the workflow/run CRUD the controller exposes (app existence checked).
 *
 * Only reacts for apps where the `streamflow` plugin is installed + enabled
 * (AppPluginsRepository). Every tap path is best-effort and never throws into
 * the media/callback plane.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CallbackEvent,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { CallbacksService } from '../callbacks/callbacks.service';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { bullConnectionOptions } from '../recording/bull-conn.util';
import { boxCatalogue, BoxSpec } from './boxes/catalogue';
import { EVENT_CATALOGUE } from './boxes/event-catalogue';
import { matchesEventTrigger, matchesMqttTrigger } from './boxes/executors';
import {
  exportWorkflow as toPortable,
  GraphImportError,
  importWorkflow as fromPortable,
  type PortableWorkflow,
} from './boxes/portable';
import { findTriggerBox, type GraphBox, type WorkflowGraph } from './streamflow.graph';
import { StreamflowRunner } from './streamflow.runner';
import { RunRow, StepRow, StreamflowStore, WorkflowRow } from './streamflow.store';

export const STREAMFLOW_CRON_QUEUE = 'streamhub-streamflow-cron';
const PLUGIN_ID = 'streamflow';
const RECONCILE_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_RUNS_PER_MIN = 60;

interface CronJobData {
  app: string;
  workflowId: string;
  boxId: string;
}

@Injectable()
export class StreamflowService implements OnModuleInit, OnModuleDestroy {
  /** Set false in unit specs to skip the trigger hook + cron + reconcile loops. */
  autoStart = true;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private cronQueue?: Queue;
  private cronWorker?: Worker;
  /** app → recent run start timestamps (rate limit window). */
  private readonly rate = new Map<string, number[]>();

  constructor(
    private readonly config: ConfigService,
    private readonly store: StreamflowStore,
    private readonly repo: AppPluginsRepository,
    private readonly runner: StreamflowRunner,
    private readonly callbacks: CallbacksService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  onModuleInit(): void {
    if (!this.autoStart) return;
    // Trigger hook — the whole point of the engine.
    this.unsubscribe = this.callbacks.onDispatch((app, event, payload) =>
      this.onEvent(app, event, payload),
    );
    this.initCron();
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    try {
      await this.cronWorker?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.cronQueue?.close();
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Trigger hook
  // ---------------------------------------------------------------------------

  /**
   * Match one dispatched event against the app's enabled workflows and enqueue a
   * run per matching `trigger.event` box. Public for unit tests. Never throws.
   */
  onEvent(app: string, event: CallbackEvent, payload: Record<string, unknown>): void {
    try {
      // Never re-trigger on our own emitted events (loop guard).
      if (typeof event === 'string' && event.startsWith('streamflow.')) return;
      const row = this.repo.get(app, PLUGIN_ID);
      if (!row || !row.enabled) return;

      let appDir = '';
      try {
        appDir = this.apps.appDir(app);
      } catch {
        return;
      }
      // `trigger.mqtt` is sugar over the funnel: the generic MQTT-in subscriber
      // and the ws-ingest data frame both dispatch `iot.data`, so a shipped
      // `trigger.mqtt{topic}` box fires when an `iot.data` event's topic matches
      // its filter — no separate subscriber inside streamflow (design section 4).
      const isIotData = event === 'iot.data';
      const workflows = this.store.listEnabled(app, appDir);
      for (const wf of workflows) {
        const graph = normalizeGraph(wf.graph);
        const box = graph.boxes.find(
          (b) =>
            (b.type === 'trigger.event' &&
              matchesEventTrigger(b.config ?? {}, event, payload ?? {})) ||
            (b.type === 'trigger.mqtt' &&
              isIotData &&
              matchesMqttTrigger(b.config ?? {}, payload ?? {})),
        );
        if (!box) continue;
        if (!this.allowRun(app, row.config)) {
          this.logs.write('warn', 'streamflow', `rate limit hit for app '${app}'`, {
            app,
            event,
          });
          break;
        }
        void this.runner
          .enqueue(app, {
            workflowId: wf.id,
            trigger: { event, payload: payload ?? {} },
            triggerBoxId: box.id,
          })
          .catch(() => undefined);
      }
    } catch {
      /* a trigger match must never break dispatch */
    }
  }

  /** Per-app sliding-window rate check (records a slot when it allows). */
  private allowRun(app: string, config: Record<string, unknown>): boolean {
    const max = numCfg(config?.max_runs_per_min, DEFAULT_MAX_RUNS_PER_MIN);
    const now = Date.now();
    const arr = (this.rate.get(app) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= max) {
      this.rate.set(app, arr);
      return false;
    }
    arr.push(now);
    this.rate.set(app, arr);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Manual run
  // ---------------------------------------------------------------------------

  async manualRun(
    app: string,
    workflowId: string,
    payload?: Record<string, unknown>,
  ): Promise<RunRow | null> {
    const appDir = await this.requireApp(app);
    const wf = this.store.getWorkflow(app, appDir, workflowId);
    if (!wf) throw new NotFoundException(`workflow '${workflowId}' not found`);
    const graph = normalizeGraph(wf.graph);
    const startBox =
      graph.boxes.find((b) => b.type === 'trigger.manual') ??
      findTriggerBox(graph, (t) => t.startsWith('trigger.'));
    const runId = await this.runner.enqueue(app, {
      workflowId,
      trigger: { event: 'trigger.manual', payload: payload ?? {} },
      triggerBoxId: startBox?.id,
    });
    return this.store.getRun(app, appDir, runId);
  }

  // ---------------------------------------------------------------------------
  // Workflow + run CRUD (controller)
  // ---------------------------------------------------------------------------

  async listWorkflows(app: string): Promise<WorkflowRow[]> {
    const appDir = await this.requireApp(app);
    return this.store.listWorkflows(app, appDir);
  }

  async createWorkflow(
    app: string,
    input: { name: string; enabled?: boolean; graph?: unknown },
  ): Promise<WorkflowRow> {
    const appDir = await this.requireApp(app);
    return this.store.createWorkflow(app, appDir, input);
  }

  async getWorkflow(app: string, id: string): Promise<WorkflowRow> {
    const appDir = await this.requireApp(app);
    const wf = this.store.getWorkflow(app, appDir, id);
    if (!wf) throw new NotFoundException(`workflow '${id}' not found`);
    return wf;
  }

  async updateWorkflow(
    app: string,
    id: string,
    patch: { name?: string; enabled?: boolean; graph?: unknown },
  ): Promise<WorkflowRow> {
    const appDir = await this.requireApp(app);
    if (!this.store.getWorkflow(app, appDir, id)) {
      throw new NotFoundException(`workflow '${id}' not found`);
    }
    return this.store.updateWorkflow(app, appDir, id, patch) as WorkflowRow;
  }

  async setEnabled(app: string, id: string, enabled: boolean): Promise<WorkflowRow> {
    return this.updateWorkflow(app, id, { enabled });
  }

  async deleteWorkflow(app: string, id: string): Promise<{ deleted: boolean }> {
    const appDir = await this.requireApp(app);
    return { deleted: this.store.deleteWorkflow(app, appDir, id) };
  }

  async listRuns(
    app: string,
    opts: { workflowId?: string; limit?: number } = {},
  ): Promise<RunRow[]> {
    const appDir = await this.requireApp(app);
    return this.store.listRuns(app, appDir, opts);
  }

  async getRun(
    app: string,
    id: string,
  ): Promise<{ run: RunRow; steps: StepRow[] }> {
    const appDir = await this.requireApp(app);
    const run = this.store.getRun(app, appDir, id);
    if (!run) throw new NotFoundException(`run '${id}' not found`);
    return { run, steps: this.store.listSteps(app, appDir, id) };
  }

  /**
   * The box-type palette the UI renders. Dangerous execution boxes are included
   * only when the app enabled `streamflow.dangerousNodes` (default off).
   */
  boxes(app: string): BoxSpec[] {
    return boxCatalogue({ dangerous: this.dangerousEnabled(app) });
  }

  /** Whether the app enabled the flag-gated execution nodes (default false). */
  dangerousEnabled(app: string): boolean {
    const cfg = (this.repo.get(app, PLUGIN_ID)?.config ?? {}) as Record<string, unknown>;
    return cfg.dangerousNodes === true;
  }

  /** The discoverable event catalogue the `trigger.event` picker renders. */
  events(): typeof EVENT_CATALOGUE {
    return EVENT_CATALOGUE;
  }

  // ---------------------------------------------------------------------------
  // Export / import (portable JSON — secret-safe, catalogue-validated)
  // ---------------------------------------------------------------------------

  /** Export one workflow as portable JSON (no db ids/timestamps, no secrets). */
  async exportWorkflow(app: string, id: string): Promise<PortableWorkflow> {
    const wf = await this.getWorkflow(app, id);
    return toPortable(wf);
  }

  /**
   * Create a new workflow from portable JSON. Validates the graph against the
   * box catalogue (unknown box type → 400) before persisting.
   */
  async importWorkflow(
    app: string,
    raw: unknown,
    name?: string,
  ): Promise<WorkflowRow> {
    const appDir = await this.requireApp(app);
    let parsed: { name: string; graph: unknown };
    try {
      // Validate against the FULL catalogue (incl. dangerous boxes) so a portable
      // workflow that names an execution box still imports; it just won't run
      // until the app enables streamflow.dangerousNodes.
      parsed = fromPortable(raw, boxCatalogue({ dangerous: true }));
    } catch (err) {
      if (err instanceof GraphImportError) {
        throw new BadRequestException(err.message);
      }
      throw new BadRequestException(
        err instanceof Error ? err.message : 'invalid workflow',
      );
    }
    const finalName =
      typeof name === 'string' && name.trim() ? name.trim() : parsed.name;
    return this.store.createWorkflow(app, appDir, {
      name: finalName,
      graph: parsed.graph,
    });
  }

  // ---------------------------------------------------------------------------
  // Schedule triggers (BullMQ repeatable) + history prune
  // ---------------------------------------------------------------------------

  private initCron(): void {
    try {
      this.cronQueue = new Queue(STREAMFLOW_CRON_QUEUE, {
        connection: bullConnectionOptions(this.config.redisUrl),
        defaultJobOptions: { removeOnComplete: 20, removeOnFail: 50 },
      });
      this.cronQueue.on('error', () => undefined);
      this.cronWorker = new Worker(
        STREAMFLOW_CRON_QUEUE,
        async (job) => {
          const d = job.data as CronJobData;
          await this.runner.enqueue(d.app, {
            workflowId: d.workflowId,
            trigger: { event: 'trigger.schedule', payload: { firedAt: new Date().toISOString() } },
            triggerBoxId: d.boxId,
          });
        },
        { connection: bullConnectionOptions(this.config.redisUrl), concurrency: 2 },
      );
      this.cronWorker.on('error', () => undefined);
    } catch {
      // Never crash boot — schedules just won't fire without a broker.
      this.cronQueue = undefined;
      this.cronWorker = undefined;
    }
  }

  /** Bring schedules in line with install state + prune history. Best-effort. */
  async reconcile(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await this.apps.list()).map((a) => a.name);
    } catch {
      return;
    }
    for (const app of names) {
      try {
        const row = this.repo.get(app, PLUGIN_ID);
        if (!row || !row.enabled) continue;
        const appDir = this.apps.appDir(app);
        try {
          this.store.pruneHistory(app, appDir, 30);
        } catch {
          /* prune is best-effort */
        }
        if (!this.cronQueue) continue;
        for (const wf of this.store.listEnabled(app, appDir)) {
          const graph = normalizeGraph(wf.graph);
          for (const box of graph.boxes) {
            if (box.type !== 'trigger.schedule') continue;
            await this.registerSchedule(app, wf.id, box);
          }
        }
      } catch {
        /* one app's failure never blocks the others */
      }
    }
  }

  private async registerSchedule(
    app: string,
    workflowId: string,
    box: GraphBox,
  ): Promise<void> {
    if (!this.cronQueue) return;
    const cfg = box.config ?? {};
    const cron = typeof cfg.cron === 'string' ? cfg.cron.trim() : '';
    const every = numCfg(cfg.everySeconds, 0);
    const repeat = cron
      ? { pattern: cron }
      : every > 0
        ? { every: every * 1000 }
        : null;
    if (!repeat) return;
    const jobId = `sched:${app}:${workflowId}:${box.id}`;
    try {
      await this.cronQueue.add(
        'schedule',
        { app, workflowId, boxId: box.id } satisfies CronJobData,
        { repeat, jobId },
      );
    } catch {
      /* best-effort */
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Verify the app exists; returns its dir. Throws 404 otherwise. */
  private async requireApp(app: string): Promise<string> {
    const rec = await this.apps.get(app).catch(() => null);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
    return this.apps.appDir(app);
  }
}

function normalizeGraph(graph: unknown): WorkflowGraph {
  const g = (graph ?? {}) as { boxes?: unknown; edges?: unknown };
  return {
    boxes: Array.isArray(g.boxes) ? (g.boxes as GraphBox[]) : [],
    edges: Array.isArray(g.edges) ? (g.edges as WorkflowGraph['edges']) : [],
  };
}

function numCfg(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
