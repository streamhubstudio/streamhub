/**
 * LiveControlService — the in-core engine behind BOTH live-control plugins.
 *
 * WHY A MODULE, NOT A WORKER: pausing/finishing an already-live stream is pure
 * control-plane state + a couple of best-effort side effects (LiveKit audio mute
 * + a data-channel push + a callbacks event). There is nothing to spawn, so it
 * lives as a small feature module (`modules/live-control`) that owns a per-app
 * `live-control.db` and the app's S3 cover assets — the same shape as `fleet`.
 *
 * The two plugin manifests only provide marketplace entries + UI slots:
 *   - `live-control`          (app-tab, kind:'app') → the operator console
 *   - `live-control-overlay`  (player-overlay)      → the viewer cover
 * Both talk to THIS service through /apps/:app/plugins/live-control/*. The public
 * `/public` route (no auth) feeds the anonymous /play + /embed overlay.
 *
 * Every side effect (mute / push / event) is best-effort and never throws into
 * the state transition — the state machine is the source of truth.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  S3Config,
  STREAMS_SERVICE,
  StreamsServiceContract,
} from '../../shared/contracts';
import { LiveKitService } from '../livekit/livekit.service';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { S3Service } from '../s3/s3.service';
import {
  AppDefaults,
  LiveControlOp,
  ResolvedCover,
  opTarget,
  resolveCover,
} from './live-control.logic';
import {
  AssetRow,
  CoverMode,
  LiveControlState,
  LiveControlStore,
  StreamOverride,
} from './live-control.store';

/** The plugin id whose per-app config carries the static live-control defaults. */
export const LIVE_CONTROL_PLUGIN_ID = 'live-control';
/** LiveKit data-channel topic the overlay subscribes to for instant updates. */
export const LIVE_CONTROL_TOPIC = 'live-control';
/** Presigned-GET lifetime for cover assets (seconds). */
const ASSET_URL_TTL = 3600;

/** Static per-app defaults read from the `live-control` plugin config. */
export interface StaticDefaults {
  defaultMode: CoverMode;
  defaultCardTitle: string;
  defaultCardText: string;
  defaultCardColor: string;
  muteAudioServerSide: boolean;
  pollSeconds: number;
}

/** The full per-app settings view (static config knobs + dynamic asset ids). */
export interface LiveControlSettingsView extends StaticDefaults {
  defaultPauseAssetId: number | null;
  defaultFinishAssetId: number | null;
}

const FALLBACK: StaticDefaults = {
  defaultMode: 'text',
  defaultCardTitle: 'We will be right back',
  defaultCardText: 'The live stream is paused.',
  defaultCardColor: '#0b0b0f',
  muteAudioServerSide: true,
  pollSeconds: 5,
};

/** The live-control state of a stream as returned to the operator/overlay. */
export interface StreamControlView {
  streamId: string;
  room: string | null;
  state: LiveControlState;
  since: string | null;
  /** Resolved cover (null when live) with a signed asset URL attached. */
  cover: (ResolvedCover & { assetUrl: string | null }) | null;
}

/** A live stream row joined with its live-control state (operator list). */
export interface StreamListItem {
  streamId: string;
  type: string;
  room: string;
  status: string;
  startedAt: string;
  participant: string | null;
  viewers?: number;
  control: StreamControlView;
}

/** An uploaded cover asset with a signed preview URL. */
export interface AssetView extends AssetRow {
  url: string | null;
}

@Injectable()
export class LiveControlService {
  constructor(
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(STREAMS_SERVICE) private readonly streams: StreamsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    private readonly repo: AppPluginsRepository,
    private readonly store: LiveControlStore,
    private readonly s3: S3Service,
    @Optional()
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks?: CallbacksServiceContract,
    @Optional() private readonly livekit?: LiveKitService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Live streams of the app joined with their live-control state. */
  async listStreams(app: string): Promise<{ streams: StreamListItem[]; generatedAt: string }> {
    const appDir = this.apps.appDir(app);
    const defaults = await this.appDefaults(app, appDir);
    const rows = await this.streams.list(app);
    const streams = await Promise.all(
      rows.map(async (r) => {
        const state = this.store.getState(app, appDir, r.streamId);
        return {
          streamId: r.streamId,
          type: r.type,
          room: r.room,
          status: r.status,
          startedAt: r.startedAt,
          participant: r.participant,
          viewers: r.viewers,
          control: await this.viewFor(app, r.streamId, r.room, state, defaults),
        };
      }),
    );
    return { streams, generatedAt: new Date().toISOString() };
  }

  /** One stream's live-control state (works even if the stream row is gone). */
  async getStream(app: string, streamId: string): Promise<StreamControlView> {
    const appDir = this.apps.appDir(app);
    const defaults = await this.appDefaults(app, appDir);
    const stream = await this.streams.get(app, streamId).catch(() => null);
    const state = this.store.getState(app, appDir, streamId);
    return this.viewFor(app, streamId, stream?.room ?? state?.room ?? null, state, defaults);
  }
  // (viewFor is async; the caller returns its promise directly)

  /**
   * PUBLIC (no auth) state for the anonymous overlay: `{ streamId, state, cover }`
   * with the cover's signed asset URL attached. Selected by `stream` id OR by
   * `room` (the player overlay only knows its room — resolve it to the live
   * stream publishing there). Returns `live`/null cover for an unknown or
   * untouched stream so the overlay simply shows nothing.
   */
  async publicState(
    app: string,
    sel: { stream?: string; room?: string },
  ): Promise<StreamControlView> {
    const appDir = this.apps.appDir(app);
    const defaults = await this.appDefaults(app, appDir);
    const streamId = await this.resolveStreamId(app, sel);
    if (!streamId) {
      return { streamId: '', room: sel.room ?? null, state: 'live', since: null, cover: null };
    }
    const state = this.store.getState(app, appDir, streamId);
    return this.viewFor(app, streamId, state?.room ?? sel.room ?? null, state, defaults);
  }

  /** Resolve the target stream id from a `stream`/`room` selector. */
  private async resolveStreamId(
    app: string,
    sel: { stream?: string; room?: string },
  ): Promise<string | null> {
    const stream = sel.stream?.trim();
    if (stream) return stream;
    const room = sel.room?.trim();
    if (!room) return null;
    try {
      const rows = await this.streams.list(app);
      const match =
        rows.find((r) => r.room === room) ??
        rows.find((r) => r.room.endsWith(`-${room}`) || r.room === `${room}`) ??
        null;
      return match?.streamId ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Transitions (pause / resume / finish)
  // ---------------------------------------------------------------------------

  /**
   * Apply an operator op. Persists the new state, then best-effort: toggles the
   * server-side audio mute, pushes the state to the room's data channel and fires
   * the callbacks funnel event. Returns the resulting control view.
   */
  async transition(
    app: string,
    streamId: string,
    op: LiveControlOp,
    override: StreamOverride = {},
  ): Promise<StreamControlView> {
    const appDir = this.apps.appDir(app);
    const defaults = await this.appDefaults(app, appDir);

    // Validate a referenced asset actually exists (avoids a broken cover).
    if (override.assetId !== undefined && override.assetId !== null) {
      if (!this.store.getAsset(app, appDir, override.assetId)) {
        throw new BadRequestException(`asset '${override.assetId}' not found`);
      }
    }

    const target = opTarget(op);
    const stream = await this.streams.get(app, streamId).catch(() => null);
    const prev = this.store.getState(app, appDir, streamId);
    const room = stream?.room ?? prev?.room ?? null;

    const row = this.store.setState(app, appDir, streamId, target, room, override);

    // --- best-effort side effects (never break the transition) ---
    if (defaults.muteAudioServerSide !== false) {
      void this.setAudioMuted(app, room, target !== 'live');
    }
    void this.pushState(app, room, streamId, target);
    void this.emitEvent(app, op, streamId, room, target, override);

    this.logs.write('info', 'live-control', `stream '${streamId}' → ${target}`, {
      app,
      stream: streamId,
      op,
    });

    return this.viewFor(app, streamId, room, row, defaults);
  }

  // ---------------------------------------------------------------------------
  // Assets (S3)
  // ---------------------------------------------------------------------------

  /** List uploaded cover assets, each with a signed preview URL. */
  async listAssets(app: string): Promise<AssetView[]> {
    const appDir = this.apps.appDir(app);
    const config = await this.apps.getConfig(app);
    const rows = this.store.listAssets(app, appDir);
    const out: AssetView[] = [];
    for (const r of rows) {
      out.push({ ...r, url: await this.signAsset(config, r.s3Key) });
    }
    return out;
  }

  /**
   * Upload a cover asset to the app S3 and record it. Requires storage: reuses
   * the recording module's 409 `storage_not_configured` guard.
   */
  async uploadAsset(
    app: string,
    file: { buffer?: Buffer; originalname?: string; mimetype?: string },
    label?: string,
  ): Promise<AssetView> {
    const config = await this.apps.getConfig(app);
    this.assertStorageConfigured(app, config);
    const appDir = this.apps.appDir(app);

    const buffer = file?.buffer;
    if (!buffer || !buffer.length) {
      throw new BadRequestException('empty upload (field name must be `file`)');
    }
    const mimetype = (file.mimetype || '').toLowerCase();
    const kind: 'image' | 'video' = mimetype.startsWith('video/')
      ? 'video'
      : mimetype.startsWith('image/')
        ? 'image'
        : this.rejectKind(mimetype);

    const safe = sanitizeName(file.originalname || `${kind}.bin`);
    const key = `live-control/assets/${randomUUID()}-${safe}`;
    await this.s3.uploadBuffer(config.s3 as S3Config, buffer, key, mimetype);

    const row = this.store.addAsset(app, appDir, {
      kind,
      s3Key: key,
      filename: safe,
      contentType: mimetype,
      sizeBytes: buffer.length,
      label: label?.trim() ? label.trim().slice(0, 200) : null,
    });
    this.logs.write('info', 'live-control', `cover asset uploaded (${kind})`, {
      app,
      asset: row.id,
    });
    return { ...row, url: await this.signAsset(config, key) };
  }

  /** Delete an asset (db row + S3 object, best-effort). */
  async deleteAsset(app: string, id: number): Promise<{ removed: boolean }> {
    const appDir = this.apps.appDir(app);
    const row = this.store.removeAsset(app, appDir, id);
    if (!row) throw new NotFoundException(`asset '${id}' not found`);
    try {
      const config = await this.apps.getConfig(app);
      if (config.s3?.bucket) await this.s3.delete(config.s3 as S3Config, row.s3Key);
    } catch (err) {
      this.warn(app, 'S3 asset delete failed', err);
    }
    return { removed: true };
  }

  /** A fresh signed preview URL for one asset. */
  async assetUrl(app: string, id: number): Promise<{ url: string }> {
    const appDir = this.apps.appDir(app);
    const row = this.store.getAsset(app, appDir, id);
    if (!row) throw new NotFoundException(`asset '${id}' not found`);
    const config = await this.apps.getConfig(app);
    this.assertStorageConfigured(app, config);
    const url = await this.signAsset(config, row.s3Key);
    return { url: url ?? '' };
  }

  // ---------------------------------------------------------------------------
  // Per-app settings (dynamic asset defaults) + merged view
  // ---------------------------------------------------------------------------

  /** Per-app defaults: static config knobs + the dynamic default-asset choices. */
  async getSettings(app: string): Promise<LiveControlSettingsView> {
    const appDir = this.apps.appDir(app);
    const s = this.staticDefaults(app);
    const kv = this.store.getSettings(app, appDir);
    return {
      ...s,
      defaultPauseAssetId: intOrNull(kv.defaultPauseAssetId),
      defaultFinishAssetId: intOrNull(kv.defaultFinishAssetId),
    };
  }

  /** Update the dynamic default-asset choices (validates the ids exist). */
  async updateSettings(
    app: string,
    patch: { defaultPauseAssetId?: number | null; defaultFinishAssetId?: number | null },
  ): Promise<LiveControlSettingsView> {
    const appDir = this.apps.appDir(app);
    for (const key of ['defaultPauseAssetId', 'defaultFinishAssetId'] as const) {
      if (!(key in patch)) continue;
      const v = patch[key];
      if (v === null || v === undefined) {
        this.store.setSetting(app, appDir, key, null);
      } else {
        if (!this.store.getAsset(app, appDir, v)) {
          throw new BadRequestException(`asset '${v}' not found`);
        }
        this.store.setSetting(app, appDir, key, String(v));
      }
    }
    return this.getSettings(app);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Build the control view (state + resolved cover + signed asset url). */
  private async viewFor(
    app: string,
    streamId: string,
    room: string | null,
    state: ReturnType<LiveControlStore['getState']>,
    defaults: AppDefaults & { appDir: string; config: AppConfig },
  ): Promise<StreamControlView> {
    const st: LiveControlState = state?.state ?? 'live';
    const override: StreamOverride = {
      mode: state?.mode ?? undefined,
      assetId: state?.assetId ?? undefined,
      cardTitle: state?.cardTitle ?? undefined,
      cardText: state?.cardText ?? undefined,
      cardColor: state?.cardColor ?? undefined,
    };
    const cover = resolveCover(st, override, defaults);
    let withUrl: (ResolvedCover & { assetUrl: string | null }) | null = null;
    if (cover) {
      withUrl = { ...cover, assetUrl: null };
      if (cover.assetId != null) {
        const asset = this.store.getAsset(app, defaults.appDir, cover.assetId);
        withUrl.assetUrl = asset ? await this.signAsset(defaults.config, asset.s3Key) : null;
      }
    }
    return { streamId, room, state: st, since: state?.since ?? null, cover: withUrl };
  }

  /** Presign an object GET (or build the public URL) for a stored key. */
  private async signAsset(config: AppConfig, key: string): Promise<string | null> {
    const s3 = config.s3;
    if (!s3?.bucket) return null;
    try {
      if (s3.publicUrl && s3.publicUrl.trim()) {
        const base = s3.publicUrl.replace(/\/+$/, '');
        const prefix = s3.prefix ? `${s3.prefix.replace(/\/+$/, '')}/` : '';
        return `${base}/${prefix}${key}`;
      }
      return await this.s3.presignGet(s3 as S3Config, key, ASSET_URL_TTL);
    } catch (err) {
      this.warn(config.name ?? '', 'presign failed', err);
      return null;
    }
  }

  /** Best-effort server-side mute/unmute of every published audio track. */
  private async setAudioMuted(app: string, room: string | null, muted: boolean): Promise<void> {
    if (!this.livekit || !room) return;
    try {
      const parts = await this.livekit.listParticipantsDetailed(room);
      for (const p of parts) {
        for (const tr of p.tracks) {
          if (tr.type !== 'audio') continue;
          try {
            await this.livekit.mutePublishedTrack(room, p.identity, tr.sid, muted);
          } catch {
            /* per-track best-effort */
          }
        }
      }
    } catch (err) {
      this.warn(app, 'audio mute toggle failed', err);
    }
  }

  /** Best-effort data-channel push so mounted overlays react instantly. */
  private async pushState(
    app: string,
    room: string | null,
    streamId: string,
    state: LiveControlState,
  ): Promise<void> {
    if (!this.livekit || !room) return;
    try {
      const payload = JSON.stringify({
        type: 'live-control',
        app,
        stream: streamId,
        state,
        at: new Date().toISOString(),
      });
      await this.livekit.sendData(room, payload, {
        topic: LIVE_CONTROL_TOPIC,
        reliable: true,
      });
    } catch (err) {
      this.warn(app, 'state push skipped', err);
    }
  }

  /** Best-effort signed callbacks event (webhook + MQTT + Streamflow). */
  private async emitEvent(
    app: string,
    op: LiveControlOp,
    streamId: string,
    room: string | null,
    state: LiveControlState,
    override: StreamOverride,
  ): Promise<void> {
    if (!this.callbacks) return;
    const name =
      op === 'pause'
        ? 'livecontrol.paused'
        : op === 'finish'
          ? 'livecontrol.finished'
          : 'livecontrol.resumed';
    try {
      await this.callbacks.dispatch(app, name as CallbackEvent, {
        stream: streamId,
        room,
        state,
        mode: override.mode ?? null,
        assetId: override.assetId ?? null,
      });
    } catch (err) {
      this.warn(app, 'callbacks dispatch skipped', err);
    }
  }

  /** Static defaults from the console plugin's per-app config. */
  private staticDefaults(app: string): StaticDefaults {
    const row = this.repo.get(app, LIVE_CONTROL_PLUGIN_ID);
    const c = (row?.config ?? {}) as Record<string, unknown>;
    return {
      defaultMode: normMode(c.defaultMode, FALLBACK.defaultMode),
      defaultCardTitle: strCfg(c.defaultCardTitle, FALLBACK.defaultCardTitle),
      defaultCardText: strCfg(c.defaultCardText, FALLBACK.defaultCardText),
      defaultCardColor: strCfg(c.defaultCardColor, FALLBACK.defaultCardColor),
      muteAudioServerSide: c.muteAudioServerSide !== false,
      pollSeconds: numCfg(c.pollSeconds, FALLBACK.pollSeconds),
    };
  }

  /** Full AppDefaults for resolveCover (static + dynamic) + carried context. */
  private async appDefaults(
    app: string,
    appDir: string,
  ): Promise<AppDefaults & StaticDefaults & { appDir: string; config: AppConfig }> {
    const s = this.staticDefaults(app);
    const kv = this.store.getSettings(app, appDir);
    const config = await this.apps.getConfig(app).catch(() => ({}) as AppConfig);
    return {
      ...s,
      defaultPauseAssetId: intOrNull(kv.defaultPauseAssetId),
      defaultFinishAssetId: intOrNull(kv.defaultFinishAssetId),
      appDir,
      config,
    };
  }

  /** Recording-module storage guard: 409 storage_not_configured. */
  private assertStorageConfigured(app: string, config: AppConfig): void {
    if (!config.s3?.bucket || !config.s3.bucket.trim()) {
      throw new HttpException(
        {
          error: 'storage_not_configured',
          message: `app '${app}' has no S3 storage bucket configured; cover assets cannot be uploaded`,
          app,
        },
        HttpStatus.CONFLICT,
      );
    }
  }

  private rejectKind(mimetype: string): never {
    throw new BadRequestException(
      `unsupported asset type '${mimetype || 'unknown'}' (image/* or video/* only)`,
    );
  }

  private warn(app: string, message: string, err: unknown): void {
    try {
      this.logs.write('warn', 'live-control', message, {
        app,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* logging must never throw */
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normMode(v: unknown, fallback: CoverMode): CoverMode {
  return v === 'image' || v === 'video' || v === 'text' ? v : fallback;
}

function strCfg(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

function numCfg(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function intOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizeName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').trim();
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (safe || 'asset').slice(0, 100);
}
