import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AccessToken,
  EgressClient,
  IngressClient,
  RoomServiceClient,
  WebhookReceiver,
  type VideoGrant,
} from 'livekit-server-sdk';
import {
  DataPacket_Kind,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  ImageFileSuffix,
  ImageOutput,
  IngressInput,
  IngressState_Status,
  IngressVideoOptions,
  SegmentedFileOutput,
  SegmentedFileProtocol,
  SegmentedFileSuffix,
  StreamOutput,
  StreamProtocol,
  TrackSource,
  type EgressInfo as SdkEgressInfo,
  type IngressInfo as SdkIngressInfo,
} from '@livekit/protocol';
import type { EncodedOutputs } from 'livekit-server-sdk';
import { randomUUID } from 'crypto';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import {
  CreateIngressInput,
  EgressInfo,
  HlsEgressInfo,
  IngressInfo,
  LiveKitRoomInfo,
  LiveKitServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  MintTokenOptions,
  StartEgressInput,
  StartHlsEgressInput,
  StartStreamEgressInput,
  StreamEgressInfo,
} from '../../shared/contracts';
import { HwAccelService } from '../system/hwaccel.service';

/**
 * IngressInfo enriched with live endpoint state for the per-app listing
 * (name/status/bitrate/dimensions, AntMedia-style). All extras best-effort:
 * absent when LiveKit does not report a state for the ingress.
 */
export interface IngressListItem extends IngressInfo {
  name?: string;
  inputType?: 'rtmp' | 'whip' | 'url';
  /** inactive | buffering | publishing | error | complete. */
  status?: string;
  /** Average incoming video bitrate (bps) while publishing. */
  bitrate?: number;
  width?: number;
  height?: number;
  /** ISO timestamp of the current publish session start, when live. */
  startedAt?: string | null;
}

/** IngressState_Status → stable lowercase wire string. */
const INGRESS_STATUS_NAMES: Record<number, string> = {
  [IngressState_Status.ENDPOINT_INACTIVE]: 'inactive',
  [IngressState_Status.ENDPOINT_BUFFERING]: 'buffering',
  [IngressState_Status.ENDPOINT_PUBLISHING]: 'publishing',
  [IngressState_Status.ENDPOINT_ERROR]: 'error',
  [IngressState_Status.ENDPOINT_COMPLETE]: 'complete',
};

/** IngressInput enum → the wire inputType used across the API. */
const INGRESS_INPUT_NAMES: Record<number, 'rtmp' | 'whip' | 'url'> = {
  [IngressInput.RTMP_INPUT]: 'rtmp',
  [IngressInput.WHIP_INPUT]: 'whip',
  [IngressInput.URL_INPUT]: 'url',
};

/**
 * Normalize a LiveKit timestamp (seconds/ms/µs/ns, number or bigint) to an ISO
 * string. Magnitude-based: protocol fields are inconsistent across versions.
 */
function tsToIso(raw: bigint | number | undefined): string | null {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  let ms: number;
  if (n < 1e11) ms = n * 1000; // seconds
  else if (n < 1e14) ms = n; // milliseconds
  else if (n < 1e17) ms = n / 1e3; // microseconds
  else ms = n / 1e6; // nanoseconds
  return new Date(ms).toISOString();
}

/** Extra grant flags supported by the per-app token endpoint (SPEC §16). */
export interface MintTokenExtraOptions extends MintTokenOptions {
  /** Hidden participant (QC/recorder): invisible, not counted as viewer. */
  hidden?: boolean;
  /** Recorder/QC grant (roomRecord). */
  recorder?: boolean;
  /** Allow publishing data (chat/reactions). Defaults true. */
  canPublishData?: boolean;
  /**
   * Audio-only (wave-4 §5/§6): restrict the publisher to the microphone source
   * (no camera/screenshare). Applies only when publishing is allowed.
   */
  audioOnly?: boolean;
}

/**
 * Wrapper over livekit-server-sdk (RoomServiceClient, IngressClient,
 * EgressClient, AccessToken, WebhookReceiver) — SPEC §5 livekit.
 *
 * All outbound SDK calls are guarded: failures are logged and surfaced as
 * controlled Nest exceptions, never as an unhandled crash (SPEC §15).
 */
@Injectable()
export class LiveKitService implements LiveKitServiceContract {
  private _roomClient?: RoomServiceClient;
  private _ingressClient?: IngressClient;
  private _egressClient?: EgressClient;
  private _webhookReceiver?: WebhookReceiver;

  constructor(
    private readonly config: ConfigService,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
    // GPU hardware-accel resolver (SPEC §5 transcoding). Optional so this
    // service still constructs in unit tests / DI contexts without SystemModule;
    // absent ⇒ no hw options attached (today's CPU behaviour).
    @Optional() private readonly hwaccel?: HwAccelService,
  ) {}

  // ---------------------------------------------------------------------------
  // Hardware-accel helpers (never throw; always degrade to CPU/default).
  // ---------------------------------------------------------------------------

  /**
   * Resolve egress encoding options for an app + record the accel path used.
   * On ANY failure returns `{}` (no options ⇒ CPU/default) so egress is never
   * broken by the GPU feature.
   */
  private async egressHw(
    appName: string,
    kind: 'egress' = 'egress',
  ): Promise<{ encodingOptions?: EncodingOptions }> {
    if (!this.hwaccel) return {};
    try {
      const { encodingOptions, decision } =
        await this.hwaccel.egressEncoding(appName);
      this.hwaccel.recordUsage(kind, decision);
      if (decision.effective === 'gpu') {
        this.logs.write('info', 'livekit', 'egress using GPU hw-accel', {
          app: appName,
          type: decision.type,
          reason: decision.reason,
        });
      }
      return { encodingOptions };
    } catch (err) {
      this.logs.write('warn', 'livekit', 'egress hwaccel skipped — CPU', {
        app: appName,
        error: (err as Error)?.message,
      });
      return {};
    }
  }

  /**
   * Resolve ingress video options for an app + record the accel path used.
   * On ANY failure returns `{}` (no options ⇒ default) so ingress is never
   * broken by the GPU feature.
   */
  private async ingressHw(
    appName: string,
  ): Promise<{ video?: IngressVideoOptions }> {
    if (!this.hwaccel) return {};
    try {
      const { video, decision } = await this.hwaccel.ingressVideo(appName);
      this.hwaccel.recordUsage('ingress', decision);
      if (decision.effective === 'gpu') {
        this.logs.write('info', 'livekit', 'ingress using GPU hw-accel', {
          app: appName,
          type: decision.type,
          reason: decision.reason,
        });
      }
      return { video };
    } catch (err) {
      this.logs.write('warn', 'livekit', 'ingress hwaccel skipped — CPU', {
        app: appName,
        error: (err as Error)?.message,
      });
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // SDK client accessors (lazy; reuse a single instance).
  // ---------------------------------------------------------------------------

  /** LiveKit HTTP API base (ws:// → http://, wss:// → https://). */
  private httpUrl(): string {
    const u = this.config.livekitUrl || 'ws://127.0.0.1:7880';
    if (u.startsWith('wss://')) return 'https://' + u.slice('wss://'.length);
    if (u.startsWith('ws://')) return 'http://' + u.slice('ws://'.length);
    return u;
  }

  private get roomClient(): RoomServiceClient {
    if (!this._roomClient) {
      this._roomClient = new RoomServiceClient(
        this.httpUrl(),
        this.config.livekitApiKey,
        this.config.livekitApiSecret,
      );
    }
    return this._roomClient;
  }

  private get ingressClient(): IngressClient {
    if (!this._ingressClient) {
      this._ingressClient = new IngressClient(
        this.httpUrl(),
        this.config.livekitApiKey,
        this.config.livekitApiSecret,
      );
    }
    return this._ingressClient;
  }

  private get egressClient(): EgressClient {
    if (!this._egressClient) {
      this._egressClient = new EgressClient(
        this.httpUrl(),
        this.config.livekitApiKey,
        this.config.livekitApiSecret,
      );
    }
    return this._egressClient;
  }

  private get webhookReceiver(): WebhookReceiver {
    if (!this._webhookReceiver) {
      this._webhookReceiver = new WebhookReceiver(
        this.config.livekitApiKey,
        this.config.livekitApiSecret,
      );
    }
    return this._webhookReceiver;
  }

  /** Wrap an SDK promise: log + rethrow as 503 so the process never crashes. */
  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logs.write('error', 'livekit', `${op} failed: ${message}`, {
        op,
      });
      throw new ServiceUnavailableException(`LiveKit ${op} failed: ${message}`);
    }
  }

  private toRoomInfo(r: {
    name: string;
    sid: string;
    numParticipants: number;
    creationTime: bigint | number;
  }): LiveKitRoomInfo {
    return {
      name: r.name,
      sid: r.sid,
      numParticipants: Number(r.numParticipants ?? 0),
      creationTime: Number(r.creationTime ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------

  async createRoom(
    name: string,
    emptyTimeoutS = 300,
  ): Promise<LiveKitRoomInfo> {
    const room = await this.guard('createRoom', () =>
      this.roomClient.createRoom({ name, emptyTimeout: emptyTimeoutS }),
    );
    return this.toRoomInfo(room);
  }

  async deleteRoom(name: string): Promise<void> {
    await this.guard('deleteRoom', () => this.roomClient.deleteRoom(name));
  }

  async listRooms(names?: string[]): Promise<LiveKitRoomInfo[]> {
    const rooms = await this.guard('listRooms', () =>
      this.roomClient.listRooms(names),
    );
    return rooms.map((r) => this.toRoomInfo(r));
  }

  /** List participants of a room (used by streams/viewer counter, SPEC §16). */
  async listParticipants(room: string): Promise<
    Array<{ identity: string; name: string; hidden: boolean; isPublisher: boolean }>
  > {
    const parts = await this.guard('listParticipants', () =>
      this.roomClient.listParticipants(room),
    );
    return parts.map((p) => ({
      identity: p.identity,
      name: p.name,
      // `permission.hidden` marks QC/recorder participants.
      hidden: Boolean(p.permission?.hidden),
      isPublisher: (p.tracks?.length ?? 0) > 0,
    }));
  }

  /** Disconnect a participant from a room. */
  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.guard('removeParticipant', () =>
      this.roomClient.removeParticipant(room, identity),
    );
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  /** Contract mint: a join token from MintTokenOptions. */
  async mintToken(opts: MintTokenOptions): Promise<string> {
    return this.mintTokenAdvanced(opts);
  }

  /**
   * Mint a join token with the full set of supported grants (SPEC §16 hidden
   * QC / recorder). `canPublish`/`canSubscribe` default to true when omitted.
   */
  async mintTokenAdvanced(opts: MintTokenExtraOptions): Promise<string> {
    if (!this.config.livekitApiKey || !this.config.livekitApiSecret) {
      throw new ServiceUnavailableException(
        'LiveKit API credentials not configured',
      );
    }
    const at = new AccessToken(
      this.config.livekitApiKey,
      this.config.livekitApiSecret,
      {
        identity: opts.identity || `anon-${randomUUID()}`,
        name: opts.name,
        ttl: opts.ttl || '6h',
        metadata: opts.metadata,
      },
    );
    const canPublish = opts.canPublish ?? true;
    const grant: VideoGrant = {
      roomJoin: true,
      room: opts.room,
      canPublish,
      canSubscribe: opts.canSubscribe ?? true,
      canPublishData: opts.canPublishData ?? true,
      hidden: opts.hidden ?? false,
      roomRecord: opts.recorder ?? false,
    };
    // Audio-only (wave-4 §5/§6): limit the publisher to the microphone source.
    if (canPublish && opts.audioOnly) {
      grant.canPublishSources = [TrackSource.MICROPHONE];
    }
    at.addGrant(grant);
    try {
      return await at.toJwt();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logs.write('error', 'livekit', `mintToken failed: ${message}`);
      throw new ServiceUnavailableException(
        `LiveKit mintToken failed: ${message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Ingress
  // ---------------------------------------------------------------------------

  private ingressInputEnum(t: CreateIngressInput['inputType']): IngressInput {
    switch (t) {
      case 'rtmp':
        return IngressInput.RTMP_INPUT;
      case 'whip':
        return IngressInput.WHIP_INPUT;
      case 'url':
        return IngressInput.URL_INPUT;
      default:
        return IngressInput.RTMP_INPUT;
    }
  }

  /** Rewrite the host of an RTMP push URL to the public RTMP host if set. */
  private publicizeRtmpUrl(url: string): string {
    const host = this.config.rtmpPublicHost;
    if (!host || !url) return url;
    // rtmp://<internalhost>[:port]/<path> → rtmp://<publichost>[:port]/<path>
    return url.replace(
      /^(rtmps?:\/\/)([^/:]+)(:\d+)?(\/.*)?$/i,
      (_m, scheme, _h, port, path) =>
        `${scheme}${host}${port ?? ''}${path ?? ''}`,
    );
  }

  async createIngress(input: CreateIngressInput): Promise<IngressInfo> {
    if (input.inputType === 'url' && !input.url) {
      throw new ServiceUnavailableException(
        'createIngress: url is required for inputType "url"',
      );
    }
    // GPU hw-accel (SPEC §5): attach hardware H.264 video options only when the
    // ingress is transcoded (video options are meaningless for WHIP passthrough).
    // Any resolution failure returns {} ⇒ current default behaviour preserved.
    const hw =
      input.enableTranscoding === false
        ? {}
        : await this.ingressHw(input.appName);
    const info: SdkIngressInfo = await this.guard('createIngress', () =>
      this.ingressClient.createIngress(this.ingressInputEnum(input.inputType), {
        name: `${input.appName}-${input.roomName}`,
        roomName: input.roomName,
        participantIdentity:
          input.participantIdentity || `ingress-${randomUUID()}`,
        participantName: input.participantName,
        url: input.url,
        enableTranscoding: input.enableTranscoding,
        ...(hw.video ? { video: hw.video } : {}),
      }),
    );
    const url =
      input.inputType === 'rtmp' ? this.publicizeRtmpUrl(info.url) : info.url;
    return {
      ingressId: info.ingressId,
      url,
      streamKey: info.streamKey || undefined,
      roomName: info.roomName || input.roomName,
    };
  }

  async deleteIngress(ingressId: string): Promise<void> {
    await this.guard('deleteIngress', () =>
      this.ingressClient.deleteIngress(ingressId),
    );
  }

  /**
   * List ingresses, optionally scoped to a room. Rows are enriched with the
   * live endpoint state (status/bitrate/dimensions) so the paginated per-app
   * listing can render AntMedia-style columns without extra round-trips.
   */
  async listIngress(roomName?: string): Promise<IngressListItem[]> {
    const list = await this.guard('listIngress', () =>
      this.ingressClient.listIngress(roomName ? { roomName } : {}),
    );
    return list.map((info) => {
      const video = info.state?.video;
      return {
        ingressId: info.ingressId,
        url:
          info.inputType === IngressInput.RTMP_INPUT
            ? this.publicizeRtmpUrl(info.url)
            : info.url,
        streamKey: info.streamKey || undefined,
        roomName: info.roomName,
        name: info.name || undefined,
        inputType: INGRESS_INPUT_NAMES[info.inputType] ?? 'rtmp',
        status:
          INGRESS_STATUS_NAMES[info.state?.status ?? -1] ?? 'inactive',
        bitrate: video?.averageBitrate ? Number(video.averageBitrate) : undefined,
        width: video?.width ? Number(video.width) : undefined,
        height: video?.height ? Number(video.height) : undefined,
        startedAt: tsToIso(info.state?.startedAt),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Egress
  // ---------------------------------------------------------------------------

  private egressStatusToString(status: EgressStatus): string {
    return EgressStatus[status] ?? `EGRESS_UNKNOWN_${status}`;
  }

  async startEgress(input: StartEgressInput): Promise<EgressInfo> {
    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: input.outputFilepath,
    });

    // Wave-3 §3 snapshots: attach an ImageOutput when a capture interval is set.
    // SDK shape: EncodedOutputs.images = ImageOutput{ captureInterval (s),
    // filenamePrefix, filenameSuffix=INDEX }. The egress writes <prefix>NNNNN.jpg
    // to its local filesystem (co-located with the MP4); RecordingService then
    // sweeps + uploads them to S3.
    const wantsSnapshots =
      !!input.snapshotIntervalS &&
      input.snapshotIntervalS > 0 &&
      !!input.snapshotFilePrefix;
    const imageOutput = wantsSnapshots
      ? new ImageOutput({
          captureInterval: Math.floor(input.snapshotIntervalS as number),
          filenamePrefix: input.snapshotFilePrefix,
          filenameSuffix: ImageFileSuffix.IMAGE_SUFFIX_INDEX,
          disableManifest: true,
        })
      : undefined;

    const outputs: EncodedOutputs = imageOutput
      ? { file: fileOutput, images: imageOutput }
      : { file: fileOutput };

    // GPU hw-accel (SPEC §5): resolve encoding options for this app. `{}` when
    // no GPU / app set to cpu / any failure ⇒ current CPU/default behaviour.
    const { encodingOptions } = await this.egressHw(input.appName);

    const info: SdkEgressInfo = await this.guard('startEgress', () => {
      if (input.mode === 'participant') {
        if (!input.participantIdentity) {
          throw new Error(
            'participantIdentity required for participant egress',
          );
        }
        return this.egressClient.startParticipantEgress(
          input.roomName,
          input.participantIdentity,
          outputs,
          encodingOptions ? { encodingOptions } : undefined,
        );
      }
      return this.egressClient.startRoomCompositeEgress(input.roomName, outputs, {
        ...(input.layout ? { layout: input.layout } : {}),
        ...(encodingOptions ? { encodingOptions } : {}),
      });
    });

    return {
      egressId: info.egressId,
      status: this.egressStatusToString(info.status),
    };
  }

  /**
   * Start a RoomComposite egress that renders the room and pushes it to an
   * external RTMP/RTMPS target (YouTube/Twitch/custom) — "broadcast".
   *
   * SDK shape (livekit-server-sdk v2 / @livekit/protocol): the output is an
   * `EncodedOutputs` object with a `stream` field carrying a `StreamOutput`
   * (protocol = RTMP, urls = [rtmpUrl]); the server maps it onto the
   * RoomCompositeEgressRequest's repeated `stream_outputs`.
   */
  async startStreamEgress(
    input: StartStreamEgressInput,
  ): Promise<StreamEgressInfo> {
    const streamOutput = new StreamOutput({
      protocol: StreamProtocol.RTMP,
      urls: [input.rtmpUrl],
    });

    // GPU hw-accel (SPEC §5): `{}` on no-GPU/cpu/failure ⇒ CPU/default.
    const { encodingOptions } = await this.egressHw(input.appName);

    const info: SdkEgressInfo = await this.guard('startStreamEgress', () =>
      this.egressClient.startRoomCompositeEgress(
        input.roomName,
        { stream: streamOutput },
        {
          ...(input.layout ? { layout: input.layout } : {}),
          ...(encodingOptions ? { encodingOptions } : {}),
        },
      ),
    );

    const urls = this.extractStreamUrls(info);
    return {
      egressId: info.egressId,
      status: this.egressStatusToString(info.status),
      roomName: info.roomName || input.roomName,
      urls: urls.length ? urls : [input.rtmpUrl],
    };
  }

  /**
   * List active stream (RTMP) egresses whose room belongs to `roomPrefix`
   * (i.e. equals the prefix or starts with `<prefix>-`). File-only recording
   * egresses are filtered out.
   */
  async listStreamEgress(roomPrefix: string): Promise<StreamEgressInfo[]> {
    const list = await this.guard('listStreamEgress', () =>
      this.egressClient.listEgress({ active: true }),
    );
    return list
      .filter(
        (info) =>
          this.isStreamEgress(info) &&
          this.roomBelongsToPrefix(info.roomName, roomPrefix),
      )
      .map((info) => ({
        egressId: info.egressId,
        status: this.egressStatusToString(info.status),
        roomName: info.roomName,
        urls: this.extractStreamUrls(info),
      }));
  }

  /** True when an egress has stream (RTMP/SRT/WS) outputs rather than file-only. */
  private isStreamEgress(info: SdkEgressInfo): boolean {
    if ((info.streamResults?.length ?? 0) > 0) return true;
    const req = info.request;
    if (req?.case === 'roomComposite') {
      return (req.value.streamOutputs?.length ?? 0) > 0;
    }
    return false;
  }

  /** Pull the destination URLs from an egress (live results first, then request). */
  private extractStreamUrls(info: SdkEgressInfo): string[] {
    const live = (info.streamResults ?? [])
      .map((s) => s.url)
      .filter((u): u is string => !!u);
    if (live.length) return live;
    const req = info.request;
    if (req?.case === 'roomComposite') {
      const fromReq = (req.value.streamOutputs ?? []).flatMap((s) => s.urls);
      if (fromReq.length) return fromReq;
    }
    return [];
  }

  private roomBelongsToPrefix(room: string, prefix: string): boolean {
    if (!room || !prefix) return false;
    return room === prefix || room.startsWith(`${prefix}-`);
  }

  /**
   * Start a RoomComposite egress that writes a live HLS playlist + `.ts`
   * segments to a LOCAL directory (wave-3 §1b).
   *
   * SDK shape (livekit-server-sdk v2 / @livekit/protocol): the output is an
   * `EncodedOutputs` object whose `segments` field carries a
   * `SegmentedFileOutput`:
   *   - protocol      = SegmentedFileProtocol.HLS_PROTOCOL
   *   - playlistName  = absolute path of the `.m3u8` (e.g. <dir>/index.m3u8)
   *   - filenamePrefix= absolute prefix for the `.ts` segments (<dir>/segment_)
   *   - segmentDuration = seconds per segment
   *   - filenameSuffix  = SegmentedFileSuffix.INDEX (segment_00000.ts …)
   *   - disableManifest = true (no JSON sidecar; this is a LOCAL file egress —
   *     no upload `output` oneof is set, so the egress writes to its local FS,
   *     which is the data dir mounted into the egress container).
   * The server maps it onto the RoomCompositeEgressRequest `segment_outputs`.
   */
  async startHlsEgress(input: StartHlsEgressInput): Promise<HlsEgressInfo> {
    const playlistPath = path.join(input.outputDir, input.playlistName);
    const segments = new SegmentedFileOutput({
      protocol: SegmentedFileProtocol.HLS_PROTOCOL,
      filenamePrefix: path.join(input.outputDir, 'segment_'),
      playlistName: playlistPath,
      segmentDuration:
        input.segmentDurationS && input.segmentDurationS > 0
          ? Math.floor(input.segmentDurationS)
          : 4,
      filenameSuffix: SegmentedFileSuffix.INDEX,
      disableManifest: true,
    });

    // GPU hw-accel (SPEC §5): `{}` on no-GPU/cpu/failure ⇒ CPU/default.
    const { encodingOptions } = await this.egressHw(input.appName);

    const info: SdkEgressInfo = await this.guard('startHlsEgress', () =>
      this.egressClient.startRoomCompositeEgress(
        input.roomName,
        { segments },
        {
          ...(input.layout ? { layout: input.layout } : {}),
          ...(encodingOptions ? { encodingOptions } : {}),
        },
      ),
    );

    return {
      egressId: info.egressId,
      status: this.egressStatusToString(info.status),
      roomName: info.roomName || input.roomName,
      playlistLocation: this.extractPlaylistLocation(info),
    };
  }

  /**
   * List active HLS (segmented file) egresses whose room belongs to
   * `roomPrefix` (equals the prefix or starts with `<prefix>-`). Non-segment
   * egresses (file/stream) are filtered out.
   */
  async listHlsEgress(roomPrefix: string): Promise<HlsEgressInfo[]> {
    const list = await this.guard('listHlsEgress', () =>
      this.egressClient.listEgress({ active: true }),
    );
    return list
      .filter(
        (info) =>
          this.isHlsEgress(info) &&
          this.roomBelongsToPrefix(info.roomName, roomPrefix),
      )
      .map((info) => ({
        egressId: info.egressId,
        status: this.egressStatusToString(info.status),
        roomName: info.roomName,
        playlistLocation: this.extractPlaylistLocation(info),
      }));
  }

  /** True when an egress has segment (HLS) outputs rather than file/stream. */
  private isHlsEgress(info: SdkEgressInfo): boolean {
    if ((info.segmentResults?.length ?? 0) > 0) return true;
    const req = info.request;
    if (req?.case === 'roomComposite') {
      return (req.value.segmentOutputs?.length ?? 0) > 0;
    }
    return false;
  }

  /** Pull the playlist path from an egress (live results first, then request). */
  private extractPlaylistLocation(info: SdkEgressInfo): string | undefined {
    const live = info.segmentResults?.[0];
    if (live?.playlistLocation) return live.playlistLocation;
    if (live?.playlistName) return live.playlistName;
    const req = info.request;
    if (req?.case === 'roomComposite') {
      const out = req.value.segmentOutputs?.[0];
      if (out?.playlistName) return out.playlistName;
    }
    return undefined;
  }

  async stopEgress(egressId: string): Promise<EgressInfo> {
    const info = await this.guard('stopEgress', () =>
      this.egressClient.stopEgress(egressId),
    );
    return {
      egressId: info.egressId,
      status: this.egressStatusToString(info.status),
    };
  }

  // ---------------------------------------------------------------------------
  // Data channels (chat / reactions — SPEC §16)
  // ---------------------------------------------------------------------------

  /**
   * Send a server-side data message to a room over LiveKit data channels. Used
   * by `POST /apps/:app/streams/:id/data` to relay chat/reactions and to push
   * server-originated events. `topic` is typically `chat` or `reaction`.
   */
  async sendData(
    room: string,
    payload: string,
    opts?: { topic?: string; destinationIdentities?: string[]; reliable?: boolean },
  ): Promise<void> {
    const data = new TextEncoder().encode(payload);
    const kind =
      opts?.reliable === false
        ? DataPacket_Kind.LOSSY
        : DataPacket_Kind.RELIABLE;
    await this.guard('sendData', () =>
      this.roomClient.sendData(room, data, kind, {
        topic: opts?.topic,
        destinationIdentities: opts?.destinationIdentities,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  /**
   * Validate + decode a raw LiveKit webhook body. The signature lives in the
   * Authorization header and is checked by WebhookReceiver; an invalid/missing
   * signature throws (the controller maps it to 401).
   */
  async receiveWebhook(body: string, authHeader: string): Promise<unknown> {
    return this.webhookReceiver.receive(body, authHeader);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async isReachable(): Promise<boolean> {
    try {
      await this.roomClient.listRooms();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logs.write('warn', 'livekit', `isReachable: ${message}`);
      return false;
    }
  }
}
