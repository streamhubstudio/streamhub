/**
 * Plugin/marketplace orchestration (module `plugins`).
 *
 * Ties together: the code CATALOG (PluginRegistryService, auto-discovered), the
 * per-app INSTALL state (AppPluginsRepository → app.db), config validation
 * (plugin-config.util) and the WORKER hook (PluginWorkerManager). Controllers
 * call only this service.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  APPS_SERVICE,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  LogEntry,
} from '../../shared/contracts';
import { AppPluginsRepository } from './app-plugins.repository';
import {
  PluginConfigError,
  defaultConfig,
  redactSecrets,
  sanitizePublicConfig,
  validateConfig,
} from './plugin-config.util';
import {
  PluginConfigField,
  PluginManifest,
  PluginMeta,
  PluginUiSlot,
} from './plugin.contract';
import { PluginRegistryService } from './plugin-registry.service';
import {
  LiveDataView,
  PluginLiveDataService,
} from './plugin-livedata.service';
import {
  PluginWorkerManager,
  WorkerLogLine,
  WorkerState,
} from './plugin-worker.manager';

/** Marketplace entry: catalog manifest + this app's install state. */
export interface PluginView {
  manifest: PluginManifest;
  installed: boolean;
  enabled: boolean;
  /** Effective config (defaults + overrides), secrets redacted. */
  config: Record<string, unknown>;
  installedAt: string | null;
  updatedAt: string | null;
  /** Present only for needsWorker plugins that have been installed. */
  worker?: WorkerState;
}

/**
 * PUBLIC (no-auth) view of one enabled player-overlay plugin. Carries ONLY what
 * an anonymous player needs to render the overlay client-side: the id, a trimmed
 * manifest and the sanitized (secret-free) config. Deliberately NOT a PluginView
 * (no install/worker/redacted-secret fields — nothing sensitive leaves the box).
 */
export interface PublicOverlayView {
  id: string;
  manifest: {
    name: string;
    ui: PluginUiSlot;
    configSchema: PluginConfigField[];
    icon?: string;
  };
  /** Sanitized config: secrets + callback/webhook URLs stripped. */
  config: Record<string, unknown>;
}

export interface PluginLogs {
  pluginId: string;
  worker?: WorkerState;
  /** In-memory worker stdout/stderr ring buffer (newest last). */
  workerLogs: WorkerLogLine[];
  /** Persisted server_logs rows for source `plugin:<id>`. */
  persisted: LogEntry[];
}

@Injectable()
export class PluginsService {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly repo: AppPluginsRepository,
    private readonly workers: PluginWorkerManager,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    // Defaulted so existing manual constructions (unit specs) keep compiling;
    // under Nest DI the module-registered singleton is injected.
    private readonly livedata: PluginLiveDataService = new PluginLiveDataService(),
  ) {}

  /** Resolve the app or 404. Returns the record (with id). */
  private async requireApp(app: string): Promise<{ id: number }> {
    const rec = await this.apps.get(app);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
    return rec;
  }

  private requireMeta(id: string): PluginMeta {
    const meta = this.registry.getMeta(id);
    if (!meta) throw new NotFoundException(`plugin '${id}' not found`);
    return meta;
  }

  /** Marketplace: every catalog plugin merged with this app's install state. */
  async list(app: string): Promise<PluginView[]> {
    await this.requireApp(app);
    const installed = new Map(
      this.repo.list(app).map((r) => [r.pluginId, r]),
    );
    return this.registry.listManifests().map((manifest) => {
      const meta = this.registry.getMeta(manifest.id) as PluginMeta;
      const row = installed.get(manifest.id);
      const config = row
        ? validateConfig(meta, row.config, false)
        : defaultConfig(meta);
      return {
        manifest,
        installed: !!row,
        enabled: row?.enabled ?? false,
        config: redactSecrets(meta, config),
        installedAt: row?.installedAt ?? null,
        updatedAt: row?.updatedAt ?? null,
        worker:
          manifest.needsWorker && row
            ? this.workers.status(app, manifest.id)
            : undefined,
      };
    });
  }

  /**
   * PUBLIC overlays for an app (no auth). Returns ONLY the plugins that are
   * installed + ENABLED and whose ui is `player-overlay`, with a trimmed manifest
   * and a SANITIZED config (secrets + callback/webhook URLs stripped). This is
   * what the anonymous /play and /embed players consume so overlays (e.g. the
   * Timestamp CCTV stamp) render without a login. It reuses the SAME registry +
   * per-app install state as `list()`; it just filters + sanitizes hard, and
   * never surfaces app-tab/panel plugins, disabled installs or the full catalog.
   */
  async publicOverlays(app: string): Promise<PublicOverlayView[]> {
    await this.requireApp(app);
    const out: PublicOverlayView[] = [];
    for (const row of this.repo.list(app)) {
      if (!row.enabled) continue;
      const meta = this.registry.getMeta(row.pluginId);
      if (!meta || meta.ui !== 'player-overlay') continue;
      const config = validateConfig(meta, row.config, false);
      out.push({
        id: meta.id,
        manifest: {
          name: meta.name,
          ui: meta.ui,
          configSchema: meta.configSchema,
          icon: meta.icon,
        },
        config: sanitizePublicConfig(meta, config),
      });
    }
    return out;
  }

  /** Single marketplace entry. */
  async get(app: string, id: string): Promise<PluginView> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    const row = this.repo.get(app, id);
    const config = row
      ? validateConfig(meta, row.config, false)
      : defaultConfig(meta);
    return {
      manifest: this.registry.getManifest(id) as PluginManifest,
      installed: !!row,
      enabled: row?.enabled ?? false,
      config: redactSecrets(meta, config),
      installedAt: row?.installedAt ?? null,
      updatedAt: row?.updatedAt ?? null,
      worker:
        meta.needsWorker && row ? this.workers.status(app, id) : undefined,
    };
  }

  /**
   * Install a plugin into an app (idempotent). Installs DISABLED with default
   * config — the marketplace UX is install → configure → enable, and enabling
   * is where required-field validation kicks in (so a plugin with required
   * config is never left "enabled but invalid").
   */
  async install(app: string, id: string): Promise<PluginView> {
    const appRec = await this.requireApp(app);
    const meta = this.requireMeta(id);
    const existing = this.repo.get(app, id);
    if (!existing) {
      this.repo.install(app, id, defaultConfig(meta), false);
      this.logs.write(
        'info',
        `plugin:${id}`,
        `installed into app '${app}'`,
        { app },
        appRec.id,
      );
      await this.reconcileWorker(app, id);
    }
    return this.get(app, id);
  }

  /** Patch enabled and/or config; validates config against the schema. */
  async patch(
    app: string,
    id: string,
    patch: { enabled?: boolean; config?: Record<string, unknown> },
  ): Promise<PluginView> {
    const appRec = await this.requireApp(app);
    const meta = this.requireMeta(id);
    const row = this.repo.get(app, id);
    if (!row) {
      throw new BadRequestException(
        `plugin '${id}' is not installed in app '${app}'`,
      );
    }

    const willEnable = patch.enabled ?? row.enabled;
    let nextConfig: Record<string, unknown> | undefined;
    if (patch.config !== undefined) {
      try {
        // Merge over the stored config so a partial patch keeps other fields.
        const merged = { ...row.config, ...patch.config };
        nextConfig = validateConfig(meta, merged, willEnable);
      } catch (e) {
        if (e instanceof PluginConfigError) {
          throw new BadRequestException(e.message);
        }
        throw e;
      }
    } else if (patch.enabled === true) {
      // Enabling without a config change: still ensure required fields are set.
      try {
        validateConfig(meta, row.config, true);
      } catch (e) {
        if (e instanceof PluginConfigError) {
          throw new BadRequestException(e.message);
        }
        throw e;
      }
    }

    this.repo.update(app, id, {
      enabled: patch.enabled,
      config: nextConfig,
    });
    this.logs.write(
      'info',
      `plugin:${id}`,
      `updated in app '${app}' (${JSON.stringify({
        enabled: patch.enabled,
        configChanged: nextConfig !== undefined,
      })})`,
      { app },
      appRec.id,
    );
    await this.reconcileWorker(app, id);
    return this.get(app, id);
  }

  /** Uninstall: stop any worker, drop the row + live data. Idempotent. */
  async remove(app: string, id: string): Promise<void> {
    const appRec = await this.requireApp(app);
    this.requireMeta(id);
    this.workers.stop(app, id);
    this.livedata.clear(app, id);
    this.repo.remove(app, id);
    this.logs.write(
      'info',
      `plugin:${id}`,
      `uninstalled from app '${app}'`,
      { app },
      appRec.id,
    );
  }

  /**
   * Explicitly (re)start a needsWorker plugin's worker via the worker-hook,
   * independent of the enable/disable flow. The plugin must be installed,
   * enabled and have valid required config — otherwise this 400s rather than
   * spawning a worker that would crash-loop. Idempotent: an already-running
   * worker is returned as-is by the manager.
   */
  async startWorker(app: string, id: string): Promise<WorkerState> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    if (!meta.needsWorker || !meta.worker) {
      throw new BadRequestException(`plugin '${id}' has no worker`);
    }
    const row = this.repo.get(app, id);
    if (!row) {
      throw new BadRequestException(
        `plugin '${id}' is not installed in app '${app}'`,
      );
    }
    if (!row.enabled) {
      throw new BadRequestException(
        `plugin '${id}' must be enabled before starting its worker`,
      );
    }
    let config: Record<string, unknown>;
    try {
      config = validateConfig(meta, row.config, true);
    } catch (e) {
      if (e instanceof PluginConfigError) {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
    const appDir = this.apps.appDir(app);
    const appRec = await this.apps.get(app);
    return this.workers.start(meta, app, appDir, config, appRec?.id ?? null);
  }

  /** Explicitly stop a plugin's worker (no-op if not running). */
  async stopWorker(app: string, id: string): Promise<WorkerState> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    if (!meta.needsWorker) {
      throw new BadRequestException(`plugin '${id}' has no worker`);
    }
    return this.workers.stop(app, id);
  }

  /** Current worker state for a needsWorker plugin. */
  async workerStatus(app: string, id: string): Promise<WorkerState> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    if (!meta.needsWorker) {
      throw new BadRequestException(`plugin '${id}' has no worker`);
    }
    return this.workers.status(app, id);
  }

  /**
   * LIVE-DATA INGEST (worker → core). Accepts one JSON payload from the
   * plugin's RUNNING worker and stores it as the latest live data for
   * (app, plugin, room). AuthN: the `token` must equal the per-start ingest
   * token the worker-hook injected into the worker env (STREAMHUB_INGEST_TOKEN)
   * — so only the process the core itself spawned can push, and a stopped
   * worker's token is dead immediately.
   */
  async ingestLive(
    app: string,
    id: string,
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true }> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    if (!meta.needsWorker) {
      throw new BadRequestException(
        `plugin '${id}' has no worker — live ingest is worker-only`,
      );
    }
    const expected = this.workers.ingestToken(app, id);
    if (!expected || !token || token !== expected) {
      throw new UnauthorizedException('invalid or missing ingest token');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('live payload must be a JSON object');
    }
    const room = typeof payload.room === 'string' ? payload.room.trim() : '';
    if (!room) {
      throw new BadRequestException("live payload must carry a 'room'");
    }
    if (!this.livedata.push(app, id, room, payload)) {
      throw new BadRequestException('live payload too large');
    }
    return { ok: true };
  }

  /**
   * LIVE-DATA READ (player → core, PUBLIC). Latest worker payload for an
   * ENABLED player-overlay plugin. Serves the anonymous /play and /embed
   * players (same trust level as GET /plugins/public), so it is gated hard:
   * only installed + enabled `player-overlay` plugins ever answer — everything
   * else 404s. Freshness (`ts`/`ageMs`) lets the overlay drop stale boxes.
   */
  async liveOverlayData(
    app: string,
    id: string,
    room: string,
  ): Promise<LiveDataView | { ts: null; ageMs: null; payload: null }> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    const row = this.repo.get(app, id);
    if (meta.ui !== 'player-overlay' || !row || !row.enabled) {
      throw new NotFoundException(
        `plugin '${id}' has no public live data for app '${app}'`,
      );
    }
    return (
      this.livedata.latest(app, id, room.trim()) ?? {
        ts: null,
        ageMs: null,
        payload: null,
      }
    );
  }

  /** Per-plugin logs: worker ring buffer + persisted rows. */
  async getLogs(app: string, id: string, limit = 200): Promise<PluginLogs> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    const all = await this.logs.query({ app, limit: 500 });
    const persisted = all
      .filter((e) => e.source === `plugin:${id}`)
      .slice(0, limit);
    return {
      pluginId: id,
      worker: meta.needsWorker ? this.workers.status(app, id) : undefined,
      workerLogs: meta.needsWorker ? this.workers.logs(app, id, limit) : [],
      persisted,
    };
  }

  /**
   * Reconcile the worker process with the install state:
   *   - plugin without a worker → nothing to do.
   *   - installed + enabled + required-config OK → (re)start with fresh config.
   *   - otherwise → stop.
   * Restart-on-config-change is achieved by stop()+start() (start reads config).
   */
  private async reconcileWorker(app: string, id: string): Promise<void> {
    const meta = this.registry.getMeta(id);
    if (!meta?.needsWorker || !meta.worker) return;
    const row = this.repo.get(app, id);

    if (!row || !row.enabled) {
      this.workers.stop(app, id);
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = validateConfig(meta, row.config, true);
    } catch {
      // Missing required config: keep it stopped rather than crash-looping.
      this.workers.stop(app, id);
      return;
    }
    const appDir = this.apps.appDir(app);
    const appRec = await this.apps.get(app);
    // Restart to pick up the latest config.
    this.workers.stop(app, id);
    this.workers.start(meta, app, appDir, config, appRec?.id ?? null);
  }
}
