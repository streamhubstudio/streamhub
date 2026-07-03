import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';

import { Public } from '../../shared/auth/public.decorator';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { RequirePermission } from '../authz/permission.decorator';
import { QuotasService } from '../quotas/quotas.service';
import { ConfigService } from '../../shared/config/config.service';
import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbacksServiceContract,
  STREAMS_SERVICE,
  StreamsServiceContract,
} from '../../shared/contracts';
import { LiveKitService, IngressListItem } from './livekit.service';
import { IngressAuthService } from './ingress-auth.service';
import { CreateIngressDto } from './dto/create-ingress.dto';
import { ListIngressDto } from './dto/list-ingress.dto';
import { MintTokenDto } from './dto/mint-token.dto';
import {
  SendDataDto,
  ValidateIngressPasswordDto,
} from './dto/send-data.dto';

/**
 * Per-app LiveKit endpoints: join tokens (+ public/iframe URLs) and ingress
 * (RTMP/WHIP/URL) — SPEC §6 per-app, §10 player, §16 RTMP keys / hidden QC.
 *
 * Routes are scoped under `/apps/:app/...`. AppsService is resolved lazily via
 * ModuleRef so this module needs no hard import of AppsModule (avoids DI
 * cycles); failures to resolve the app config fall back to using the app name
 * as the room prefix.
 */
@ApiTags('livekit')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app')
export class LiveKitController {
  constructor(
    private readonly livekit: LiveKitService,
    private readonly config: ConfigService,
    private readonly ingressAuth: IngressAuthService,
    private readonly moduleRef: ModuleRef,
    private readonly quotas: QuotasService,
  ) {}

  /** Resolve the app's full config; null on any error (app missing, etc). */
  private async appConfig(app: string): Promise<AppConfig | null> {
    try {
      const apps = this.moduleRef.get<AppsServiceContract>(APPS_SERVICE, {
        strict: false,
      });
      return await apps.getConfig(app);
    } catch {
      return null;
    }
  }

  /** Resolve the app's room prefix; falls back to the app name on any error. */
  private async roomPrefix(app: string): Promise<string> {
    const cfg = await this.appConfig(app);
    return cfg?.roomPrefix || app;
  }

  /** Namespace a requested room under the app prefix. */
  private async resolveRoom(app: string, room?: string): Promise<string> {
    const prefix = await this.roomPrefix(app);
    if (!room) return prefix;
    return room === prefix || room.startsWith(`${prefix}-`)
      ? room
      : `${prefix}-${room}`;
  }

  /** Absolute base for player/embed pages, if PUBLIC_BASE_URL is configured. */
  private publicBase(): string {
    return (this.config.env('PUBLIC_BASE_URL') || '').replace(/\/+$/, '');
  }

  private playerUrls(app: string, room: string) {
    const base = this.publicBase();
    const playPath = `/play/${encodeURIComponent(app)}/${encodeURIComponent(room)}`;
    const embedPath = `/embed/${encodeURIComponent(app)}/${encodeURIComponent(room)}`;
    const playUrl = base ? `${base}${playPath}` : playPath;
    const embedUrl = base ? `${base}${embedPath}` : embedPath;
    return {
      wsUrl: this.config.publicWsUrl,
      playUrl,
      embedUrl,
      iframe: `<iframe src="${embedUrl}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen; camera; microphone" allowfullscreen></iframe>`,
    };
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  @Post('tokens')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: 'Mint a LiveKit join token for an app room (+ public/iframe URLs).',
  })
  async mintToken(
    @Param('app') app: string,
    @Body() dto: MintTokenDto,
    @CurrentAuth() ctx?: AuthContext,
  ) {
    const cfg = await this.appConfig(app);
    const room = cfg
      ? this.namespaceRoom(cfg.roomPrefix || app, dto.room)
      : await this.resolveRoom(app, dto.room);

    // Hidden QC is gated by the app feature flag (SPEC §16). A recorder is
    // subscribe-only by default (no publish) so it never affects the stream.
    const hiddenAllowed = cfg ? cfg.features.hiddenQc : true;
    const hidden = !!dto.hidden && hiddenAllowed;
    const recorder = !!dto.recorder;
    const canPublish =
      dto.canPublish ?? (recorder || hidden ? false : undefined);

    // Quota: a publisher token opens a new live stream slot — count it against
    // max_concurrent_streams. Subscribe-only tokens (canPublish===false) don't.
    if (canPublish !== false) {
      await this.quotas.enforceConcurrentStreams(ctx);
    }

    // Adaptive player (SPEC §16): advertise the simulcast ladder via metadata
    // so clients/recorders request the right layers.
    const metadata =
      cfg && cfg.features.adaptivePlayer
        ? this.withSimulcastHint(dto.metadata, cfg)
        : dto.metadata;

    const token = await this.livekit.mintTokenAdvanced({
      room,
      identity: dto.identity || '',
      name: dto.name,
      canPublish,
      canSubscribe: dto.canSubscribe,
      ttl: dto.ttl,
      metadata,
      hidden,
      recorder,
      audioOnly: dto.audioOnly,
    });
    return {
      data: {
        token,
        app,
        room,
        identity: dto.identity,
        hidden,
        audioOnly: !!dto.audioOnly,
        adaptive: !!cfg?.features.adaptivePlayer,
        ...this.playerUrls(app, room),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Radio (wave-4 §6): subscribe-only audio listen tokens for embeds
  // ---------------------------------------------------------------------------

  @Get('radio/:room/listen-token')
  @Public()
  @ApiOperation({
    summary:
      'Mint a subscribe-only audio token for a radio room (wave-4 §6). Public, for the listener embed.',
  })
  @ApiParam({ name: 'room', description: 'Radio room name within the app.' })
  async listenToken(
    @Param('app') app: string,
    @Param('room') roomParam: string,
  ) {
    const cfg = await this.appConfig(app);
    const room = cfg
      ? this.namespaceRoom(cfg.roomPrefix || app, roomParam)
      : await this.resolveRoom(app, roomParam);

    // Listeners are oyentes, not participants: subscribe-only, no publish, and
    // hidden so they are not counted/visible. audioOnly keeps the grant audio.
    const token = await this.livekit.mintTokenAdvanced({
      room,
      identity: `listener-${randomUUID().slice(0, 8)}`,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: true,
      audioOnly: true,
      ttl: '6h',
    });
    return {
      data: {
        token,
        app,
        room,
        wsUrl: this.config.publicWsUrl,
        mode: 'listener',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Public player token (bug fix): /play and /embed pages need a LiveKit token
  // with no login. Mints a subscribe-only VIDEO+AUDIO token for a room. Mirrors
  // the (already public) radio listen-token, but full video and not audio-only.
  // ---------------------------------------------------------------------------

  @Get('play-token/:room')
  @Public()
  @ApiOperation({
    summary:
      'Mint a subscribe-only (video+audio) token for a room. Public — powers the /play and /embed players with no auth.',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async playToken(
    @Param('app') app: string,
    @Param('room') roomParam: string,
  ) {
    const cfg = await this.appConfig(app);
    // Feature gate (default ON): an app may disable anonymous public playback.
    if (cfg && cfg.features.publicPlayback === false) {
      throw new NotFoundException('public playback is disabled for this app');
    }
    const room = cfg
      ? this.namespaceRoom(cfg.roomPrefix || app, roomParam)
      : await this.resolveRoom(app, roomParam);

    // Viewers are spectators, not participants: subscribe-only (video+audio),
    // no publish, no data, and hidden so they are never counted as a stream or
    // participant. Distinct identity per viewer so concurrent players coexist.
    const token = await this.livekit.mintTokenAdvanced({
      room,
      identity: `viewer-${randomUUID().slice(0, 8)}`,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
      hidden: true,
      ttl: '6h',
    });
    return {
      data: {
        token,
        app,
        room,
        wsUrl: this.config.publicWsUrl,
        mode: 'viewer',
      },
    };
  }

  /** Namespace a room under a known prefix (no async lookup). */
  private namespaceRoom(prefix: string, room?: string): string {
    if (!room) return prefix;
    return room === prefix || room.startsWith(`${prefix}-`)
      ? room
      : `${prefix}-${room}`;
  }

  /** Merge the app simulcast ladder into a token's metadata (streamhub namespace). */
  private withSimulcastHint(raw: string | undefined, cfg: AppConfig): string {
    let base: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        base =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : { _raw: raw };
      } catch {
        base = { _raw: raw };
      }
    }
    return JSON.stringify({
      ...base,
      streamhub: {
        simulcast: {
          adaptiveStream: true,
          simulcast: true,
          layers: cfg.webrtc.layers,
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Ingress
  // ---------------------------------------------------------------------------

  @Post('ingress')
  @RequirePermission('ingress', 'create')
  @ApiOperation({
    summary:
      'Create an RTMP/WHIP/URL ingress for an app room (key + optional password, adaptive player).',
  })
  async createIngress(
    @Param('app') app: string,
    @Body() dto: CreateIngressDto,
    @CurrentAuth() ctx?: AuthContext,
  ) {
    // Quota: an ingress opens a new live stream slot (max_concurrent_streams).
    await this.quotas.enforceConcurrentStreams(ctx);
    const cfg = await this.appConfig(app);
    const room = cfg
      ? this.namespaceRoom(cfg.roomPrefix || app, dto.room)
      : await this.resolveRoom(app, dto.room);

    // Adaptive player (SPEC §16): ensure multi-layer transcoding on the ingress.
    const adaptive = !!cfg?.features.adaptivePlayer;
    const enableTranscoding =
      dto.enableTranscoding ??
      (adaptive || !!cfg?.rtmp.transcode || dto.inputType !== 'whip');

    const info = await this.livekit.createIngress({
      appName: app,
      roomName: room,
      inputType: dto.inputType,
      participantIdentity: dto.participantIdentity || `ingress-${app}`,
      participantName: dto.participantName,
      url: dto.url,
      enableTranscoding,
    });

    const isRtmp = dto.inputType === 'rtmp';
    const wantPassword = isRtmp && !!cfg?.features.rtmpPassword;

    // Persist the ingress (+ hashed password) so the webhook can enforce it.
    let streamPassword: string | undefined;
    if (isRtmp) {
      const reg = this.ingressAuth.register({
        ingressId: info.ingressId,
        app,
        room,
        streamKey: info.streamKey,
        withPassword: wantPassword,
      });
      streamPassword = reg.password;
    }

    const player = this.playerUrls(app, room);
    return {
      data: {
        ...info,
        // Spec-shaped RTMP fields (SPEC §16). rtmp_url uses RTMP_PUBLIC_HOST.
        rtmp_url: isRtmp
          ? this.rtmpUrl(info.streamKey)
          : undefined,
        stream_key: info.streamKey,
        stream_password: streamPassword,
        requires_password: wantPassword,
        adaptive,
        player_url: player.playUrl,
        embed_iframe: player.iframe,
      },
    };
  }

  /** Build the public RTMP push URL: rtmp://<RTMP_PUBLIC_HOST>:1935/live/<key>. */
  private rtmpUrl(streamKey?: string): string | undefined {
    if (!streamKey) return undefined;
    const host = this.config.rtmpPublicHost || 'media.example.com';
    return `rtmp://${host}:1935/live/${streamKey}`;
  }

  @Post('ingress/:id/validate')
  @RequirePermission('ingress', 'write')
  @ApiOperation({
    summary:
      'Validate an RTMP stream password for an ingress (SPEC §16). Marks it authorized.',
  })
  @ApiParam({ name: 'id', description: 'Ingress id' })
  async validateIngress(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() dto: ValidateIngressPasswordDto,
  ) {
    const auth = this.ingressAuth.get(app, id);
    if (!auth) throw new NotFoundException(`ingress ${id} not found`);
    const valid = this.ingressAuth.validate(app, id, dto.password);
    return { data: { ingressId: id, valid } };
  }

  @Get('ingress')
  @RequirePermission('ingress', 'read')
  @ApiOperation({
    summary:
      'List the app ingresses, paginated ({ data, total, limit, offset }). ' +
      'Filters: room, q (id/name/room substring). Every row carries the ' +
      'ingest credentials (rtmp_url + stream_key) plus live state ' +
      '(status/bitrate/dimensions/viewers) — same ingress:read permission.',
  })
  async listIngress(@Param('app') app: string, @Query() query: ListIngressDto) {
    const prefix = await this.roomPrefix(app);
    // Best-effort: list all, then keep those whose room belongs to this app
    // (tenant isolation: an app can never see another app's ingresses).
    const all = await this.livekit.listIngress();
    let rows = all.filter(
      (i) => i.roomName === prefix || i.roomName.startsWith(`${prefix}-`),
    );

    const room = query.room?.trim();
    if (room) {
      rows = rows.filter(
        (i) => i.roomName === room || i.roomName === `${prefix}-${room}`,
      );
    }
    const q = query.q?.trim().toLowerCase();
    if (q) {
      rows = rows.filter((i) =>
        [i.ingressId, i.name, i.roomName].some(
          (v) => typeof v === 'string' && v.toLowerCase().includes(q),
        ),
      );
    }

    const total = rows.length;
    const limit = LiveKitController.clampInt(query.limit, 50, 1, 500);
    const offset = LiveKitController.clampInt(
      query.offset,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const page = rows.slice(offset, offset + limit);

    // Approximate per-room viewers for the PAGE rows only: one listRooms call,
    // viewers ≈ participants - 1 (the ingress publisher). Best-effort — a
    // LiveKit hiccup only hides the count, never fails the listing.
    const viewersByRoom = new Map<string, number>();
    const pageRooms = [...new Set(page.map((i) => i.roomName))];
    if (pageRooms.length > 0) {
      try {
        const liveRooms = await this.livekit.listRooms(pageRooms);
        for (const r of liveRooms) {
          viewersByRoom.set(r.name, Math.max(0, r.numParticipants - 1));
        }
      } catch {
        /* viewers stay unknown */
      }
    }

    const data = page.map((i: IngressListItem) => ({
      ...i,
      room: i.roomName,
      // Persisten los campos que la UI necesita para OBS (no solo al crear).
      stream_key: i.streamKey,
      rtmp_url: this.rtmpUrl(i.streamKey),
      viewers: viewersByRoom.has(i.roomName)
        ? viewersByRoom.get(i.roomName)
        : null,
      requires_password: !!this.safeAuth(app, i.ingressId)?.requiresPassword,
    }));
    return { data, total, limit, offset };
  }

  /** ingress_auth lookup that never throws (row/db may be absent). */
  private safeAuth(app: string, ingressId: string) {
    try {
      return this.ingressAuth.get(app, ingressId);
    } catch {
      return null;
    }
  }

  /** Clamp an optional integer to [min,max], falling back when absent/NaN. */
  private static clampInt(
    raw: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (raw === undefined || raw === null || Number.isNaN(raw)) return fallback;
    return Math.min(Math.max(Math.floor(raw), min), max);
  }

  @Get('ingress/:id')
  @RequirePermission('ingress', 'read')
  @ApiOperation({ summary: 'Get a single ingress by id.' })
  async getIngress(@Param('app') _app: string, @Param('id') id: string) {
    const all = await this.livekit.listIngress();
    const info = all.find((i) => i.ingressId === id);
    if (!info) throw new NotFoundException(`ingress ${id} not found`);
    return { data: info };
  }

  @Delete('ingress/:id')
  @RequirePermission('ingress', 'delete')
  @ApiOperation({ summary: 'Delete an ingress by id.' })
  async deleteIngress(@Param('app') app: string, @Param('id') id: string) {
    await this.livekit.deleteIngress(id);
    this.ingressAuth.remove(app, id);
    return { data: { ingressId: id, deleted: true } };
  }

  // ---------------------------------------------------------------------------
  // Data channels (chat / reactions — SPEC §16)
  // ---------------------------------------------------------------------------

  @Post('streams/:id/data')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary:
      'Send a server-side data message to a stream room (chat/reaction) and fire callbacks.',
  })
  @ApiParam({ name: 'id', description: 'Stream id (or room name).' })
  async sendData(
    @Param('app') app: string,
    @Param('id') id: string,
    @Body() dto: SendDataDto,
  ) {
    const cfg = await this.appConfig(app);
    // Respect feature flags: chat topic needs `chat`, reaction needs `reactions`.
    if (cfg) {
      if (dto.topic === 'chat' && !cfg.features.chat) {
        throw new NotFoundException('chat is disabled for this app');
      }
      if (dto.topic === 'reaction' && !cfg.features.reactions) {
        throw new NotFoundException('reactions are disabled for this app');
      }
    }

    const room = await this.roomForStream(app, id);

    const envelope = {
      topic: dto.topic,
      from: dto.from,
      message: dto.message,
      reaction: dto.reaction,
      ts: new Date().toISOString(),
    };
    const payload = dto.payload ?? JSON.stringify(envelope);

    await this.livekit.sendData(room, payload, {
      topic: dto.topic,
      destinationIdentities: dto.destinationIdentities,
      reliable: dto.reliable,
    });

    // Outbound callbacks (SPEC §16): chat_message / reaction.
    if (dto.topic === 'chat' || dto.topic === 'reaction') {
      const callbacks = this.resolveCallbacks();
      if (callbacks) {
        const event = dto.topic === 'chat' ? 'chat_message' : 'reaction';
        try {
          await callbacks.dispatch(app, event, {
            room,
            streamId: id,
            ...envelope,
          });
        } catch {
          /* dispatch is best-effort; never fail the send */
        }
      }
    }

    return { data: { sent: true, room, topic: dto.topic } };
  }

  /** Resolve the LiveKit room for a stream id; fall back to treating id as room. */
  private async roomForStream(app: string, streamId: string): Promise<string> {
    const streams = this.resolveStreams();
    if (streams) {
      try {
        const s = await streams.get(app, streamId);
        if (s?.room) return s.room;
      } catch {
        /* fall through to room-name resolution */
      }
    }
    return this.resolveRoom(app, streamId);
  }

  private resolveStreams(): StreamsServiceContract | null {
    try {
      return this.moduleRef.get<StreamsServiceContract>(STREAMS_SERVICE, {
        strict: false,
      });
    } catch {
      return null;
    }
  }

  private resolveCallbacks(): CallbacksServiceContract | null {
    try {
      return this.moduleRef.get<CallbacksServiceContract>(CALLBACKS_SERVICE, {
        strict: false,
      });
    } catch {
      return null;
    }
  }
}
