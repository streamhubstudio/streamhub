/**
 * StreamflowRunner — owns the BullMQ queue/worker (`streamhub-streamflow`) and
 * executes one workflow run per job. It adapts the core services into the narrow
 * `BoxDeps` seam, walks the workflow graph (streamflow.graph) from its trigger
 * box, records every step + the run status to streamflow.db, and dispatches the
 * `streamflow.run_*` lifecycle events through the callbacks funnel.
 *
 * Boot never crashes when Redis is down (same shape as MetricsHistoryScheduler);
 * in tests the bullmq mock runs `add` inline, so enqueue → execute happens
 * synchronously without a broker. Secrets (the AI key) are never logged/emitted.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CallbackEvent,
  LOGS_SERVICE,
  LogsServiceContract,
  STREAMS_SERVICE,
  StreamsServiceContract,
} from '../../shared/contracts';
import { NOTIFIER_SERVICE } from '../notifications/notifier.contract';
import type { NotifierContract, NotifyChannel } from '../notifications/notifier.contract';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { bullConnectionOptions } from '../recording/bull-conn.util';
import { S3Service } from '../s3/s3.service';
import { CallbacksService } from '../callbacks/callbacks.service';
import { MqttService } from '../mqtt/mqtt.service';
import {
  assertSafeEgressUrl,
  CALLBACK_ALLOW_HOSTS_ENV,
  defaultHostResolver,
  HTTP_SCHEMES,
  parseAllowlistEnv,
  type HostResolver,
} from '../security/egress-url.guard';
import { AiClient } from './ai.client';
import type { AiProvider } from './ai.request';
import { redactSecretValues } from './secret-crypt.util';
import { StreamflowSecretsService } from './streamflow-secrets.service';
import { getExecutor } from './boxes/executors';
import {
  runCodeSandbox,
  runDbQuery,
  runShellCommand,
  runSshCommand,
} from './boxes/danger-exec';
import { newBag, type BoxContext, type BoxDeps } from './boxes/context';
import {
  findTriggerBox,
  runGraph,
  type GraphBox,
  type WorkflowGraph,
} from './streamflow.graph';
import { StreamflowStore } from './streamflow.store';

export const STREAMFLOW_QUEUE = 'streamhub-streamflow';

const RUN_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_STEPS = 100;

export interface RunTrigger {
  event: string;
  payload: Record<string, unknown>;
}

export interface EnqueueInput {
  workflowId: string;
  trigger: RunTrigger;
  /** The box the run enters at (the matched trigger box). */
  triggerBoxId?: string;
}

interface RunJobData {
  app: string;
  workflowId: string;
  runId: string;
  trigger: RunTrigger;
  triggerBoxId?: string;
}

/** Resolved per-app AI settings from the streamflow plugin config. */
interface ResolvedAiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  budgetUsd: number;
}

@Injectable()
export class StreamflowRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamflowRunner.name);
  private queue?: Queue;
  private worker?: Worker;
  /** Set false in unit specs (constructed directly) to skip the queue. */
  autoStart = true;
  /** DNS seam for the SSRF guard (specs inject a fake — never dial DNS). */
  hostResolver: HostResolver = defaultHostResolver;

  constructor(
    private readonly config: ConfigService,
    private readonly store: StreamflowStore,
    private readonly repo: AppPluginsRepository,
    private readonly s3: S3Service,
    private readonly ai: AiClient,
    private readonly callbacks: CallbacksService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(STREAMS_SERVICE) private readonly streams: StreamsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Optional()
    @Inject(NOTIFIER_SERVICE)
    private readonly notifier?: NotifierContract,
    @Optional() private readonly mqtt?: MqttService,
    @Optional() private readonly secrets?: StreamflowSecretsService,
  ) {}

  onModuleInit(): void {
    if (!this.autoStart) return;
    try {
      this.queue = new Queue(STREAMFLOW_QUEUE, {
        connection: bullConnectionOptions(this.config.redisUrl),
        defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
      });
      this.queue.on('error', (e) =>
        this.logger.warn(`streamflow queue error: ${e.message}`),
      );
      this.worker = new Worker(
        STREAMFLOW_QUEUE,
        async (job) => this.execute(job.data as RunJobData),
        { connection: bullConnectionOptions(this.config.redisUrl), concurrency: 4 },
      );
      this.worker.on('error', (e) =>
        this.logger.warn(`streamflow worker error: ${e.message}`),
      );
      this.worker.on('failed', (job, e) =>
        this.logger.error(`streamflow run ${job?.id ?? '?'} failed: ${e?.message ?? e}`),
      );
      this.logger.log('streamflow runner ready');
    } catch (e) {
      // Never crash boot — CRUD + reads still work; only run execution is off.
      this.logger.error(`failed to init streamflow queue: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.safeClose(() => this.worker?.close());
    await this.safeClose(() => this.queue?.close());
  }

  /**
   * Create a run row and enqueue its job. Returns the run id. When the queue is
   * unavailable the run is still recorded (failed) so history is honest.
   */
  async enqueue(app: string, input: EnqueueInput): Promise<string> {
    const appDir = this.apps.appDir(app);
    const run = this.store.createRun(app, appDir, {
      workflowId: input.workflowId,
      triggerEvent: input.trigger.event,
      status: 'queued',
    });
    const data: RunJobData = {
      app,
      workflowId: input.workflowId,
      runId: run.id,
      trigger: input.trigger,
      triggerBoxId: input.triggerBoxId,
    };
    if (!this.queue) {
      // No broker: execute inline best-effort so a single-node install still runs.
      await this.execute(data);
      return run.id;
    }
    try {
      await this.queue.add('run', data);
    } catch (err) {
      this.store.finishRun(app, appDir, run.id, 'failed', `enqueue failed: ${msg(err)}`);
    }
    return run.id;
  }

  /** Execute one run to completion. Never throws (records failure instead). */
  async execute(data: RunJobData): Promise<void> {
    const { app, workflowId, runId, trigger } = data;
    let appDir = '';
    try {
      appDir = this.apps.appDir(app);
    } catch {
      return;
    }
    const wf = this.store.getWorkflow(app, appDir, workflowId);
    if (!wf) {
      this.store.finishRun(app, appDir, runId, 'failed', 'workflow not found');
      return;
    }
    const graph = normalizeGraph(wf.graph);
    const startBox =
      (data.triggerBoxId && graph.boxes.find((b) => b.id === data.triggerBoxId)) ||
      findTriggerBox(graph, (t) => t.startsWith('trigger.'));
    if (!startBox) {
      this.store.finishRun(app, appDir, runId, 'failed', 'no trigger box in workflow');
      return;
    }

    this.store.setRunStatus(app, appDir, runId, 'running');
    void this.dispatchLifecycle(app, 'streamflow.run_started', {
      run: runId,
      workflow: workflowId,
      event: trigger.event,
    });

    const ctx: BoxContext = {
      app,
      appDir,
      dangerousEnabled: this.dangerousEnabled(app),
      trigger,
      bag: newBag(trigger.event, trigger.payload),
    };
    const deps = this.buildDeps(app);
    let seq = 0;
    const exec = async (box: GraphBox): Promise<{ output?: unknown; port?: string }> => {
      const executor = getExecutor(box.type);
      const start = Date.now();
      if (!executor) {
        this.store.recordStep(app, appDir, {
          runId,
          boxId: box.id,
          boxType: box.type,
          status: 'skipped',
          input: box.config,
          ms: 0,
          seq: seq++,
        });
        return { output: undefined, port: 'out' };
      }
      // Expand `{{secret.NAME}}` refs to plaintext into an EPHEMERAL config used
      // only for this executor call; the ORIGINAL config (ref intact) is what we
      // persist as the step input, and any resolved secret value is scrubbed from
      // the recorded output/error so secrets never enter run history or logs.
      const original = box.config ?? {};
      const { config: execConfig, used } = this.secrets
        ? this.secrets.expandConfig(app, appDir, original)
        : { config: original, used: [] as string[] };
      const scrub = (v: unknown): unknown =>
        used.length ? redactSecretValues(v, used) : v;
      try {
        const res = await executor({ id: box.id, type: box.type, config: execConfig }, ctx, deps);
        ctx.bag[box.id] = res.output;
        this.store.recordStep(app, appDir, {
          runId,
          boxId: box.id,
          boxType: box.type,
          status: 'ok',
          input: original,
          output: scrub(res.output),
          ms: Date.now() - start,
          seq: seq++,
        });
        return res;
      } catch (err) {
        this.store.recordStep(app, appDir, {
          runId,
          boxId: box.id,
          boxType: box.type,
          status: 'failed',
          input: original,
          ms: Date.now() - start,
          error: String(scrub(msg(err))),
          seq: seq++,
        });
        throw err;
      }
    };

    try {
      await withTimeout(
        runGraph(graph, startBox.id, exec, { maxSteps: MAX_STEPS }),
        RUN_TIMEOUT_MS,
      );
      this.store.finishRun(app, appDir, runId, 'ok', null);
      void this.dispatchLifecycle(app, 'streamflow.run_finished', {
        run: runId,
        workflow: workflowId,
        steps: seq,
      });
    } catch (err) {
      const error = msg(err);
      this.store.finishRun(app, appDir, runId, 'failed', error);
      void this.dispatchLifecycle(app, 'streamflow.run_failed', {
        run: runId,
        workflow: workflowId,
        error,
      });
      this.logs.write('warn', 'streamflow', `run '${runId}' failed: ${error}`, { app });
    }
  }

  // ---------------------------------------------------------------------------
  // BoxDeps — adapt the core services into the executor seam
  // ---------------------------------------------------------------------------

  private buildDeps(app: string): BoxDeps {
    return {
      snapshot: async ({ app: a, room, participantIdentity }) => {
        const r = await this.streams.snapshot({ appName: a, roomName: room, participantIdentity });
        return { key: r.key, url: r.url };
      },
      s3Upload: async ({ app: a, key, body, contentType }) => {
        const cfg = await this.apps.getConfig(a);
        const res = await this.s3.uploadBuffer(cfg.s3, body, key, contentType);
        let url = res.url;
        try {
          url = await this.s3.presignGet(cfg.s3, res.key, 3600);
        } catch {
          /* fall back to the object url */
        }
        return { key: res.key, url };
      },
      ai: async (input) => {
        const cfg = this.aiConfig(app);
        const r = await this.ai.chat({
          app: input.app,
          appDir: input.appDir,
          provider: cfg.provider,
          model: cfg.model,
          prompt: input.prompt,
          system: input.system,
          imageUrl: input.imageUrl,
          imageBase64: input.imageBase64,
          jsonMode: input.jsonMode,
          maxTokens: input.maxTokens,
          apiKey: cfg.apiKey,
          apiKeyRef: 'STREAMFLOW_AI_API_KEY',
          budgetUsd: cfg.budgetUsd,
        });
        let json: unknown;
        if (input.jsonMode && r.text) {
          try {
            json = JSON.parse(r.text);
          } catch {
            /* not strict JSON */
          }
        }
        return { text: r.text, usageTokens: r.usageTokens, json };
      },
      httpPost: async ({ url, body, headers, timeoutMs }) =>
        this.postJson(url, body, headers, timeoutMs, 'action.http URL'),
      emit: async ({ app: a, event, payload }) => {
        await this.callbacks.dispatch(a, event as CallbackEvent, payload);
      },
      mqttPublish: async ({ app: a, topic, payload, qos, retain }) => {
        if (!this.mqtt) return;
        await this.mqtt.publishRaw(a, topic, payload, { qos, retain });
      },
      notify: async ({ app: a, event, payload, title, channels }) => {
        if (!this.notifier) return;
        await this.notifier.notify(a, event as CallbackEvent, payload, {
          title,
          channels: channels as NotifyChannel[] | undefined,
        });
      },
      pluginEvent: async ({ app: a, pluginId, event, data, room, token, url }) => {
        const base = (url && url.trim()) || this.config.publicBaseUrl || 'http://127.0.0.1:3020';
        const target =
          `${base.replace(/\/+$/, '')}/api/v1/apps/${encodeURIComponent(a)}` +
          `/plugins/${encodeURIComponent(pluginId)}/events`;
        const headers: Record<string, string> = {};
        if (token) headers['x-plugin-ingest-token'] = token;
        const res = await this.postJson(
          target,
          { event, room, data },
          headers,
          HTTP_TIMEOUT_MS,
          'action.plugin URL',
        );
        return { ok: res.ok, status: res.status };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      log: (level, m, meta) => this.logs.write(level, 'streamflow', m, { app, ...meta }),
      // --- DANGEROUS execution seams (only reached when the box runs, which is
      //     itself gated by ctx.dangerousEnabled + palette hiding) ------------
      runCode: (i) => runCodeSandbox(i),
      runShell: (i) => runShellCommand(i),
      runSsh: (i) => runSshCommand(i),
      runDb: (i) => runDbQuery(i),
    };
  }

  /** Whether the app enabled flag-gated execution nodes (default false). */
  private dangerousEnabled(app: string): boolean {
    const c = (this.repo.get(app, 'streamflow')?.config ?? {}) as Record<string, unknown>;
    return c.dangerousNodes === true;
  }

  /** SSRF-guarded JSON POST with a bounded timeout. */
  private async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> | undefined,
    timeoutMs: number | undefined,
    label: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    await assertSafeEgressUrl(url, {
      allowedSchemes: HTTP_SCHEMES,
      label,
      allowlist: parseAllowlistEnv(process.env[CALLBACK_ALLOW_HOSTS_ENV]),
      resolveHost: this.hostResolver,
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs && timeoutMs > 0 ? timeoutMs : HTTP_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  private aiConfig(app: string): ResolvedAiConfig {
    const c = (this.repo.get(app, 'streamflow')?.config ?? {}) as Record<string, unknown>;
    const provider = c.ai_provider === 'deepseek' ? 'deepseek' : 'openai';
    return {
      provider,
      model: typeof c.ai_model === 'string' && c.ai_model.trim() ? c.ai_model.trim() : 'gpt-4o-mini',
      apiKey: typeof c.ai_api_key === 'string' ? c.ai_api_key : '',
      budgetUsd:
        typeof c.ai_budget_monthly_usd === 'number' && c.ai_budget_monthly_usd > 0
          ? c.ai_budget_monthly_usd
          : 0,
    };
  }

  private async dispatchLifecycle(
    app: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.callbacks.dispatch(app, event, payload);
    } catch {
      /* lifecycle emit is best-effort */
    }
  }

  private async safeClose(fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`shutdown cleanup error: ${(e as Error).message}`);
    }
  }
}

function normalizeGraph(graph: unknown): WorkflowGraph {
  const g = (graph ?? {}) as { boxes?: unknown; edges?: unknown };
  return {
    boxes: Array.isArray(g.boxes) ? (g.boxes as GraphBox[]) : [],
    edges: Array.isArray(g.edges) ? (g.edges as WorkflowGraph['edges']) : [],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
