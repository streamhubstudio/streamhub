import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
  HlsEgressInfo,
  LIVEKIT_SERVICE,
  LiveKitServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { StreamsService } from './streams.service';

const PLAYLIST_NAME = 'index.m3u8';
const SEGMENT_DURATION_S = 4;

/** Result of starting (or reusing) a live HLS egress. */
export interface HlsStartResult {
  egressId: string;
  playlistUrl: string;
  status: string;
}

/** Result of stopping a live HLS egress. */
export interface HlsStopResult {
  egressId: string | null;
  status: string;
}

/** Live HLS status for a stream. */
export interface HlsStatusResult {
  active: boolean;
  playlistUrl: string;
}

/**
 * Live HLS egress orchestration (wave-3 §1b).
 *
 * For a stream's LiveKit room it launches a RoomComposite SegmentedFileOutput
 * (HLS) egress that writes `index.m3u8` + `.ts` segments to a LOCAL dir under
 * the data dir: `<dataDir>/apps/<app>/hls/<room>/`. The core serves that dir at
 * `/hls/<app>/<room>/...`, so the public playlist URL is
 * `<base>/hls/<app>/<room>/index.m3u8`.
 *
 * Every LiveKit call goes through the guarded LiveKitService wrapper; this
 * service never crashes the process and surfaces controlled errors.
 */
@Injectable()
export class HlsService {
  private readonly logger = new Logger(HlsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly streams: StreamsService,
    @Inject(LIVEKIT_SERVICE) private readonly livekit: LiveKitServiceContract,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    @Inject(CALLBACKS_SERVICE)
    private readonly callbacks: CallbacksServiceContract,
  ) {}

  /**
   * Start the live HLS egress for a stream's room. Idempotent: if an HLS egress
   * is already active for the room it is reused (no second egress is launched).
   */
  async start(
    appName: string,
    streamId: string,
    baseUrl: string,
  ): Promise<HlsStartResult> {
    const room = await this.resolveRoom(appName, streamId);
    const roomSlug = HlsService.safe(room);
    const playlistUrl = this.playlistUrl(baseUrl, appName, roomSlug);

    // Reuse an already-running HLS egress for this room (idempotent start).
    const existing = await this.activeForRoom(appName, room);
    if (existing) {
      return {
        egressId: existing.egressId,
        playlistUrl,
        status: existing.status,
      };
    }

    const outputDir = path.join(this.apps.appDir(appName), 'hls', roomSlug);
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (e) {
      throw new InternalServerErrorException(
        `cannot create HLS output dir: ${(e as Error).message}`,
      );
    }

    let info: HlsEgressInfo;
    try {
      info = await this.livekit.startHlsEgress({
        appName,
        roomName: room,
        outputDir,
        playlistName: PLAYLIST_NAME,
        segmentDurationS: SEGMENT_DURATION_S,
      });
    } catch (e) {
      this.logs.write('error', 'hls', 'startHlsEgress failed', {
        appName,
        room,
        error: (e as Error).message,
      });
      throw new InternalServerErrorException(
        `failed to start HLS egress: ${(e as Error).message}`,
      );
    }

    this.logs.write('info', 'hls', 'hls started', {
      appName,
      streamId,
      room,
      egressId: info.egressId,
      status: info.status,
      playlistUrl,
    });

    await this.dispatch(appName, 'hls_started', {
      app: appName,
      room,
      streamId,
      egressId: info.egressId,
      status: info.status,
      playlistUrl,
    });

    return { egressId: info.egressId, playlistUrl, status: info.status };
  }

  /** Stop the live HLS egress(es) for a stream's room. Lenient if none active. */
  async stop(appName: string, streamId: string): Promise<HlsStopResult> {
    const room = await this.resolveRoom(appName, streamId);

    let active: HlsEgressInfo[] = [];
    try {
      active = (await this.livekit.listHlsEgress(room)).filter(
        (e) => e.roomName === room,
      );
    } catch (e) {
      this.logger.warn(`listHlsEgress failed: ${(e as Error).message}`);
    }

    if (!active.length) {
      return { egressId: null, status: 'inactive' };
    }

    let lastEgressId: string | null = null;
    let lastStatus = 'inactive';
    for (const e of active) {
      try {
        const res = await this.livekit.stopEgress(e.egressId);
        lastEgressId = res.egressId;
        lastStatus = res.status;
      } catch (err) {
        this.logs.write('error', 'hls', 'stopEgress failed', {
          appName,
          room,
          egressId: e.egressId,
          error: (err as Error).message,
        });
      }
    }

    this.logs.write('info', 'hls', 'hls stop requested', {
      appName,
      streamId,
      room,
      egressId: lastEgressId,
      status: lastStatus,
    });

    await this.dispatch(appName, 'hls_stopped', {
      app: appName,
      room,
      streamId,
      egressId: lastEgressId,
      status: lastStatus,
    });

    return { egressId: lastEgressId, status: lastStatus };
  }

  /** Current live HLS status for a stream (active egress or on-disk playlist). */
  async status(
    appName: string,
    streamId: string,
    baseUrl: string,
  ): Promise<HlsStatusResult> {
    const room = await this.resolveRoom(appName, streamId);
    const roomSlug = HlsService.safe(room);
    const playlistUrl = this.playlistUrl(baseUrl, appName, roomSlug);

    let active = false;
    try {
      active = !!(await this.activeForRoom(appName, room));
    } catch (e) {
      this.logger.debug(`hls status egress check failed: ${(e as Error).message}`);
    }
    // Fall back to the on-disk playlist (egress just ended but file lingers, or
    // LiveKit listing unreachable).
    if (!active) {
      const playlistPath = path.join(
        this.apps.appDir(appName),
        'hls',
        roomSlug,
        PLAYLIST_NAME,
      );
      active = fs.existsSync(playlistPath);
    }

    return { active, playlistUrl };
  }

  // ---- helpers ---------------------------------------------------------

  /** Resolve a stream id to its (namespaced) LiveKit room name. */
  private async resolveRoom(appName: string, streamId: string): Promise<string> {
    const stream = await this.streams.get(appName, streamId);
    if (!stream) throw new NotFoundException(`stream '${streamId}' not found`);
    const room = (stream.room ?? '').trim();
    if (!room) {
      throw new BadRequestException(
        `stream '${streamId}' has no room for HLS`,
      );
    }
    return room;
  }

  /** First active HLS egress for the exact room, or undefined. */
  private async activeForRoom(
    appName: string,
    room: string,
  ): Promise<HlsEgressInfo | undefined> {
    const list = await this.livekit.listHlsEgress(room);
    return list.find((e) => e.roomName === room);
  }

  private playlistUrl(baseUrl: string, app: string, roomSlug: string): string {
    return `${baseUrl}/hls/${encodeURIComponent(app)}/${encodeURIComponent(
      roomSlug,
    )}/${PLAYLIST_NAME}`;
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

  /** Filesystem/URL-safe room segment. */
  private static safe(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
}
