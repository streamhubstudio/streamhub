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
import { GridSpawnRequest, PluginGridService } from './plugin-grid.service';
import {
  PluginMeta,
  PluginNodeInfo,
  PluginWorkerContext,
  PluginWorkerPlacement,
  PluginWorkerSpec,
} from './plugin.contract';
import { AppPluginsRepository } from './app-plugins.repository';
import { AppstoreService } from './appstore/appstore.service';
import { redirectWorkerDir } from './appstore/spawn-redirect.util';
import { resolveWorkerDir } from './plugin-export.service';

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
  /**
   * EFFECTIVE placement of this run: `'grid'` once a worker is DISPATCHED to a
   * remote node (GRID-1), else `'local'` — a 'grid'-requested worker that found
   * no eligible node, or whose dispatch failed, falls back to a local spawn and
   * reports `'local'`. The REQUESTED placement lives on the manifest
   * (workerPlacement).
   */
  placement?: PluginWorkerPlacement;
  /** Grid lease — the remote node this worker runs on (placement 'grid'). */
  node?: PluginNodeInfo;
  /** Remote worker id on that node's grid agent (placement 'grid'). */
  remoteId?: string;
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
  /** Remote GRID lease when this run was dispatched to another node (GRID-2). */
  lease?: { node: PluginNodeInfo; remoteId: string };
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
    // GRID seam (NEXTGEN-ADDONS): optional so existing manual constructions
    // (unit specs) keep compiling; under Nest DI the module singleton is
    // injected. Only consulted for `worker.placement: 'grid'` plugins.
    @Optional()
    private readonly grid?: PluginGridService,
    // APPSTORE seam (app versioning): optional so existing manual constructions
    // (unit specs) keep compiling. When both are present a LOCAL spawn resolves
    // an install's pinned worker version to the extracted bundle dir instead of
    // the shipped source; absent → today's built-in-only behaviour.
    @Optional()
    private readonly appstore?: AppstoreService,
    @Optional()
    private readonly appPlugins?: AppPluginsRepository,
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
      if (entry.lease && this.grid) {
        const { node, remoteId } = entry.lease;
        void this.grid.stopRemote(node, remoteId).catch(() => undefined);
      }
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
   *
   * `appTimezone` (owner item 11) is the app's configured IANA timezone —
   * threaded through to `PluginWorkerContext.appTimezone` so a worker's own
   * timezone-flavoured config (e.g. an arm/disarm schedule) can default to it
   * when its own field is empty. Optional/undefined for callers that don't
   * resolve it (existing call sites keep compiling unchanged).
   */
  start(
    meta: PluginMeta,
    app: string,
    appDir: string,
    config: Record<string, unknown>,
    appId?: number | null,
    appTimezone?: string,
  ): WorkerState {
    if (!meta.needsWorker || !meta.worker) {
      throw new Error(`plugin '${meta.id}' has no worker`);
    }
    const key = this.key(app, meta.id);
    const existing = this.workers.get(key);
    if (existing && this.isRunning(app, meta.id)) return existing.state;

    const entry: WorkerEntry = existing ?? {
      state: { app, pluginId: meta.id, status: 'stopped' },
      logs: [],
    };
    entry.errorNotified = false;
    entry.lease = undefined;
    // Fresh ingest token per start — the live-data channel (POST :id/live)
    // only accepts pushes carrying the CURRENT running worker's token.
    entry.ingestToken = randomUUID();
    entry.state = {
      app,
      pluginId: meta.id,
      status: 'starting',
      startedAt: new Date().toISOString(),
      placement: 'local',
    };
    this.workers.set(key, entry);

    // GRID placement (NEXTGEN-ADDONS): a 'grid' worker WANTS a remote BYO-GPU
    // node from the cluster registry. If one is eligible we resolve the spec
    // against the REMOTE ctx and dispatch it to that node's grid agent
    // (asynchronously); on success we do NOT spawn locally. Any miss (no node,
    // dispatch failure/timeout) falls back to a local spawn, so a 'grid'
    // worker keeps working on single-node installs exactly like 'local'.
    if ((meta.worker.placement ?? 'local') === 'grid') {
      const pick = this.grid?.selectNode(meta.worker.grid) ?? null;
      if (pick && this.grid) {
        this.dispatchRemote(
          entry,
          meta,
          app,
          appDir,
          config,
          appId,
          pick,
          appTimezone,
        );
        return entry.state;
      }
      this.system(
        entry,
        meta.id,
        app,
        appId,
        'grid placement requested but no eligible grid node registered — ' +
          'falling back to local spawn',
      );
    }

    this.spawnLocal(entry, meta, app, appDir, config, appId, appTimezone);
    return entry.state;
  }

  /**
   * Resolve + spawn the worker LOCALLY on the origin (the default path, and the
   * fall-back for a 'grid' worker that couldn't be dispatched). The loopback
   * ingest URL is reachable because core binds localhost and the worker runs on
   * the same host.
   */
  private spawnLocal(
    entry: WorkerEntry,
    meta: PluginMeta,
    app: string,
    appDir: string,
    config: Record<string, unknown>,
    appId: number | null | undefined,
    appTimezone?: string,
  ): void {
    const ctx: PluginWorkerContext = {
      app,
      config,
      appDir,
      dataDir: this.config.dataDir,
      livekitUrl: this.config.livekitUrl,
      appTimezone: appTimezone || undefined,
    };
    const spec = this.applyPin(meta.worker!.spawn(ctx), meta, app, entry, appId);
    entry.state.placement = 'local';
    entry.state.node = undefined;
    entry.state.remoteId = undefined;

    // Framework-provided env every worker gets (before spec.env so a plugin
    // can still override deliberately): who it is + where/how to push live
    // overlay data (and declared domain events) back into the core over the
    // loopback. Both channels authenticate with the SAME per-start token.
    const base = `http://127.0.0.1:${this.config.port}/api/v1/apps/${encodeURIComponent(
      app,
    )}/plugins/${encodeURIComponent(meta.id)}`;
    const frameworkEnv: Record<string, string> = {
      STREAMHUB_APP: app,
      STREAMHUB_PLUGIN_ID: meta.id,
      STREAMHUB_INGEST_URL: `${base}/live`,
      STREAMHUB_EVENTS_URL: `${base}/events`,
      STREAMHUB_INGEST_TOKEN: entry.ingestToken ?? '',
    };
    this.launch(
      entry,
      app,
      meta.id,
      appId,
      spec,
      { ...process.env, ...frameworkEnv, ...(spec.env ?? {}) },
      spec.cwd ?? appDir,
    );
  }

  /**
   * APP VERSIONING — if this install pins a worker version, rewrite the LOCAL
   * spawn spec to run from the pinned bundle's extracted dir instead of the
   * shipped source. No pin (or the appstore seam absent) → the spec is returned
   * unchanged (today's built-in behaviour). A missing/tampered bundle (sha256
   * mismatch on extract) is logged loudly and falls back to the built-in rather
   * than crash-looping the worker.
   */
  private applyPin(
    spec: PluginWorkerSpec,
    meta: PluginMeta,
    app: string,
    entry: WorkerEntry,
    appId: number | null | undefined,
  ): PluginWorkerSpec {
    if (!this.appstore || !this.appPlugins || !meta.export?.workerDir) {
      return spec;
    }
    let version: string | null = null;
    try {
      version = this.appPlugins.get(app, meta.id)?.workerVersion ?? null;
    } catch {
      return spec;
    }
    if (!version) return spec;
    try {
      const toDir = this.appstore.resolveExtractedWorkerDir(meta.id, version);
      const fromDir =
        spec.cwd ?? resolveWorkerDir(meta.export.workerDir) ?? '';
      const pinned = fromDir
        ? redirectWorkerDir(spec, fromDir, toDir)
        : { ...spec, cwd: toDir };
      this.system(
        entry,
        meta.id,
        app,
        appId,
        `running pinned version '${version}' (${toDir})`,
      );
      return pinned;
    } catch (err) {
      this.system(
        entry,
        meta.id,
        app,
        appId,
        `pinned version '${version}' unusable (${(err as Error).message}) — ` +
          'falling back to the built-in',
      );
      return spec;
    }
  }

  /**
   * GRID-1/2/3 — resolve the spec against the REMOTE ctx (node identity + the
   * origin public base for result feed-back) and dispatch it to the node's
   * grid agent. Runs off the start() hot path: the state is 'starting' until
   * the agent answers, then flips to 'running'+'grid' (lease recorded), or
   * falls back to a local spawn on any failure/timeout.
   */
  private dispatchRemote(
    entry: WorkerEntry,
    meta: PluginMeta,
    app: string,
    appDir: string,
    config: Record<string, unknown>,
    appId: number | null | undefined,
    pick: PluginNodeInfo,
    appTimezone?: string,
  ): void {
    const node: PluginNodeInfo = {
      id: pick.id,
      name: pick.name,
      url: pick.url,
      region: pick.region,
    };
    // GRID-3: a remote worker cannot reach the loopback ingest URL — hand it
    // the ORIGIN public base so deface/transcription can POST results back.
    const originUrl = this.config.publicBaseUrl;
    const ctx: PluginWorkerContext = {
      app,
      config,
      appDir,
      dataDir: this.config.dataDir,
      livekitUrl: this.config.livekitUrl,
      node,
      originUrl: originUrl || undefined,
      appTimezone: appTimezone || undefined,
    };
    const spec = meta.worker!.spawn(ctx);

    const frameworkEnv: Record<string, string> = {
      STREAMHUB_APP: app,
      STREAMHUB_PLUGIN_ID: meta.id,
    };
    if (originUrl) {
      const base = `${originUrl.replace(
        /\/+$/,
        '',
      )}/api/v1/apps/${encodeURIComponent(app)}/plugins/${encodeURIComponent(
        meta.id,
      )}`;
      frameworkEnv.STREAMHUB_INGEST_URL = `${base}/live`;
      frameworkEnv.STREAMHUB_EVENTS_URL = `${base}/events`;
      frameworkEnv.STREAMHUB_INGEST_TOKEN = entry.ingestToken ?? '';
    } else {
      this.system(
        entry,
        meta.id,
        app,
        appId,
        'grid placement: PUBLIC_BASE_URL is unset — a remote worker cannot ' +
          'reach the origin ingest channel (live result feed-back disabled)',
      );
    }

    const req: GridSpawnRequest = {
      pluginId: meta.id,
      appName: app,
      command: spec.command,
      args: spec.args ?? [],
      env: { ...frameworkEnv, ...(spec.env ?? {}) },
      ingestToken: entry.ingestToken,
    };
    this.system(
      entry,
      meta.id,
      app,
      appId,
      `grid placement: dispatching worker to node '${pick.name}'…`,
    );

    const key = this.key(app, meta.id);
    void this.grid!.dispatch(node, req)
      .then((res) => {
        // Guard: the worker may have been stopped/restarted while we awaited.
        if (this.workers.get(key) !== entry) return;
        if (res.dispatched && res.remoteId) {
          entry.lease = { node, remoteId: res.remoteId };
          entry.state.status = 'running';
          entry.state.placement = 'grid';
          entry.state.node = node;
          entry.state.remoteId = res.remoteId;
          this.system(
            entry,
            meta.id,
            app,
            appId,
            `grid dispatch OK → node '${pick.name}' worker '${res.remoteId}'`,
          );
          this.notify(app, 'plugin_worker_started', {
            plugin: meta.id,
            node: node.id,
            remoteId: res.remoteId,
          });
        } else {
          this.system(
            entry,
            meta.id,
            app,
            appId,
            `grid dispatch to '${pick.name}' failed (${res.reason ?? 'unknown'}) — ` +
              'falling back to local spawn',
          );
          this.spawnLocal(entry, meta, app, appDir, config, appId, appTimezone);
        }
      })
      .catch((err: unknown) => {
        if (this.workers.get(key) !== entry) return;
        this.system(
          entry,
          meta.id,
          app,
          appId,
          `grid dispatch error (${(err as Error).message}) — falling back to local spawn`,
        );
        this.spawnLocal(entry, meta, app, appDir, config, appId, appTimezone);
      });
  }

  /**
   * GRID-AGENT entrypoint — spawn + supervise a RESOLVED spec directly (no
   * meta, no framework-env injection: the origin already baked the ingest env
   * into spec.env). Keyed by an opaque id the caller owns; `app`/`pluginId`
   * are advisory labels for logs/status. Uses the SAME child machinery as the
   * local path (`launch`). Idempotent while running.
   */
  startSpec(
    key: string,
    app: string,
    pluginId: string,
    spec: PluginWorkerSpec,
  ): WorkerState {
    const existing = this.workers.get(key);
    if (
      existing &&
      (existing.state.status === 'running' ||
        existing.state.status === 'starting')
    ) {
      return existing.state;
    }
    const entry: WorkerEntry = existing ?? {
      state: { app, pluginId, status: 'stopped' },
      logs: [],
    };
    entry.errorNotified = false;
    entry.state = {
      app,
      pluginId,
      status: 'starting',
      startedAt: new Date().toISOString(),
      placement: 'grid',
    };
    this.workers.set(key, entry);
    this.launch(
      entry,
      app,
      pluginId,
      null,
      spec,
      { ...process.env, ...(spec.env ?? {}) },
      spec.cwd,
    );
    return entry.state;
  }

  /** Worker state by opaque key (grid-agent surface). Undefined if unknown. */
  statusByKey(key: string): WorkerState | undefined {
    return this.workers.get(key)?.state;
  }

  /** Stop a worker by opaque key (grid-agent surface). No-op if unknown/idle. */
  stopByKey(key: string): WorkerState {
    const entry = this.workers.get(key);
    if (!entry) return { app: '', pluginId: '', status: 'stopped' };
    if (entry.child) {
      entry.child.kill('SIGTERM');
      entry.state.status = 'stopped';
      entry.state.stoppedAt = new Date().toISOString();
    }
    return entry.state;
  }

  /** Recent buffered log lines by opaque key (grid-agent surface). */
  logsByKey(key: string, limit = 200): WorkerLogLine[] {
    const entry = this.workers.get(key);
    if (!entry) return [];
    return entry.logs.slice(-Math.max(1, limit));
  }

  /**
   * The raw child_process supervise loop — shared by the local path
   * (`spawnLocal`), the grid fall-back and the grid agent (`startSpec`). The
   * caller supplies the FINAL env + cwd; this only spawns, wires stdout/stderr
   * to the ring buffer + LogsService, and tracks the exit/crash lifecycle.
   */
  private launch(
    entry: WorkerEntry,
    app: string,
    pluginId: string,
    appId: number | null | undefined,
    spec: PluginWorkerSpec,
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ): void {
    try {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      entry.state.pid = child.pid;
      entry.state.status = 'running';

      child.stdout?.on('data', (b: Buffer) =>
        this.append(entry, pluginId, app, appId, 'stdout', b),
      );
      child.stderr?.on('data', (b: Buffer) =>
        this.append(entry, pluginId, app, appId, 'stderr', b),
      );
      child.on('error', (err: Error) => {
        entry.state.status = 'crashed';
        entry.state.error = err.message;
        entry.state.stoppedAt = new Date().toISOString();
        this.system(entry, pluginId, app, appId, `worker error: ${err.message}`);
        if (!entry.errorNotified) {
          entry.errorNotified = true;
          this.notify(app, 'plugin_worker_error', {
            plugin: pluginId,
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
          pluginId,
          app,
          appId,
          `worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
        );
        if (crashed && !entry.errorNotified) {
          entry.errorNotified = true;
          this.notify(app, 'plugin_worker_error', {
            plugin: pluginId,
            exitCode: code,
            signal: signal ?? null,
          });
        } else if (!crashed) {
          this.notify(app, 'plugin_worker_stopped', {
            plugin: pluginId,
            exitCode: code ?? null,
            signal: signal ?? null,
          });
        }
      });

      this.system(
        entry,
        pluginId,
        app,
        appId,
        `worker started: ${spec.command} ${(spec.args ?? []).join(' ')} (pid ${child.pid})`,
      );
      this.notify(app, 'plugin_worker_started', {
        plugin: pluginId,
        pid: child.pid ?? null,
      });
    } catch (err) {
      entry.state.status = 'crashed';
      entry.state.error = (err as Error).message;
      entry.state.stoppedAt = new Date().toISOString();
      this.system(
        entry,
        pluginId,
        app,
        appId,
        `spawn failed: ${(err as Error).message}`,
      );
      if (!entry.errorNotified) {
        entry.errorNotified = true;
        this.notify(app, 'plugin_worker_error', {
          plugin: pluginId,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Stop a running worker (SIGTERM). No-op if not running. A REMOTE (grid)
   * worker is proxied: the origin asks the owning node's agent to stop it
   * (best-effort) and clears the lease.
   */
  stop(app: string, pluginId: string): WorkerState {
    const entry = this.workers.get(this.key(app, pluginId));
    if (!entry) return { app, pluginId, status: 'stopped' };
    if (entry.lease && this.grid) {
      const { node, remoteId } = entry.lease;
      void this.grid.stopRemote(node, remoteId).catch(() => undefined);
      entry.lease = undefined;
      entry.state.status = 'stopped';
      entry.state.stoppedAt = new Date().toISOString();
      return entry.state;
    }
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
