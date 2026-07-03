import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import {
  APPS_SERVICE,
  AppsServiceContract,
  LIVEKIT_SERVICE,
  LiveKitServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  StreamEgressInfo,
} from '../../shared/contracts';

/**
 * Broadcast (RTMP stream egress) orchestration.
 *
 * Flow: the browser first CONNECTS + PUBLISHES webcam/mic to the room (with a
 * `canPublish` token from POST /apps/:app/tokens); only then is `start()`
 * called — it launches a RoomComposite egress that renders the live room and
 * pushes it to the external `rtmpUrl`. `stop()` ends that egress.
 *
 * All LiveKit calls go through the guarded LiveKitService wrapper, so failures
 * surface as controlled exceptions and never crash the process.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    @Inject(LIVEKIT_SERVICE) private readonly livekit: LiveKitServiceContract,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  /** Start broadcasting `roomName` of `appName` to `rtmpUrl`. */
  async start(
    appName: string,
    roomName: string,
    rtmpUrl: string,
    layout?: string,
  ): Promise<StreamEgressInfo> {
    const room = (roomName ?? '').trim();
    if (!room) throw new BadRequestException('roomName is required');

    const url = (rtmpUrl ?? '').trim();
    if (!/^rtmps?:\/\/.+/i.test(url)) {
      throw new BadRequestException(
        'rtmpUrl must start with rtmp:// or rtmps://',
      );
    }

    const namespaced = await this.resolveRoom(appName, room);

    let info: StreamEgressInfo;
    try {
      info = await this.livekit.startStreamEgress({
        appName,
        roomName: namespaced,
        rtmpUrl: url,
        layout,
      });
    } catch (e) {
      // LiveKitService already logged; record at the broadcast layer too.
      this.logs.write('error', 'broadcast', 'startStreamEgress failed', {
        appName,
        room: namespaced,
        error: (e as Error).message,
      });
      throw new InternalServerErrorException(
        `failed to start broadcast: ${(e as Error).message}`,
      );
    }

    this.logs.write('info', 'broadcast', 'broadcast started', {
      appName,
      room: namespaced,
      egressId: info.egressId,
      status: info.status,
      urls: info.urls,
    });
    return info;
  }

  /** Stop a broadcast (stream egress) by egress id. */
  async stop(
    appName: string,
    egressId: string,
  ): Promise<{ egressId: string; status: string }> {
    const id = (egressId ?? '').trim();
    if (!id) throw new BadRequestException('egress id is required');

    let res: { egressId: string; status: string };
    try {
      res = await this.livekit.stopEgress(id);
    } catch (e) {
      this.logs.write('error', 'broadcast', 'stopEgress failed', {
        appName,
        egressId: id,
        error: (e as Error).message,
      });
      throw new InternalServerErrorException(
        `failed to stop broadcast: ${(e as Error).message}`,
      );
    }

    this.logs.write('info', 'broadcast', 'broadcast stop requested', {
      appName,
      egressId: id,
      status: res.status,
    });
    return res;
  }

  /** List active stream (RTMP) egresses belonging to the app. */
  async list(appName: string): Promise<StreamEgressInfo[]> {
    const prefix = await this.roomPrefix(appName);
    try {
      return await this.livekit.listStreamEgress(prefix);
    } catch (e) {
      // Listing must never crash; degrade to empty + log.
      this.logs.write('warn', 'broadcast', 'listStreamEgress failed', {
        appName,
        error: (e as Error).message,
      });
      return [];
    }
  }

  // ---- helpers ---------------------------------------------------------

  /** App room prefix; falls back to the app name on any error. */
  private async roomPrefix(appName: string): Promise<string> {
    try {
      const cfg = await this.apps.getConfig(appName);
      return cfg.roomPrefix || appName;
    } catch (e) {
      this.logger.warn(
        `roomPrefix lookup failed for '${appName}': ${(e as Error).message}`,
      );
      return appName;
    }
  }

  /** Namespace a requested room under the app prefix (idempotent). */
  private async resolveRoom(appName: string, room: string): Promise<string> {
    const prefix = await this.roomPrefix(appName);
    return room === prefix || room.startsWith(`${prefix}-`)
      ? room
      : `${prefix}-${room}`;
  }
}
