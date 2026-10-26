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
  OnApplicationBootstrap,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
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
import {
  StreamPluginOverridesService,
  StreamScope,
} from '../streams/stream-plugins.service';
import {
  VISION_EVENT_SINK,
  VisionEventSink,
} from '../vision-apps/vision-sink.contract';
import { isVisionEvent } from '../vision-apps/vision.types';

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
  /**
   * Pinned appstore version (`worker_version`), or null = built-in/latest. Lets
   * the marketplace badge which version an install runs.
   */
  workerVersion?: string | null;
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
export class PluginsService implements OnApplicationBootstrap {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly repo: AppPluginsRepository,
    private readonly workers: PluginWorkerManager,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    // Defaulted so existing manual constructions (unit specs) keep compiling;
    // under Nest DI the module-registered singleton is injected.
    private readonly livedata: PluginLiveDataService = new PluginLiveDataService(),
    // Per-stream plugin opt-out resolver (module `streams`). @Optional so unit
    // specs can construct PluginsService without it (→ no stream-scoped
    // filtering, i.e. plain app-level behaviour); injected under Nest DI.
    @Optional()
    private readonly streamPlugins?: StreamPluginOverridesService,
    // Outbound signed-webhook funnel for the plugin EVENT channel. @Optional
    // (CallbacksModule is @Global under Nest DI) so existing manual
    // constructions in unit specs keep compiling; without it ingestEvent
    // accepts + logs but has nowhere to dispatch.
    @Optional()
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks?: CallbacksServiceContract,
    // OPTIONAL vision detection sink (@Global VisionAppsModule binds it). When
    // present, vision-family events are ALSO tapped into the model's per-app db +
    // the rotated app log after they dispatch; absent (module not loaded / unit
    // specs) → undefined, and ingest behaves exactly as before.
    @Optional()
    @Inject(VISION_EVENT_SINK)
    private readonly visionSink?: VisionEventSink,
  ) {}

  /**
   * The set of plugin ids a scope (a single stream, or a room's active
   * streams) has opted OUT of. Empty when no scope is given or the resolver is
   * absent — the caller then serves the unmodified app-level list.
   */
  private disabledForScope(app: string, scope?: StreamScope): Set<string> {
    if (!scope || (!scope.stream && !scope.room) || !this.streamPlugins) {
      return new Set();
    }
    return new Set(this.streamPlugins.resolveDisabled(app, scope));
  }

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

  /**
   * The app's configured IANA timezone (owner item 11), handed to a worker as
   * `PluginWorkerContext.appTimezone` — the DEFAULT a worker's own
   * timezone-flavoured config (e.g. an arm/disarm schedule) falls back to when
   * its own field is empty. Best-effort: never throws (a config-read failure
   * just means no default is offered; the worker still starts).
   */
  private async resolveAppTimezone(app: string): Promise<string | undefined> {
    try {
      const cfg = await this.apps.getConfig(app);
      return cfg.timezone || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Marketplace: every catalog plugin merged with this app's install state.
   *
   * With a `scope` (a `?stream=`/`?room=` query from a PLAYER), a plugin the
   * stream/room has opted OUT of is reported with `enabled: false` so the
   * player's overlay host drops it — WITHOUT changing what that plugin is
   * enabled at the APP level. No scope → the app-level list is returned
   * unchanged (the management marketplace).
   */
  async list(app: string, scope?: StreamScope): Promise<PluginView[]> {
    await this.requireApp(app);
    const disabled = this.disabledForScope(app, scope);
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
        enabled: (row?.enabled ?? false) && !disabled.has(manifest.id),
        config: redactSecrets(meta, config),
        installedAt: row?.installedAt ?? null,
        updatedAt: row?.updatedAt ?? null,
        worker:
          manifest.needsWorker && row
            ? this.workers.status(app, manifest.id)
            : undefined,
        workerVersion: row?.workerVersion ?? null,
      };
    });
  }

  /**
   * PUBLIC player plugins for an app (no auth). Returns ONLY the plugins that are
   * installed + ENABLED and whose ui is a PLAYER slot — `player-overlay` (an
   * overlay layered on the player, e.g. the Timestamp CCTV stamp) OR `player`
   * (the swappable media-player provider, e.g. Vidstack) — with a trimmed
   * manifest and a SANITIZED config (secrets + callback/webhook URLs stripped).
   * This is what the anonymous /play and /embed players consume so overlays AND
   * a custom player provider resolve without a login. It reuses the SAME registry
   * + per-app install state as `list()`; it just filters + sanitizes hard, and
   * never surfaces app-tab/panel plugins, disabled installs or the full catalog.
   *
   * A `scope` (a player's `?stream=`/`?room=`) subtracts that stream's (or
   * room's) opted-OUT plugins: an overlay disabled for THIS stream only is
   * omitted here, while every other stream and the app-level list stay intact.
   * No scope → the full app-level overlay set (back-compat).
   */
  async publicOverlays(
    app: string,
    scope?: StreamScope,
  ): Promise<PublicOverlayView[]> {
    await this.requireApp(app);
    const disabled = this.disabledForScope(app, scope);
    const out: PublicOverlayView[] = [];
    for (const row of this.repo.list(app)) {
      if (!row.enabled) continue;
      if (disabled.has(row.pluginId)) continue;
      const meta = this.registry.getMeta(row.pluginId);
      if (!meta || (meta.ui !== 'player-overlay' && meta.ui !== 'player'))
        continue;
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
      workerVersion: row?.workerVersion ?? null,
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
    const appTimezone = await this.resolveAppTimezone(app);
    const state = this.workers.start(
      meta,
      app,
      appDir,
      config,
      appRec?.id ?? null,
      appTimezone,
    );
    // Record the intent so the worker is resumed after a core restart.
    this.repo.setWorkerDesired(app, id, 'running');
    return state;
  }

  /** Explicitly stop a plugin's worker (no-op if not running). */
  async stopWorker(app: string, id: string): Promise<WorkerState> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    if (!meta.needsWorker) {
      throw new BadRequestException(`plugin '${id}' has no worker`);
    }
    const state = this.workers.stop(app, id);
    // Explicit stop = the operator does NOT want it back on the next restart.
    this.repo.setWorkerDesired(app, id, 'stopped');
    return state;
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
   * DOMAIN-EVENT INGEST (worker → core → app SIGNED callbacks). Accepts one
   * event from the plugin's RUNNING worker (same per-start ingest-token auth
   * as ingestLive) and relays it through the callbacks funnel — the app's
   * signed webhook + MQTT tap — under the worker-declared event name.
   *
   * SPOOF GUARD: only names the plugin's manifest DECLARES in `events` are
   * accepted, so a worker can never emit core events (vod_ready, …) nor
   * another plugin's family. Dispatch is fire-and-forget (callbacks are
   * best-effort by contract); the 202-ish `{ok:true}` means "accepted".
   */
  async ingestEvent(
    app: string,
    id: string,
    token: string | undefined,
    body: Record<string, unknown>,
  ): Promise<{ ok: true; event: string }> {
    const appRec = await this.requireApp(app);
    const meta = this.requireMeta(id);
    if (!meta.needsWorker) {
      throw new BadRequestException(
        `plugin '${id}' has no worker — event ingest is worker-only`,
      );
    }
    const expected = this.workers.ingestToken(app, id);
    if (!expected || !token || token !== expected) {
      throw new UnauthorizedException('invalid or missing ingest token');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('event payload must be a JSON object');
    }
    const event = typeof body.event === 'string' ? body.event.trim() : '';
    if (!event) {
      throw new BadRequestException("event payload must carry an 'event' name");
    }
    const declared = meta.events ?? [];
    if (!declared.includes(event)) {
      throw new BadRequestException(
        `plugin '${id}' does not declare event '${event}' in its manifest`,
      );
    }
    const room = typeof body.room === 'string' ? body.room.trim() : '';
    const data =
      body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : {};
    // Envelope data: the plugin id + room ride along so a webhook consumer
    // can route without parsing the plugin-specific fields.
    const payload: Record<string, unknown> = { ...data, plugin: id, room };
    this.logs.write(
      'info',
      `plugin:${id}`,
      `event '${event}' (room '${room || '-'}')`,
      { app, event },
      appRec.id,
    );
    if (this.callbacks) {
      // Declared-name check above makes the narrowing safe: the name is part
      // of the CallbackEvent taxonomy contributed by the plugin's family.
      void this.callbacks
        .dispatch(app, event as CallbackEvent, payload)
        .catch(() => undefined);
    }
    // Vision tap: additionally record occupancy/count/crowd/demography events
    // into vision.db + the rotated app log (best-effort; never throws).
    if (this.visionSink && isVisionEvent(event)) {
      this.visionSink.record(app, event, payload);
    }
    return { ok: true, event };
  }

  /**
   * LIVE-DATA READ (dashboard → core, AUTHENTICATED). Latest worker payload
   * for ANY installed plugin, regardless of ui slot — this is how app-tab
   * panels (e.g. the LPR recent-reads table) read their worker's feed. The
   * PUBLIC read (`liveOverlayData`) stays hard-gated to enabled
   * player-overlay plugins; this one sits behind the Bearer guard +
   * config-read permission instead.
   */
  async liveData(
    app: string,
    id: string,
    room: string,
  ): Promise<LiveDataView | { ts: null; ageMs: null; payload: null }> {
    await this.requireApp(app);
    this.requireMeta(id);
    const row = this.repo.get(app, id);
    if (!row) {
      throw new NotFoundException(
        `plugin '${id}' is not installed in app '${app}'`,
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

  /**
   * LIVE-DATA READ (dashboard → core, AUTHENTICATED). Latest worker payload
   * for ANY installed + enabled `needsWorker` plugin, regardless of UI slot —
   * the app-tab/panel counterpart of the public `liveOverlayData` read. An
   * app-tab worker plugin (e.g. perimeter, whose armed state + alert queue
   * must NOT be public) serves its dashboard surface through this instead of
   * mis-declaring itself a player-overlay. Gated by the caller's Bearer auth
   * (config:read at the controller); disabled/uninstalled/worker-less → 404.
   */
  async liveWorkerData(
    app: string,
    id: string,
    room: string,
  ): Promise<LiveDataView | { ts: null; ageMs: null; payload: null }> {
    await this.requireApp(app);
    const meta = this.requireMeta(id);
    const row = this.repo.get(app, id);
    if (!meta.needsWorker || !row || !row.enabled) {
      throw new NotFoundException(
        `plugin '${id}' has no live data for app '${app}'`,
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
      // Uninstalled/disabled = not wanted running across restarts (no-op when
      // the row is already gone).
      this.repo.setWorkerDesired(app, id, 'stopped');
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = validateConfig(meta, row.config, true);
    } catch {
      // Missing required config: keep it stopped rather than crash-looping, but
      // DON'T flip the intent — the operator still wants it running once the
      // config is fixed, and the boot-resume re-checks the config anyway.
      this.workers.stop(app, id);
      return;
    }
    const appDir = this.apps.appDir(app);
    const appRec = await this.apps.get(app);
    const appTimezone = await this.resolveAppTimezone(app);
    // Restart to pick up the latest config.
    this.workers.stop(app, id);
    this.workers.start(
      meta,
      app,
      appDir,
      config,
      appRec?.id ?? null,
      appTimezone,
    );
    this.repo.setWorkerDesired(app, id, 'running');
  }

  /**
   * BOOT RESUME — restart the workers an operator INTENDED to be running, so a
   * needsWorker plugin (lpr/perimeter/presence/…) survives a core restart or
   * deploy instead of silently staying down (= lost detection). For each app ×
   * installed needsWorker plugin:
   *   - backfill a missing `worker_desired` conservatively (enabled → 'running',
   *     else 'stopped') and persist it — the idempotent one-shot upgrade of
   *     pre-existing installs (the operator expects "my detection comes back");
   *   - (re)start those with desired 'running' that are enabled + have valid
   *     required config and aren't already running.
   * Best-effort: a bad app/plugin is skipped, never thrown. `app` scopes the
   * resume to one app (used by the vision→apps migration to start the migrated
   * model-apps in the SAME boot); omitted = every registered app.
   */
  async resumeDesiredWorkers(app?: string): Promise<number> {
    let appNames: string[];
    if (app) {
      appNames = [app];
    } else {
      try {
        appNames = (await this.apps.list()).map((a) => a.name);
      } catch {
        return 0;
      }
    }
    let started = 0;
    for (const name of appNames) {
      let rows;
      try {
        rows = this.repo.list(name);
      } catch {
        continue;
      }
      for (const row of rows) {
        try {
          const meta = this.registry.getMeta(row.pluginId);
          if (!meta?.needsWorker || !meta.worker) continue;
          // Backfill NULL intent from the best signal available, then persist.
          let desired = row.workerDesired;
          if (desired === null) {
            desired = row.enabled ? 'running' : 'stopped';
            this.repo.setWorkerDesired(name, row.pluginId, desired);
          }
          if (desired !== 'running' || !row.enabled) continue;
          if (this.workers.isRunning(name, row.pluginId)) continue;
          let config: Record<string, unknown>;
          try {
            config = validateConfig(meta, row.config, true);
          } catch {
            continue; // invalid required config → don't crash-loop
          }
          const appDir = this.apps.appDir(name);
          const appRec = await this.apps.get(name);
          const appTimezone = await this.resolveAppTimezone(name);
          this.workers.start(
            meta,
            name,
            appDir,
            config,
            appRec?.id ?? null,
            appTimezone,
          );
          started += 1;
        } catch {
          /* per-plugin best-effort — one bad plugin never blocks the rest */
        }
      }
    }
    return started;
  }

  /**
   * At boot, resume every worker whose recorded intent is 'running' (and
   * backfill intent for pre-existing installs). Best-effort — a resume failure
   * never blocks application startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.resumeDesiredWorkers();
      this.logs.write('info', 'plugins', `worker boot-resume: started ${n}`, {});
    } catch (err) {
      this.logs.write('warn', 'plugins', 'worker boot-resume failed', {
        error: (err as Error).message,
      });
    }
  }
}
