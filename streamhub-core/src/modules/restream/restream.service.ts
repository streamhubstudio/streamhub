import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';

import {
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
  LIVEKIT_SERVICE,
  LiveKitServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  RestreamServiceContract,
  STREAMS_SERVICE,
  StreamsServiceContract,
} from '../../shared/contracts';
import {
  RestreamPlatform,
  RESTREAM_PLATFORMS,
  buildTargetUrl,
  maskRtmpUrl,
} from './restream.presets';
import {
  RestreamRepository,
  RestreamStatus,
  RestreamTargetRow,
} from './restream.repository';

/** Input for adding a destination to a live stream. */
export interface AddRestreamInput {
  platform?: RestreamPlatform;
  /** Full rtmp(s):// URL (custom) — or preset base override. */
  url?: string;
  /** Destination stream key (preset platforms; optional for custom). */
  key?: string;
  /** Friendly label shown in listings. */
  name?: string;
  /** Optional egress layout (e.g. "grid", "speaker"). */
  layout?: string;
}

/** A destination as exposed by the API — the stream key is ALWAYS masked. */
export interface RestreamTargetView {
  id: number;
  name: string | null;
  platform: string;
  room: string;
  streamId: string | null;
  /** Redacted destination URL (key masked). The full URL never leaves the server. */
  urlMasked: string;
  egressId: string | null;
  status: RestreamStatus;
  error: string | null;
  retries: number;
  startedAt: string;
  endedAt: string | null;
}

/** Max simultaneous live destinations per room (each one is its own egress). */
const MAX_TARGETS_PER_ROOM = 10;
/** Bounded per-endpoint retry (mirrors AntMedia endpointRepublishLimit=3). */
const RETRY_LIMIT = 3;
const RETRY_BACKOFF_BASE_MS = 5_000;

/**
 * Restream / multi-destination RTMP forwarding (AntMedia "endpoints").
 *
 * Each destination gets its OWN LiveKit RoomComposite stream egress
 * (StreamOutput RTMP), so destinations are fully isolated: one failing endpoint
 * never affects the others, and stopping one is a plain stopEgress. State per
 * endpoint lives in the app's `restream_targets` table and is advanced by the
 * LiveKit egress webhooks (onEgressEvent), with a bounded best-effort
 * relaunch-with-backoff when a destination fails.
 *
 * All LiveKit calls go through the guarded LiveKitService wrapper; callbacks
 * (restream_started/stopped/failed) reuse the HMAC-signed callback dispatcher.
 */
@Injectable()
export class RestreamService
  implements RestreamServiceContract, OnModuleDestroy
{
  private readonly logger = new Logger(RestreamService.name);
  /** egressId → app: webhook fallback when the app can't be resolved by room. */
  private readonly egressApp = new Map<string, string>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly repo: RestreamRepository,
    @Inject(LIVEKIT_SERVICE) private readonly livekit: LiveKitServiceContract,
    @Inject(STREAMS_SERVICE) private readonly streams: StreamsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks: CallbacksServiceContract,
  ) {}

  onModuleDestroy(): void {
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API (controller)
  // ---------------------------------------------------------------------------

  /** Add a destination to a live stream: build URL → start egress → persist. */
  async add(
    appName: string,
    streamId: string,
    input: AddRestreamInput,
  ): Promise<RestreamTargetView> {
    const platform = this.normalizePlatform(input.platform);
    const room = await this.resolveRoom(appName, streamId);

    let url: string;
    try {
      url = buildTargetUrl(platform, { url: input.url, key: input.key });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const urlMasked = maskRtmpUrl(url);

    if (this.repo.findLiveByUrl(appName, room, url)) {
      throw new ConflictException(
        `destination already active for room '${room}' (${urlMasked})`,
      );
    }
    if (this.repo.countLiveByRoom(appName, room) >= MAX_TARGETS_PER_ROOM) {
      throw new BadRequestException(
        `room '${room}' already has ${MAX_TARGETS_PER_ROOM} live destinations`,
      );
    }

    let egressId: string;
    let status: string;
    try {
      const info = await this.livekit.startStreamEgress({
        appName,
        roomName: room,
        rtmpUrl: url,
        layout: input.layout,
      });
      egressId = info.egressId;
      status = info.status;
    } catch (e) {
      this.logs.write('error', 'restream', 'startStreamEgress failed', {
        appName,
        room,
        platform,
        url: urlMasked,
        error: (e as Error).message,
      });
      throw new InternalServerErrorException(
        `failed to start restream: ${(e as Error).message}`,
      );
    }

    const row = this.repo.insert({
      app: appName,
      room,
      streamId,
      name: input.name?.trim() || null,
      platform,
      url,
      urlMasked,
      egressId,
    });
    this.egressApp.set(egressId, appName);

    this.logs.write('info', 'restream', 'restream destination started', {
      appName,
      room,
      streamId,
      platform,
      url: urlMasked,
      egressId,
      status,
    });
    await this.dispatch(appName, 'restream_started', {
      app: appName,
      room,
      streamId,
      targetId: row.id,
      name: row.name,
      platform,
      url: urlMasked,
      egressId,
      status: row.status,
    });

    return RestreamService.toView(row);
  }

  /**
   * List the stream's destinations (starting/active/failed) with a best-effort
   * live status refresh against LiveKit (starting → active once the egress
   * reports EGRESS_ACTIVE; webhooks settle the terminal states).
   */
  async list(appName: string, streamId: string): Promise<RestreamTargetView[]> {
    const room = await this.resolveRoom(appName, streamId);
    let rows = this.repo.listByRoom(appName, room);
    if (rows.some((r) => r.status === 'starting')) {
      await this.refreshFromLiveKit(appName, room, rows);
      rows = this.repo.listByRoom(appName, room);
    }
    return rows.map(RestreamService.toView);
  }

  /** Stop ONE destination by its egress id (the others keep pushing). */
  async remove(
    appName: string,
    streamId: string,
    egressId: string,
  ): Promise<RestreamTargetView> {
    const id = (egressId ?? '').trim();
    if (!id) throw new BadRequestException('egress id is required');
    const room = await this.resolveRoom(appName, streamId);

    const row = this.repo.byEgressId(appName, id);
    if (!row || row.room !== room) {
      throw new NotFoundException(
        `restream destination '${id}' not found for stream '${streamId}'`,
      );
    }

    // Mark terminal FIRST so the egress_ended webhook (fired by stopEgress)
    // sees a stopped row and does not double-fire restream_stopped.
    this.repo.setStatus(appName, row.id, 'stopped');
    this.egressApp.delete(id);
    if (row.status === 'starting' || row.status === 'active') {
      try {
        await this.livekit.stopEgress(id);
      } catch (e) {
        // Egress may already be gone (failed/ended) — the row is stopped anyway.
        this.logs.write('warn', 'restream', 'stopEgress failed (continuing)', {
          appName,
          egressId: id,
          error: (e as Error).message,
        });
      }
    }

    this.logs.write('info', 'restream', 'restream destination stopped', {
      appName,
      room,
      streamId,
      egressId: id,
      url: row.url_masked,
    });
    await this.dispatch(appName, 'restream_stopped', {
      app: appName,
      room,
      streamId,
      targetId: row.id,
      name: row.name,
      platform: row.platform,
      url: row.url_masked,
      egressId: id,
      reason: 'stopped_by_user',
    });

    const updated = this.repo.byId(appName, row.id) ?? row;
    return RestreamService.toView(updated);
  }

  // ---------------------------------------------------------------------------
  // Webhook path (livekit module → RESTREAM_SERVICE contract)
  // ---------------------------------------------------------------------------

  /**
   * Advance a destination's state from a LiveKit egress webhook. Non-restream
   * egresses (recording/HLS) simply don't match a row → no-op. NEVER throws:
   * the webhook sink must always ack and one endpoint's failure must not
   * disturb the others.
   */
  async onEgressEvent(
    appName: string | null,
    egressId: string,
    status: string,
  ): Promise<void> {
    try {
      const app = appName ?? this.egressApp.get(egressId) ?? null;
      if (!app) return;
      const row = this.repo.byEgressId(app, egressId);
      if (!row) return;
      // Terminal rows never move again (e.g. stop-by-user already recorded).
      if (row.status === 'stopped') return;

      switch (status) {
        case 'EGRESS_ACTIVE':
          if (row.status !== 'active') {
            this.repo.setStatus(app, row.id, 'active');
          }
          return;
        case 'EGRESS_FAILED':
        case 'EGRESS_LIMIT_REACHED':
          await this.onFailed(app, row, status);
          return;
        case 'EGRESS_COMPLETE':
        case 'EGRESS_ABORTED': {
          if (row.status === 'failed') return; // already surfaced as failed
          this.repo.setStatus(app, row.id, 'stopped');
          this.egressApp.delete(egressId);
          await this.dispatch(app, 'restream_stopped', {
            app,
            room: row.room,
            streamId: row.stream_id,
            targetId: row.id,
            name: row.name,
            platform: row.platform,
            url: row.url_masked,
            egressId,
            reason: status === 'EGRESS_ABORTED' ? 'aborted' : 'completed',
          });
          return;
        }
        default:
          return; // EGRESS_STARTING / EGRESS_ENDING → nothing to record
      }
    } catch (e) {
      this.logger.warn(
        `onEgressEvent(${egressId}, ${status}) failed: ${(e as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Per-endpoint failure + bounded retry (best-effort)
  // ---------------------------------------------------------------------------

  private async onFailed(
    app: string,
    row: RestreamTargetRow,
    status: string,
  ): Promise<void> {
    const error = `egress ${status.toLowerCase()}`;
    this.repo.setStatus(app, row.id, 'failed', error);
    this.egressApp.delete(row.egress_id ?? '');
    this.logs.write('warn', 'restream', 'restream destination failed', {
      appName: app,
      room: row.room,
      egressId: row.egress_id,
      url: row.url_masked,
      retries: row.retries,
      status,
    });
    await this.dispatch(app, 'restream_failed', {
      app,
      room: row.room,
      streamId: row.stream_id,
      targetId: row.id,
      name: row.name,
      platform: row.platform,
      url: row.url_masked,
      egressId: row.egress_id,
      error,
      retries: row.retries,
      willRetry: status === 'EGRESS_FAILED' && row.retries < RETRY_LIMIT,
    });

    // Best-effort relaunch with exponential backoff — never blocks the caller,
    // never affects other destinations. LIMIT_REACHED is not retried.
    if (status === 'EGRESS_FAILED' && row.retries < RETRY_LIMIT) {
      this.scheduleRetry(app, row.id, row.retries);
    }
  }

  private scheduleRetry(app: string, targetId: number, retries: number): void {
    const delay = RETRY_BACKOFF_BASE_MS * 2 ** retries;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.retry(app, targetId);
    }, delay);
    // Never keep the process alive just for a pending retry.
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  /** Relaunch the egress of a failed target (if still failed). Best-effort. */
  private async retry(app: string, targetId: number): Promise<void> {
    try {
      const row = this.repo.byId(app, targetId);
      if (!row || row.status !== 'failed') return; // stopped/recovered meanwhile
      const nextRetries = row.retries + 1;
      try {
        const info = await this.livekit.startStreamEgress({
          appName: app,
          roomName: row.room,
          rtmpUrl: row.url,
        });
        this.repo.setEgress(app, row.id, info.egressId, nextRetries);
        this.egressApp.set(info.egressId, app);
        this.logs.write('info', 'restream', 'restream destination relaunched', {
          appName: app,
          room: row.room,
          egressId: info.egressId,
          url: row.url_masked,
          retries: nextRetries,
        });
      } catch (e) {
        this.repo.bumpRetries(app, row.id, nextRetries);
        this.logs.write('warn', 'restream', 'restream retry failed', {
          appName: app,
          room: row.room,
          url: row.url_masked,
          retries: nextRetries,
          error: (e as Error).message,
        });
        if (nextRetries < RETRY_LIMIT) {
          this.scheduleRetry(app, row.id, nextRetries);
        }
      }
    } catch (e) {
      this.logger.warn(`retry(${app}, ${targetId}) failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private normalizePlatform(platform?: RestreamPlatform): RestreamPlatform {
    const p = (platform ?? 'custom') as RestreamPlatform;
    if (!RESTREAM_PLATFORMS.includes(p)) {
      throw new BadRequestException(
        `platform must be one of: ${RESTREAM_PLATFORMS.join(', ')}`,
      );
    }
    return p;
  }

  /** Resolve a stream id to its (namespaced) LiveKit room name. */
  private async resolveRoom(appName: string, streamId: string): Promise<string> {
    const stream = await this.streams.get(appName, streamId);
    if (!stream) throw new NotFoundException(`stream '${streamId}' not found`);
    const room = (stream.room ?? '').trim();
    if (!room) {
      throw new BadRequestException(
        `stream '${streamId}' has no room to restream`,
      );
    }
    return room;
  }

  /** Upgrade 'starting' rows to 'active' from the live egress listing. */
  private async refreshFromLiveKit(
    app: string,
    room: string,
    rows: RestreamTargetRow[],
  ): Promise<void> {
    try {
      const live = await this.livekit.listStreamEgress(room);
      const activeIds = new Set(
        live
          .filter((e) => e.status === 'EGRESS_ACTIVE')
          .map((e) => e.egressId),
      );
      for (const r of rows) {
        if (r.status === 'starting' && r.egress_id && activeIds.has(r.egress_id)) {
          this.repo.setStatus(app, r.id, 'active');
        }
      }
    } catch (e) {
      // Listing is best-effort — webhooks are the source of truth.
      this.logger.debug(`refreshFromLiveKit failed: ${(e as Error).message}`);
    }
  }

  private async dispatch(
    appName: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.callbacks.dispatch(appName, event, payload);
    } catch (e) {
      this.logger.warn(`callback ${event} failed: ${(e as Error).message}`);
    }
  }

  private static toView(row: RestreamTargetRow): RestreamTargetView {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      room: row.room,
      streamId: row.stream_id,
      urlMasked: row.url_masked,
      egressId: row.egress_id,
      status: row.status,
      error: row.error,
      retries: row.retries,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}
