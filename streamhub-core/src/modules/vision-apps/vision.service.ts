/**
 * VISION APPS — in-core read + config-resolution service, PARAMETRIZED BY MODEL.
 *
 * Serves the four vision Studio Apps (occupancy / counting / crowd / demography)
 * from ONE service — the pluginId IS the model. Owns:
 *   - RESOLUTION: a (model, room)'s effective `config_json` = model defaults
 *     (the app's install config) → tag configs (each applied tag's per-model
 *     block) → the per-room stream_settings override, via the shared
 *     {@link resolveStreamSettings};
 *   - SETTINGS: read/write the per-room `stream_settings` rows in the model's db;
 *   - READS: overview tiles, the streams view, recent events — per model;
 *   - PIPELINE aggregate: the enabled vision models + edge-assignment backlog +
 *     cluster node counts, for the pipeline dashboard block.
 *
 * ASSIGNMENTS moved to `modules/edge` (the generic app-scoped edge API +
 * reconcile) — edge is the cluster's processing concept, not a vision concern.
 * The read helpers here consult {@link EdgeAssignmentsRepository}/{@link EdgeGateway}
 * only to COUNT this app's edge workloads + online nodes (hosted from EdgeModule
 * via forwardRef, as before).
 */
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { DbService } from '../../shared/db/db.service';
import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { EdgeAssignmentsRepository } from '../edge/edge-assignments.repository';
import { EdgeGateway } from '../edge/edge.gateway';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { defaultConfig, validateConfig } from '../plugins/plugin-config.util';
import { resolveStreamSettings } from '../tags/settings-merge';
import { TagsRepository } from '../tags/tags.repository';
import { emptyModelSettings, validateModelSettings } from './vision-settings';
import { VisionStore } from './vision.store';
import {
  ModelConfig,
  VISION_MODELS,
  VisionModel,
  isVisionModel,
} from './vision.types';

/** Per-model overview tiles for the app tab. */
export interface VisionOverview {
  model: VisionModel;
  enabled: boolean;
  /** Events recorded in the last 24h for this model. */
  today: number;
  /** Live edge assignments for this app (pluginId = model). */
  assignments: number;
  activeStreams: number;
  generatedAt: string;
}

/** One active room's tags + whether this model has a settings override. */
export interface VisionStreamView {
  room: string;
  tags: string[];
  hasSettings: boolean;
  updatedAt: string | null;
}

/** Aggregate for the pipeline dashboard `compute` block (all vision models). */
export interface VisionPipelineView {
  /** Installed + enabled vision model-app ids (e.g. ['occupancy','counting']). */
  enabledModels: string[];
  /** Edge-assignment backlog across all vision models of the app. */
  assignments: { running: number; pending: number };
  /** Cluster inference nodes (total registered / live WS). */
  edge: { total: number; online: number };
}

@Injectable()
export class VisionAppService {
  private readonly logger = new Logger(VisionAppService.name);

  constructor(
    private readonly store: VisionStore,
    private readonly registry: PluginRegistryService,
    private readonly installs: AppPluginsRepository,
    private readonly tags: TagsRepository,
    private readonly assignments: EdgeAssignmentsRepository,
    private readonly gateway: EdgeGateway,
    private readonly db: DbService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  // ===========================================================================
  // config resolution
  // ===========================================================================

  /** The model-app's effective app config (defaults + install override). */
  private pluginConfig(app: string, model: VisionModel): Record<string, unknown> {
    const meta = this.registry.getMeta(model);
    if (!meta) return {};
    const row = this.installs.get(app, model);
    try {
      return row ? validateConfig(meta, row.config, false) : defaultConfig(meta);
    } catch {
      return defaultConfig(meta);
    }
  }

  /** Whether the model-app is installed AND enabled for the app. */
  private isEnabled(app: string, model: VisionModel): boolean {
    return this.installs.get(app, model)?.enabled === true;
  }

  /** Per-model default `config_json` seeded from the app's install knobs. */
  private modelDefaults(model: VisionModel, cfg: Record<string, unknown>): ModelConfig {
    const base = emptyModelSettings(model);
    if (model === 'counting' && typeof cfg.fps === 'number') base.fps = cfg.fps;
    if (model === 'demography' && typeof cfg.engine === 'string') {
      base.engine = cfg.engine;
    }
    return base;
  }

  /** The tag slugs applied to any active stream of a room (union, ordered). */
  private roomTags(app: string, room: string): string[] {
    let rows: { tags: string | null }[] = [];
    try {
      rows = this.db
        .appDb(app)
        .prepare('SELECT tags FROM streams WHERE room = ?')
        .all(room) as { tags: string | null }[];
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const r of rows) {
      if (!r.tags) continue;
      try {
        const arr = JSON.parse(r.tags);
        if (Array.isArray(arr)) {
          for (const t of arr) if (typeof t === 'string' && !out.includes(t)) out.push(t);
        }
      } catch {
        /* corrupt cell → skip */
      }
    }
    return out;
  }

  /** Each applied tag's per-model config block (in tag order). */
  private tagConfigs(app: string, room: string, model: VisionModel): ModelConfig[] {
    const out: ModelConfig[] = [];
    for (const slug of this.roomTags(app, room)) {
      let tag;
      try {
        tag = this.tags.get(app, slug);
      } catch {
        continue;
      }
      const block = tag?.config_json?.[model];
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        out.push(block as ModelConfig);
      }
    }
    return out;
  }

  /**
   * Resolve a (model, room)'s effective config_json: model defaults → tag
   * configs → stream_settings override. Never throws.
   */
  resolveModelConfig(app: string, model: VisionModel, room: string): ModelConfig {
    const cfg = this.pluginConfig(app, model);
    const appDir = this.apps.appDir(app);
    const override = this.store.getSetting(app, appDir, model, room)?.config;
    return resolveStreamSettings(
      this.modelDefaults(model, cfg),
      this.tagConfigs(app, room, model),
      override,
    );
  }

  // ===========================================================================
  // settings
  // ===========================================================================

  async getSettings(
    app: string,
    model: string,
    room: string,
  ): Promise<{ room: string; model: string; config: ModelConfig; resolved: ModelConfig; updatedAt: string | null }> {
    await this.requireApp(app);
    const m = this.requireModel(model);
    const appDir = this.apps.appDir(app);
    const row = this.store.getSetting(app, appDir, m, room);
    return {
      room,
      model: m,
      config: row?.config ?? {},
      resolved: this.resolveModelConfig(app, m, room),
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Validate + store a per-room settings override. */
  async putSettings(
    app: string,
    model: string,
    room: string,
    body: unknown,
  ): Promise<{ room: string; model: string; config: ModelConfig; resolved: ModelConfig; updatedAt: string }> {
    await this.requireApp(app);
    const m = this.requireModel(model);
    const clean = validateModelSettings(m, body);
    const appDir = this.apps.appDir(app);
    const stored = this.store.putSetting(app, appDir, m, room, clean);
    return {
      room,
      model: m,
      config: stored.config,
      resolved: this.resolveModelConfig(app, m, room),
      updatedAt: stored.updatedAt,
    };
  }

  // ===========================================================================
  // reads
  // ===========================================================================

  async overview(app: string, model: string): Promise<VisionOverview> {
    await this.requireApp(app);
    const m = this.requireModel(model);
    const appDir = this.apps.appDir(app);
    const sinceIso = new Date(Date.now() - 86400_000).toISOString();
    const assignments = this.assignments
      .list(app)
      .filter((a) => a.pluginId === m && a.status !== 'revoked' && a.status !== 'stopped').length;
    return {
      model: m,
      enabled: this.isEnabled(app, m),
      today: this.store.countSince(app, appDir, m, sinceIso),
      assignments,
      activeStreams: this.activeRooms(app).length,
      generatedAt: new Date().toISOString(),
    };
  }

  async streams(app: string, model: string): Promise<VisionStreamView[]> {
    await this.requireApp(app);
    const m = this.requireModel(model);
    const appDir = this.apps.appDir(app);
    return this.activeRooms(app).map((room) => {
      const setting = this.store.getSetting(app, appDir, m, room);
      return {
        room,
        tags: this.roomTags(app, room),
        hasSettings: !!setting,
        updatedAt: setting?.updatedAt ?? null,
      };
    });
  }

  async events(app: string, model: string, limit: number) {
    await this.requireApp(app);
    const m = this.requireModel(model);
    const appDir = this.apps.appDir(app);
    return this.store.recentEvents(app, appDir, m, limit);
  }

  // ===========================================================================
  // pipeline aggregate (all vision models of an app)
  // ===========================================================================

  /**
   * The pipeline dashboard `compute` block: which vision models the app has
   * enabled, its edge-assignment backlog, and cluster node counts. Failure-proof
   * (empty/idle when nothing is installed) — callers degrade rather than 500.
   */
  pipelineVision(app: string): VisionPipelineView {
    const enabledModels = VISION_MODELS.filter((m) => this.isEnabled(app, m));
    let running = 0;
    let pending = 0;
    try {
      const set = new Set<string>(VISION_MODELS);
      for (const a of this.assignments.list(app)) {
        if (!set.has(a.pluginId)) continue;
        if (a.status === 'running') running += 1;
        else if (a.status === 'pending') pending += 1;
      }
    } catch {
      /* no assignments repo data → zero backlog */
    }
    return {
      enabledModels,
      assignments: { running, pending },
      edge: this.nodeStats(),
    };
  }

  // ===========================================================================
  // internals
  // ===========================================================================

  private async requireApp(app: string): Promise<void> {
    const rec = await this.apps.get(app);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
  }

  private requireModel(model: string): VisionModel {
    if (!isVisionModel(model)) {
      throw new NotFoundException(
        `unknown vision model '${model}' (occupancy|counting|crowd|demography)`,
      );
    }
    return model;
  }

  private activeRooms(app: string): string[] {
    try {
      const rows = this.db
        .appDb(app)
        .prepare(
          "SELECT DISTINCT room FROM streams WHERE status = 'active' AND room IS NOT NULL AND room != '' ORDER BY room ASC",
        )
        .all() as { room: string }[];
      return rows.map((r) => r.room);
    } catch {
      return [];
    }
  }

  private nodeStats(): { total: number; online: number } {
    let rows: { id: string }[] = [];
    try {
      rows = this.db.global().prepare('SELECT id FROM nodes').all() as {
        id: string;
      }[];
    } catch {
      return { total: 0, online: 0 };
    }
    return {
      total: rows.length,
      online: rows.filter((r) => this.gateway.isConnected(r.id)).length,
    };
  }
}
