/**
 * PLUGIN VERSION orchestration — pin / rollback / per-app version view.
 *
 * Ties the app-AGNOSTIC bundle store (AppstoreService) to a tenant's install
 * (`app_plugins.worker_version` + `plugin_version_history`): pinning validates
 * the version exists, records the change, restarts a RUNNING worker so the new
 * version takes effect immediately (the spawn resolver picks up the pin), and
 * fires `plugin.version_changed` through the app's signed callbacks funnel.
 *
 * Rollback = repin to the `from` of the most recent change (which may be null =
 * back to built-in/latest). It is itself a change, so rollback is reversible.
 *
 * It also owns the DELETE-REFUSAL scan: a stored version cannot be deleted while
 * ANY install pins it (the store can't see installs, this service can).
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../../shared/contracts';
import { AppPluginsRepository } from '../app-plugins.repository';
import { PluginConfigError, validateConfig } from '../plugin-config.util';
import { PluginMeta } from '../plugin.contract';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginWorkerManager } from '../plugin-worker.manager';
import { AppstoreService } from './appstore.service';
import { VersionCatalog } from './appstore.types';
import {
  PluginVersionHistoryRepository,
  VersionChange,
} from './plugin-version-history.repository';

/** Per-app version state for an install (the app-scoped versions view). */
export interface AppVersionView {
  pluginId: string;
  app: string;
  /** The install's pin (`worker_version`), or null = built-in/latest. */
  active: string | null;
  /** The version that actually runs: the pin, else the built-in id. */
  effective: string | null;
  /** The full store catalog for this plugin. */
  available: VersionCatalog;
  /** Pin history, newest first. */
  history: VersionChange[];
}

@Injectable()
export class PluginVersionService {
  constructor(
    private readonly appstore: AppstoreService,
    private readonly repo: AppPluginsRepository,
    private readonly history: PluginVersionHistoryRepository,
    private readonly workers: PluginWorkerManager,
    private readonly registry: PluginRegistryService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Optional()
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks?: CallbacksServiceContract,
  ) {}

  private requireMeta(id: string): PluginMeta {
    const meta = this.registry.getMeta(id);
    if (!meta) throw new NotFoundException(`plugin '${id}' not found`);
    return meta;
  }

  private async requireApp(app: string): Promise<{ id: number }> {
    const rec = await this.apps.get(app);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
    return rec;
  }

  /** Per-app version state: active pin, effective version, catalog + history. */
  async view(app: string, id: string): Promise<AppVersionView> {
    await this.requireApp(app);
    this.requireMeta(id);
    const row = this.repo.get(app, id);
    const active = row?.workerVersion ?? null;
    const available = this.appstore.listVersions(id);
    return {
      pluginId: id,
      app,
      active,
      effective: active ?? available.builtinVersion,
      available,
      history: this.history.list(app, id),
    };
  }

  /**
   * Pin (or unpin, with null) the version an install runs. A non-null version
   * MUST exist in the store (404). Records the change, restarts a running
   * worker, and dispatches `plugin.version_changed`. Idempotent: pinning to the
   * already-active version is a no-op (no history row, no restart, no event).
   */
  async pin(
    app: string,
    id: string,
    version: string | null,
  ): Promise<AppVersionView> {
    const appRec = await this.requireApp(app);
    this.requireMeta(id);
    const row = this.repo.get(app, id);
    if (!row) {
      throw new BadRequestException(
        `plugin '${id}' is not installed in app '${app}'`,
      );
    }
    if (version !== null && !this.appstore.hasVersion(id, version)) {
      throw new NotFoundException(
        `version '${version}' of '${id}' is not in the appstore`,
      );
    }
    const from = row.workerVersion ?? null;
    if (from === version) return this.view(app, id); // no-op

    await this.applyPin(app, id, from, version, 'pin', appRec.id);
    return this.view(app, id);
  }

  /**
   * Roll back to the version the install ran BEFORE its most recent change (the
   * `from` of the latest history row — which may be null = built-in/latest).
   * 400 when there is no history to roll back to.
   */
  async rollback(app: string, id: string): Promise<AppVersionView> {
    const appRec = await this.requireApp(app);
    this.requireMeta(id);
    const row = this.repo.get(app, id);
    if (!row) {
      throw new BadRequestException(
        `plugin '${id}' is not installed in app '${app}'`,
      );
    }
    const last = this.history.latest(app, id);
    if (!last) {
      throw new BadRequestException(
        `no version history for '${id}' in app '${app}' — nothing to roll back to`,
      );
    }
    const target = last.from;
    // Guard: the rollback target may have been deleted from the store since.
    if (target !== null && !this.appstore.hasVersion(id, target)) {
      throw new BadRequestException(
        `rollback target '${target}' is no longer in the appstore`,
      );
    }
    const from = row.workerVersion ?? null;
    if (from === target) {
      // Already there (e.g. double rollback) — record nothing, no-op.
      return this.view(app, id);
    }
    await this.applyPin(app, id, from, target, 'rollback', appRec.id);
    return this.view(app, id);
  }

  /**
   * Delete a stored version, refusing when any install pins it (409) or it is a
   * built-in (400, enforced by the store). App-agnostic delete lives in the
   * store; the pin scan lives here.
   */
  async deleteVersion(id: string, version: string): Promise<void> {
    this.requireMeta(id);
    const pinnedBy = await this.appsPinning(id, version);
    if (pinnedBy.length > 0) {
      throw new ConflictException(
        `version '${version}' of '${id}' is pinned by ${pinnedBy.length} app(s) ` +
          `(${pinnedBy.slice(0, 5).join(', ')}${pinnedBy.length > 5 ? '…' : ''}) — unpin first`,
      );
    }
    this.appstore.deleteVersion(id, version);
  }

  /** App names whose install of `id` pins exactly `version`. Best-effort scan. */
  async appsPinning(id: string, version: string): Promise<string[]> {
    let names: string[] = [];
    try {
      names = (await this.apps.list()).map((a) => a.name);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      try {
        if (this.repo.get(name, id)?.workerVersion === version) out.push(name);
      } catch {
        /* skip an app whose db can't be read */
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  /** Set the pin, record history, restart a running worker, dispatch the event. */
  private async applyPin(
    app: string,
    id: string,
    from: string | null,
    to: string | null,
    action: 'pin' | 'rollback',
    appId: number,
  ): Promise<void> {
    this.repo.setWorkerVersion(app, id, to);
    this.history.record(app, id, from, to);
    this.logs.write(
      'info',
      `plugin:${id}`,
      `version ${action}: ${from ?? 'builtin'} → ${to ?? 'builtin'} (app '${app}')`,
      { app, from, to, action },
      appId,
    );
    this.restartIfRunning(app, id, appId);
    if (this.callbacks) {
      void this.callbacks
        .dispatch(app, 'plugin.version_changed', {
          plugin: id,
          app,
          from,
          to,
          action,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Restart a RUNNING worker so a re-pin takes effect immediately (stop + start
   * — start re-resolves the spawn, which now points at the pinned dir). A worker
   * that is not running is left alone: the pin applies on its next start.
   */
  private restartIfRunning(app: string, id: string, appId: number): void {
    const meta = this.registry.getMeta(id);
    if (!meta?.needsWorker || !meta.worker) return;
    if (!this.workers.isRunning(app, id)) return;
    const row = this.repo.get(app, id);
    if (!row || !row.enabled) return;
    let config: Record<string, unknown>;
    try {
      config = validateConfig(meta, row.config, true);
    } catch (e) {
      if (e instanceof PluginConfigError) return; // don't restart into a crash-loop
      throw e;
    }
    const appDir = this.apps.appDir(app);
    this.workers.stop(app, id);
    this.workers.start(meta, app, appDir, config, appId);
  }
}
