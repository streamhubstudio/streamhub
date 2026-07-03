/**
 * WORKER HOOK — start/stop an external per-app worker process for plugins that
 * declare `needsWorker` (e.g. a YOLO detector). The core owns the lifecycle and
 * logging; the plugin only supplies a spawn spec (command/args/env) via its
 * `worker.spawn(ctx)`. The plugin never touches child_process itself, keeping it
 * fully decoupled from the core.
 *
 * State is keyed by `${app}::${pluginId}` so each app runs its own worker. A
 * small in-memory ring buffer keeps recent stdout/stderr lines for the per-plugin
 * logs endpoint; lines are ALSO mirrored to LogsService (source `plugin:<id>`).
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { ConfigService } from '../../shared/config/config.service';
import {
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { PluginMeta, PluginWorkerContext } from './plugin.contract';

export type WorkerStatus = 'running' | 'stopped' | 'crashed' | 'starting';

export interface WorkerState {
  app: string;
  pluginId: string;
  status: WorkerStatus;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  /** Last error message when status is 'crashed'. */
  error?: string;
}

export interface WorkerLogLine {
  ts: string;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

interface WorkerEntry {
  state: WorkerState;
  child?: ChildProcess;
  logs: WorkerLogLine[];
  /** A plugin_worker_error was already emitted for this run (dupe guard). */
  errorNotified?: boolean;
  /** Random per-start secret a worker echoes to POST :id/live (ingest auth). */
  ingestToken?: string;
}

const MAX_LOG_LINES = 500;

@Injectable()
export class PluginWorkerManager implements OnModuleDestroy {
  private readonly logger = new Logger(PluginWorkerManager.name);
  private readonly workers = new Map<string, WorkerEntry>();

  constructor(
    private readonly config: ConfigService,
    @Inject(LOGS_SERVICE) private readonly logsSvc: LogsServiceContract,
    @Optional()
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks?: CallbacksServiceContract,
  ) {}

  /**
   * Emit a plugin worker lifecycle event (plugin_worker_started/_stopped/
   * _error) through the callbacks funnel → app webhook + MQTT tap.
   * Fire-and-forget; a dispatch failure never affects the worker lifecycle.
   */
  private notify(
    app: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): void {
    if (!this.callbacks) return;
    try {
      void this.callbacks.dispatch(app, event, payload).catch(() => undefined);
    } catch {
      /* never break the worker lifecycle */
    }
  }

  onModuleDestroy(): void {
    for (const entry of this.workers.values()) {
      entry.child?.kill('SIGTERM');
    }
    this.workers.clear();
  }

  private key(app: string, pluginId: string): string {
    return `${app}::${pluginId}`;
  }

  /** Current worker state, or a synthetic 'stopped' if never started. */
  status(app: string, pluginId: string): WorkerState {
    const entry = this.workers.get(this.key(app, pluginId));
    return entry
      ? entry.state
      : { app, pluginId, status: 'stopped' };
  }

  isRunning(app: string, pluginId: string): boolean {
    const s = this.status(app, pluginId).status;
    return s === 'running' || s === 'starting';
  }

  /** Recent buffered log lines for a worker (newest last). */
  logs(app: string, pluginId: string, limit = 200): WorkerLogLine[] {
    const entry = this.workers.get(this.key(app, pluginId));
    if (!entry) return [];
    return entry.logs.slice(-Math.max(1, limit));
  }

  /**
   * The live-data ingest token for a RUNNING worker (undefined when stopped —
   * a dead worker must not be able to keep pushing). The service layer compares
   * this against the `x-plugin-ingest-token` header of POST :id/live.
   */
  ingestToken(app: string, pluginId: string): string | undefined {
    if (!this.isRunning(app, pluginId)) return undefined;
    return this.workers.get(this.key(app, pluginId))?.ingestToken;
  }

  /**
   * Start the worker for an installed plugin. Idempotent: if already running,
   * returns the existing state. Throws if the plugin has no worker descriptor.
   */
  start(
    meta: PluginMeta,
    app: string,
    appDir: string,
    config: Record<string, unknown>,
    appId?: number | null,
  ): WorkerState {
    if (!meta.needsWorker || !meta.worker) {
      throw new Error(`plugin '${meta.id}' has no worker`);
    }
    const key = this.key(app, meta.id);
    const existing = this.workers.get(key);
    if (existing && this.isRunning(app, meta.id)) return existing.state;

    const ctx: PluginWorkerContext = {
      app,
      config,
      appDir,
      dataDir: this.config.dataDir,
      livekitUrl: this.config.livekitUrl,
    };
    const spec = meta.worker.spawn(ctx);

    const entry: WorkerEntry = existing ?? {
      state: { app, pluginId: meta.id, status: 'stopped' },
      logs: [],
    };
    entry.state = {
      app,
      pluginId: meta.id,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };
    entry.errorNotified = false;
    // Fresh ingest token per start — the live-data channel (POST :id/live)
    // only accepts pushes carrying the CURRENT running worker's token.
    entry.ingestToken = randomUUID();
    this.workers.set(key, entry);

    // Framework-provided env every worker gets (before spec.env so a plugin
    // can still override deliberately): who it is + where/how to push live
    // overlay data back into the core. The core binds localhost, and workers
    // are spawned on the same host, so 127.0.0.1 is always reachable.
    const frameworkEnv: Record<string, string> = {
      STREAMHUB_APP: app,
      STREAMHUB_PLUGIN_ID: meta.id,
      STREAMHUB_INGEST_URL: `http://127.0.0.1:${this.config.port}/api/v1/apps/${encodeURIComponent(
        app,
      )}/plugins/${encodeURIComponent(meta.id)}/live`,
      STREAMHUB_INGEST_TOKEN: entry.ingestToken,
    };

    try {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd ?? appDir,
        env: { ...process.env, ...frameworkEnv, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      entry.state.pid = child.pid;
      entry.state.status = 'running';

      child.stdout?.on('data', (b: Buffer) =>
        this.append(entry, meta.id, app, appId, 'stdout', b),
      );
      child.stderr?.on('data', (b: Buffer) =>
        this.append(entry, meta.id, app, appId, 'stderr', b),
      );
      child.on('error', (err: Error) => {
        entry.state.status = 'crashed';
        entry.state.error = err.message;
        entry.state.stoppedAt = new Date().toISOString();
        this.system(entry, meta.id, app, appId, `worker error: ${err.message}`);
        if (!entry.errorNotified) {
          entry.errorNotified = true;
          this.notify(app, 'plugin_worker_error', {
            plugin: meta.id,
            error: err.message,
          });
        }
      });
      child.on('exit', (code, signal) => {
        entry.child = undefined;
        entry.state.exitCode = code;
        entry.state.stoppedAt = new Date().toISOString();
        // A non-zero, non-signalled exit that we did not request = crash.
        const crashed = !!code && code !== 0 && !signal;
        entry.state.status = crashed ? 'crashed' : 'stopped';
        this.system(
          entry,
          meta.id,
          app,
          appId,
          `worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
        );
        if (crashed && !entry.errorNotified) {
          entry.errorNotified = true;
          this.notify(app, 'plugin_worker_error', {
            plugin: meta.id,
            exitCode: code,
            signal: signal ?? null,
          });
        } else if (!crashed) {
          this.notify(app, 'plugin_worker_stopped', {
            plugin: meta.id,
            exitCode: code ?? null,
            signal: signal ?? null,
          });
        }
      });

      this.system(
        entry,
        meta.id,
        app,
        appId,
        `worker started: ${spec.command} ${(spec.args ?? []).join(' ')} (pid ${child.pid})`,
      );
      this.notify(app, 'plugin_worker_started', {
        plugin: meta.id,
        pid: child.pid ?? null,
      });
    } catch (err) {
      entry.state.status = 'crashed';
      entry.state.error = (err as Error).message;
      entry.state.stoppedAt = new Date().toISOString();
      this.system(
        entry,
        meta.id,
        app,
        appId,
        `spawn failed: ${(err as Error).message}`,
      );
      if (!entry.errorNotified) {
        entry.errorNotified = true;
        this.notify(app, 'plugin_worker_error', {
          plugin: meta.id,
          error: (err as Error).message,
        });
      }
    }
    return entry.state;
  }

  /** Stop a running worker (SIGTERM). No-op if not running. */
  stop(app: string, pluginId: string): WorkerState {
    const entry = this.workers.get(this.key(app, pluginId));
    if (!entry) return { app, pluginId, status: 'stopped' };
    if (entry.child) {
      entry.child.kill('SIGTERM');
      entry.state.status = 'stopped';
      entry.state.stoppedAt = new Date().toISOString();
    }
    return entry.state;
  }

  // ---------------------------------------------------------------------------

  private append(
    entry: WorkerEntry,
    pluginId: string,
    app: string,
    appId: number | null | undefined,
    stream: 'stdout' | 'stderr',
    buf: Buffer,
  ): void {
    const text = buf.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      this.push(entry, { ts: new Date().toISOString(), stream, line });
      this.logsSvc.write(
        stream === 'stderr' ? 'warn' : 'info',
        `plugin:${pluginId}`,
        line,
        { app, stream },
        appId ?? null,
      );
    }
  }

  private system(
    entry: WorkerEntry,
    pluginId: string,
    app: string,
    appId: number | null | undefined,
    line: string,
  ): void {
    this.push(entry, { ts: new Date().toISOString(), stream: 'system', line });
    this.logsSvc.write(
      'info',
      `plugin:${pluginId}`,
      line,
      { app, stream: 'system' },
      appId ?? null,
    );
  }

  private push(entry: WorkerEntry, line: WorkerLogLine): void {
    entry.logs.push(line);
    if (entry.logs.length > MAX_LOG_LINES) {
      entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
    }
  }
}
