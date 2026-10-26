import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
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
  PassthroughIngressInfo,
  STREAMS_SERVICE,
  StreamsServiceContract,
} from '../../shared/contracts';
import { LiveKitService, IngressListItem } from './livekit.service';
import { IngressAuthService } from './ingress-auth.service';
import {
  IngressBackupService,
  type IngressRoleInfo,
} from './ingress-backup.service';
import {
  clampPlaybackTtl,
  signPlayback,
  verifyPlayback,
} from './playback-url.util';
import {
  buildRtmpUrl,
  buildRtmpsUrl,
  type RtmpUrlConfig,
} from './ingress-rtmp-url.util';
import {
  CreateIngressDto,
  IngressInputTypeDto,
  IngressModeDto,
} from './dto/create-ingress.dto';
import { ListIngressDto } from './dto/list-ingress.dto';
import { PassthroughService } from '../passthrough/passthrough.service';
import {
  MpegtsSourceError,
  parseMpegtsSource,
} from '../passthrough/mpegts-source.util';
import { MintTokenDto } from './dto/mint-token.dto';
import { SignPlaybackUrlDto } from './dto/sign-playback-url.dto';
import {
  SendDataDto,
  ValidateIngressPasswordDto,
} from './dto/send-data.dto';

/**
 * Fallback `emptyTimeout` (seconds) for a pre-created persistent/always-on room
 * (QW-1) when the app config does not carry an explicit value: 24h. Long enough
 * that a source outage never recycles the room (which would change its SID and
 * drop every viewer).
 */
const LONG_EMPTY_TIMEOUT_S = 86400;

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
    private readonly ingressBackup: IngressBackupService,
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
    // the tenant's max_concurrent_streams AND the per-app quota (config.yaml
    // `quotas:` block; default unlimited). Subscribe-only tokens don't.
    if (canPublish !== false) {
      await this.quotas.enforceConcurrentStreams(ctx);
      await this.quotas.enforceAppConcurrentStreams(
        app,
        cfg?.quotas?.maxConcurrentStreams ?? -1,
        ctx,
      );
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
  // CORS: this public token powers embeddable/downloadable listener bundles that
  // may be hosted on a DIFFERENT origin (S3, Netlify, …). A simple GET needs the
  // response to allow cross-origin reads. Safe: subscribe-only, gated by the
  // app's publicPlayback feature (or a signed URL for private-playback apps).
  @Header('Access-Control-Allow-Origin', '*')
  @ApiOperation({
    summary:
      'Mint a subscribe-only audio token for a radio room (wave-4 §6). Public, for the listener embed.',
  })
  @ApiParam({ name: 'room', description: 'Radio room name within the app.' })
  async listenToken(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Query('exp') exp?: string,
    @Query('sig') sig?: string,
  ) {
    const cfg = await this.appConfig(app);
    // P0-3: private-playback apps require a signed URL on the radio listener
    // path too (same capability signature as play-token).
    this.assertPlaybackAllowed(cfg, app, roomParam, exp, sig);
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
  // Public player token: /play and /embed pages need a LiveKit token with no
  // login. Mints a subscribe-only VIDEO+AUDIO token for a room. Mirrors the
  // (already public) radio listen-token, but full video and not audio-only.
  //
  // Security fix P0-3: when the app opts OUT of public playback
  // (features.public_playback: false) this endpoint no longer refuses outright
  // NOR trusts room-name secrecy — it requires a signed short-TTL capability
  // URL (?exp=&sig=, HMAC per app+room, minted by POST play-token/:room/sign).
  // Fully-public apps (default) keep anonymous playback with no signature.
  // ---------------------------------------------------------------------------

  @Get('play-token/:room')
  @Public()
  // CORS: this public token powers embeddable/downloadable viewer bundles that
  // may be hosted on a DIFFERENT origin (S3, Netlify, …). A simple GET needs the
  // response to allow cross-origin reads. Safe: subscribe-only, gated by the
  // app's publicPlayback feature (or a signed URL for private-playback apps).
  @Header('Access-Control-Allow-Origin', '*')
  @ApiOperation({
    summary:
      'Mint a subscribe-only (video+audio) token for a room. Public — powers the /play and /embed players. ' +
      'Apps with public_playback:false require a signed URL (?exp=&sig=) from POST play-token/:room/sign.',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async playToken(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Query('exp') exp?: string,
    @Query('sig') sig?: string,
  ) {
    const cfg = await this.appConfig(app);
    this.assertPlaybackAllowed(cfg, app, roomParam, exp, sig);
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

  // ---------------------------------------------------------------------------
  // Signed playback URLs (P0-3) — authenticated mint for private-playback apps
  // ---------------------------------------------------------------------------

  @Post('play-token/:room/sign')
  @RequirePermission('stream', 'read')
  @ApiOperation({
    summary:
      'Mint a signed short-TTL playback capability for a room (P0-3). Returns a ' +
      'tokenized /play + /embed URL and an <iframe> snippet — the SAFE way to ' +
      'embed a private-playback app (public_playback:false). The capability is ' +
      'app+room-scoped and expiring (exp is inside the HMAC), and is NEITHER an ' +
      'sk_ API token NOR a JWT session — so embed snippets never leak a bearer. ' +
      'Default TTL 300s (clamped 30s–24h).',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  signPlaybackUrl(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Body() dto: SignPlaybackUrlDto,
  ) {
    const master = this.config.jwtSecret;
    if (!master) {
      throw new ServiceUnavailableException(
        'STREAMHUB_JWT_SECRET is required to mint signed playback URLs',
      );
    }
    // The embed token IS the P0-3 signed capability: an HMAC over app+room+exp
    // (per-app derived key), carried on the URL as ?exp=&sig=. The embed page
    // forwards it to GET play-token/:room, which validates it SERVER-SIDE
    // (assertPlaybackAllowed → verifyPlayback) before minting a subscribe-only
    // LiveKit token. So the iframe below is a full player widget gated by a
    // scoped, expiring token — no privileged credential ever appears in it.
    const ttl = clampPlaybackTtl(dto?.ttlSeconds);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = signPlayback(master, app, roomParam, exp);
    const query = `exp=${exp}&sig=${sig}`;
    const base = this.publicBase();
    const abs = (p: string) => (base ? `${base}${p}` : p);
    // The raw API capability URL (back-compat) …
    const tokenUrl = abs(
      `/api/v1/apps/${encodeURIComponent(app)}` +
        `/play-token/${encodeURIComponent(roomParam)}?${query}`,
    );
    // … and the operator-facing player/embed surfaces (SPA routes) that carry
    // the SAME capability so a private app can be shared/embedded without login.
    const playUrl = abs(
      `/play/${encodeURIComponent(app)}/${encodeURIComponent(roomParam)}?${query}`,
    );
    const embedUrl = abs(
      `/embed/${encodeURIComponent(app)}/${encodeURIComponent(roomParam)}?${query}`,
    );
    const iframe =
      `<iframe src="${embedUrl}" width="640" height="360" frameborder="0" ` +
      `allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
    return {
      data: {
        app,
        room: roomParam,
        exp,
        ttlSeconds: ttl,
        sig,
        tokenUrl,
        playUrl,
        embedUrl,
        iframe,
      },
    };
  }

  /**
   * P0-3 gate shared by the public playback endpoints. PUBLIC apps (flag
   * unset/true — the default) pass with no signature (back-compat: anonymous
   * playback keeps working). PRIVATE apps (public_playback:false) require a
   * valid, unexpired capability signature over app+room+exp; anything else is
   * 403 (never leaks whether the room exists).
   */
  private assertPlaybackAllowed(
    cfg: AppConfig | null,
    app: string,
    roomParam: string,
    exp?: string,
    sig?: string,
  ): void {
    if (!cfg || cfg.features.publicPlayback !== false) return;
    const verdict = verifyPlayback({
      masterSecret: this.config.jwtSecret,
      app,
      room: roomParam,
      exp,
      sig,
    });
    if (verdict === 'ok') return;
    throw new ForbiddenException(
      verdict === 'expired'
        ? 'signed playback URL expired'
        : 'playback for this app requires a valid signed URL',
    );
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

    // RTMP/SRT→HLS passthrough (remux, no transcode): bypasses LiveKit entirely.
    // Mode comes from the request, defaulting to the app's `rtmp.passthrough`.
    // The whole LiveKit branch below is left byte-for-byte untouched for the
    // (default) transcode mode.
    const mode: 'transcode' | 'passthrough' =
      dto.mode ?? (cfg?.rtmp?.passthrough ? 'passthrough' : 'transcode');
    if (mode === 'passthrough') {
      return this.createPassthroughIngress(app, room, dto);
    }
    // SRT push is passthrough-only: LiveKit's ingress API has no SRT input type
    // (rtmp|whip|url). The DTO already enforces this (SrtRequiresPassthroughMode);
    // this is defence in depth for direct callers. To PULL a remote SRT source
    // via LiveKit use inputType 'url' with an srt:// url instead.
    if (dto.inputType === IngressInputTypeDto.srt) {
      throw new BadRequestException(
        "inputType 'srt' requires mode 'passthrough' — the LiveKit transcode path has no SRT input type",
      );
    }
    // MPEG-TS/UDP multicast is a remux-only PULL ingest (defence in depth for
    // direct callers; the DTO enforces MpegtsRequiresPassthroughMode too).
    if (dto.inputType === IngressInputTypeDto.mpegts) {
      throw new BadRequestException(
        "inputType 'mpegts' requires mode 'passthrough' — MPEG-TS/UDP is a remux-only PULL ingest",
      );
    }

    // Adaptive player (SPEC §16): ensure multi-layer transcoding on the ingress.
    const adaptive = !!cfg?.features.adaptivePlayer;
    const enableTranscoding =
      dto.enableTranscoding ??
      (adaptive || !!cfg?.rtmp.transcode || dto.inputType !== 'whip');

    // QW-1 (24/7 linear channels): pre-create the room with a LONG emptyTimeout
    // BEFORE the ingress so a brief source outage never recycles the room (which
    // would change its SID and drop viewers). Ingress-auto-created rooms use
    // LiveKit's ~300s server default and the ingress SDK can't carry a room
    // config, so this is the only seam. Gated by the app's `features.linear`
    // flag → conference/normal apps keep the 300s default. Best-effort: a
    // createRoom hiccup must never block ingress creation.
    // CAVEAT: LiveKit createRoom only sets emptyTimeout for a room that does not
    // yet EXIST — it will not lower/raise an already-live room's timeout.
    const linear = cfg?.features.linear;
    if (linear?.persistentRoom) {
      try {
        await this.livekit.createRoom(
          room,
          linear.roomEmptyTimeoutSeconds || LONG_EMPTY_TIMEOUT_S,
        );
      } catch {
        /* best-effort — never fail ingress create on a room pre-create hiccup */
      }
    }

    const primaryIdentity = dto.participantIdentity?.trim() || `ingress-${app}`;
    const info = await this.livekit.createIngress({
      appName: app,
      roomName: room,
      inputType: dto.inputType,
      participantIdentity: primaryIdentity,
      participantName: dto.participantName,
      url: dto.url,
      enableTranscoding,
      // Efficient transcode profile: a capped ladder ONLY when the app explicitly
      // turns adaptive on; otherwise a SINGLE capped layer (the safe default that
      // skips LiveKit's CPU-heavy 3-layer simulcast). Both are capped at
      // webrtc.transcode_max_height (default 720).
      simulcast: cfg?.webrtc?.adaptive === true,
      maxHeight: cfg?.webrtc?.transcodeMaxHeight,
      // Audio-only (radio): drop video ⇒ near-idle CPU, no GPU.
      audioOnly: dto.audioOnly === true,
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

    // Primary + backup (failover) stream keys — RTMP only. Create a SECOND
    // ingress bound to the SAME room, with a DISTINCT participant identity so
    // LiveKit never evicts one when both push. Both keys therefore publish into
    // one room ⇒ the player/playback URL is identical whichever key is live.
    // The backup is standby: primary is preferred; the operator points a
    // failover encoder at the backup key and only pushes it if the primary
    // drops. (Simultaneous dual-push yields two publishers — see the ingress
    // feature doc; StreamHub does not force-switch, keeping this simple/correct.)
    const wantBackup = isRtmp && dto.backup === true;
    let backupInfo: Awaited<ReturnType<LiveKitService['createIngress']>> | undefined;
    let backupPassword: string | undefined;
    if (wantBackup) {
      backupInfo = await this.livekit.createIngress({
        appName: app,
        roomName: room,
        inputType: dto.inputType,
        participantIdentity: `${primaryIdentity}-backup`,
        participantName: dto.participantName
          ? `${dto.participantName} (backup)`
          : undefined,
        enableTranscoding,
        simulcast: cfg?.webrtc?.adaptive === true,
        maxHeight: cfg?.webrtc?.transcodeMaxHeight,
      });
      const backupReg = this.ingressAuth.register({
        ingressId: backupInfo.ingressId,
        app,
        room,
        streamKey: backupInfo.streamKey,
        withPassword: wantPassword,
      });
      backupPassword = backupReg.password;
      this.ingressBackup.link(app, {
        primaryIngressId: info.ingressId,
        backupIngressId: backupInfo.ingressId,
        room,
      });
    }

    const player = this.playerUrls(app, room);
    return {
      data: {
        ...info,
        // Spec-shaped RTMP fields (SPEC §16). rtmp_url uses RTMP_PUBLIC_HOST;
        // rtmps_url is present only when STREAMHUB_RTMPS_ENABLE is on.
        rtmp_url: isRtmp ? this.rtmpUrl(info.streamKey) : undefined,
        rtmps_url: isRtmp ? this.rtmpsUrl(info.streamKey) : undefined,
        stream_key: info.streamKey,
        stream_password: streamPassword,
        requires_password: wantPassword,
        // Primary + backup (failover) key surface. `primaryStreamKey` mirrors
        // `stream_key`; the backup fields are present only when a backup was
        // minted. Both keys share the same room ⇒ the same player_url below.
        role: isRtmp ? 'primary' : undefined,
        hasBackup: wantBackup,
        primaryStreamKey: isRtmp ? info.streamKey : undefined,
        primary_rtmp_url: isRtmp ? this.rtmpUrl(info.streamKey) : undefined,
        primary_rtmps_url: isRtmp ? this.rtmpsUrl(info.streamKey) : undefined,
        ...(backupInfo
          ? {
              backupIngressId: backupInfo.ingressId,
              backupStreamKey: backupInfo.streamKey,
              backup_stream_key: backupInfo.streamKey,
              backup_rtmp_url: this.rtmpUrl(backupInfo.streamKey),
              backup_rtmps_url: this.rtmpsUrl(backupInfo.streamKey),
              backup_stream_password: backupPassword,
            }
          : {}),
        adaptive,
        player_url: player.playUrl,
        embed_iframe: player.iframe,
      },
    };
  }

  /**
   * PASSTHROUGH branch of createIngress (mode=passthrough). Never calls
   * `livekit.createIngress`: mints a passthrough key, arms the remux (RTMP
   * `-listen 1` or SRT `mode=listener` push acceptor, or an MPEG-TS/UDP PULL
   * `-f mpegts -i udp://@GROUP:PORT`) and returns the push/pull + playback
   * surface + the capabilities-lost block. Passthrough is rtmp/srt/mpegts-only
   * and mutually exclusive with adaptive/transcode/backup — mixing them is a 400
   * (the mixing is prevented, not silently ignored).
   */
  private createPassthroughIngress(
    app: string,
    room: string,
    dto: CreateIngressDto,
  ) {
    if (
      dto.inputType !== IngressInputTypeDto.rtmp &&
      dto.inputType !== IngressInputTypeDto.srt &&
      dto.inputType !== IngressInputTypeDto.mpegts
    ) {
      throw new BadRequestException(
        'passthrough ingress requires inputType=rtmp, inputType=srt or inputType=mpegts',
      );
    }
    if (dto.enableTranscoding === true) {
      throw new BadRequestException(
        'passthrough (remux) cannot be combined with transcoding — pick one mode',
      );
    }
    if (dto.backup === true) {
      throw new BadRequestException(
        'passthrough does not support a backup/failover key',
      );
    }
    if (dto.audioOnly === true) {
      throw new BadRequestException(
        'passthrough does not support audio-only (there is no transcode to drop video)',
      );
    }
    const passthrough = this.resolvePassthrough();
    if (!passthrough) {
      throw new ServiceUnavailableException(
        'RTMP/SRT/MPEG-TS passthrough plane is unavailable',
      );
    }
    const inputType =
      dto.inputType === IngressInputTypeDto.mpegts
        ? ('mpegts' as const)
        : dto.inputType === IngressInputTypeDto.srt
          ? ('srt' as const)
          : ('rtmp' as const);

    // MPEG-TS is a PULL source: validate + canonicalize the udp:// input (a bad
    // group/port/SSM list is a 400) and pass it to the remux. RTMP keeps the
    // pre-SRT call shape byte-for-byte; SRT passes its transport.
    let info;
    if (inputType === 'mpegts') {
      if (!dto.url || !dto.url.trim()) {
        throw new BadRequestException(
          "inputType 'mpegts' requires `url` — a udp://@GROUP:PORT source",
        );
      }
      let sourceUrl: string;
      try {
        sourceUrl = parseMpegtsSource({
          url: dto.url.trim(),
          sources: dto.sources,
          localaddr: dto.localaddr,
          fifoSize: dto.fifoSize,
          overrunNonfatal: dto.overrunNonfatal,
        }).sourceUrl;
      } catch (err) {
        if (err instanceof MpegtsSourceError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      info = passthrough.create(app, room, undefined, 'mpegts', sourceUrl);
    } else if (inputType === 'srt') {
      info = passthrough.create(app, room, undefined, 'srt');
    } else {
      info = passthrough.create(app, room);
    }

    const player = this.playerUrls(app, room);
    return {
      data: {
        mode: 'passthrough' as const,
        ingressId: info.ingressId,
        app: info.app,
        room: info.room,
        inputType: info.inputType ?? inputType,
        streamKey: info.streamKey,
        stream_key: info.streamKey,
        // Push/pull surface per transport (exactly one): rtmp://…/<app>/<key>
        // XOR srt://…?streamid=<key> XOR the udp://@GROUP:PORT source_url.
        rtmp_url: info.rtmpUrl || undefined,
        srt_url: info.srtUrl,
        source_url: info.sourceUrl,
        hls_url: info.hlsUrl,
        player_url: info.playerUrl ?? player.playUrl,
        embed_iframe: player.iframe,
        capabilities: info.capabilities,
      },
    };
  }

  /** Resolve PassthroughService lazily (avoids a LiveKit↔Passthrough DI cycle). */
  private resolvePassthrough(): PassthroughService | null {
    try {
      return this.moduleRef.get(PassthroughService, { strict: false });
    } catch {
      return null;
    }
  }

  /** Snapshot of the RTMP/RTMPS URL config for the pure URL builders. */
  private rtmpCfg(): RtmpUrlConfig {
    return {
      rtmpPublicHost: this.config.rtmpPublicHost,
      rtmpsEnable: this.config.rtmpsEnable,
      rtmpsPublicHost: this.config.rtmpsPublicHost,
      rtmpsPort: this.config.rtmpsPort,
    };
  }

  /** Build the public RTMP push URL: rtmp://<RTMP_PUBLIC_HOST>:1935/live/<key>. */
  private rtmpUrl(streamKey?: string): string | undefined {
    return buildRtmpUrl(streamKey, this.rtmpCfg());
  }

  /**
   * Build the public RTMPS push URL: rtmps://<host>:<port>/live/<key>. Returns
   * undefined unless STREAMHUB_RTMPS_ENABLE is on (TLS front, see deploy/rtmps/).
   */
  private rtmpsUrl(streamKey?: string): string | undefined {
    return buildRtmpsUrl(streamKey, this.rtmpCfg());
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

    // Full id→row map so a primary row can carry its paired backup's key
    // without an extra round-trip (the backup ingress is elsewhere in `all`).
    const byId = new Map(all.map((i) => [i.ingressId, i]));

    const data = page.map((i: IngressListItem) => ({
      ...i,
      room: i.roomName,
      // Persisten los campos que la UI necesita para OBS (no solo al crear).
      stream_key: i.streamKey,
      rtmp_url: this.rtmpUrl(i.streamKey),
      rtmps_url: this.rtmpsUrl(i.streamKey),
      viewers: viewersByRoom.has(i.roomName)
        ? viewersByRoom.get(i.roomName)
        : null,
      requires_password: !!this.safeAuth(app, i.ingressId)?.requiresPassword,
      // Primary + backup (failover) role annotation.
      ...this.backupFields(app, i.ingressId, byId),
    }));

    // Merge the passthrough (remux) ingresses — they have no LiveKit ingress, so
    // they are sourced from the passthrough plane and appended on the first page.
    // Non-passthrough apps get an empty list ⇒ the response is byte-for-byte
    // unchanged from before this feature.
    const ptRows = this.passthroughRows(app, room, q);
    return {
      data: offset === 0 ? [...data, ...ptRows] : data,
      total: total + ptRows.length,
      limit,
      offset,
    };
  }

  /**
   * Passthrough ingress rows for the listing, filtered by the same room/q as the
   * LiveKit rows and mapped to the shared list shape (rtmp_url + hls_url + live
   * status). Empty when the passthrough plane is unavailable or has no rows.
   */
  private passthroughRows(
    app: string,
    room: string | undefined,
    q: string | undefined,
  ): Record<string, unknown>[] {
    const passthrough = this.resolvePassthrough();
    if (!passthrough) return [];
    let rows: PassthroughIngressInfo[];
    try {
      rows = passthrough.list(app);
    } catch {
      return [];
    }
    if (room) {
      rows = rows.filter(
        (r) => r.room === room || r.room.endsWith(`-${room}`),
      );
    }
    if (q) {
      rows = rows.filter((r) =>
        [r.ingressId, r.room, r.streamKey].some((v) =>
          v.toLowerCase().includes(q),
        ),
      );
    }
    return rows.map((r) => ({
      ingressId: r.ingressId,
      mode: 'passthrough',
      room: r.room,
      roomName: r.room,
      stream_key: r.streamKey,
      streamKey: r.streamKey,
      // Push/pull surface per transport (exactly one): rtmp_url XOR srt_url XOR
      // source_url (mpegts PULL). RTMP rows keep the pre-SRT shape (the srt/mpegts
      // fields absent) so nothing about the existing listing changed.
      ...(r.inputType === 'mpegts'
        ? { inputType: 'mpegts', source_url: r.sourceUrl }
        : r.inputType === 'srt'
          ? { inputType: 'srt', srt_url: r.srtUrl }
          : { rtmp_url: r.rtmpUrl }),
      hls_url: r.hlsUrl,
      player_url: r.playerUrl,
      status: r.status,
      playlistFresh: r.playlistFresh,
      requires_password: false,
      viewers: null,
      capabilities: r.capabilities,
    }));
  }

  /**
   * Role + paired-key fields for one ingress row (primary/backup failover). A
   * PRIMARY row also carries its backup's stream key + push URLs (resolved from
   * `byId`) so the dashboard can show both keys from a single row. Never throws:
   * a missing link/row simply yields `{}`.
   */
  private backupFields(
    app: string,
    ingressId: string,
    byId: Map<string, IngressListItem>,
  ): Record<string, unknown> {
    const roleInfo = this.safeRoleInfo(app, ingressId);
    if (!roleInfo || !roleInfo.role) return {};
    const out: Record<string, unknown> = {
      role: roleInfo.role,
      pairedIngressId: roleInfo.pairedIngressId ?? undefined,
    };
    if (roleInfo.role === 'primary' && roleInfo.backupIngressId) {
      const b = byId.get(roleInfo.backupIngressId);
      if (b?.streamKey) {
        out.backupIngressId = b.ingressId;
        out.backupStreamKey = b.streamKey;
        out.backup_stream_key = b.streamKey;
        out.backup_rtmp_url = this.rtmpUrl(b.streamKey);
        out.backup_rtmps_url = this.rtmpsUrl(b.streamKey);
      }
    }
    return out;
  }

  /** ingress_backup role lookup that never throws (link/db may be absent). */
  private safeRoleInfo(app: string, ingressId: string): IngressRoleInfo | null {
    try {
      return this.ingressBackup.getRoleInfo(app, ingressId);
    } catch {
      return null;
    }
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
  async getIngress(@Param('app') app: string, @Param('id') id: string) {
    const all = await this.livekit.listIngress();
    const info = all.find((i) => i.ingressId === id);
    if (!info) throw new NotFoundException(`ingress ${id} not found`);
    const byId = new Map(all.map((i) => [i.ingressId, i]));
    return { data: { ...info, ...this.backupFields(app, id, byId) } };
  }

  @Delete('ingress/:id')
  @RequirePermission('ingress', 'delete')
  @ApiOperation({
    summary:
      'Delete an ingress by id. Deleting a PRIMARY also tears down its paired ' +
      'BACKUP (failover) ingress; deleting a backup just unlinks the pair.',
  })
  async deleteIngress(@Param('app') app: string, @Param('id') id: string) {
    // Passthrough (remux) ingress: no LiveKit ingress behind it — tear it down
    // via the passthrough plane (stop remux + drop key + clean HLS) and return.
    // Never calls livekit.deleteIngress.
    if (PassthroughService.isPassthroughId(id)) {
      const removed = this.resolvePassthrough()?.remove(app, id) ?? false;
      return { data: { ingressId: id, deleted: removed, mode: 'passthrough' } };
    }

    const link = this.safeLink(app, id);
    await this.livekit.deleteIngress(id);
    this.ingressAuth.remove(app, id);

    // Failover cascade: a primary + its backup are one logical endpoint, so
    // removing the primary removes the standby backup too (leaving it would let
    // an orphan key silently accept a push into the same room). Removing a
    // backup only drops the pairing. Best-effort — the primary delete already
    // succeeded, so a backup cleanup hiccup never fails the request.
    let cascadedBackupId: string | undefined;
    if (link) {
      if (link.primaryIngressId === id) {
        cascadedBackupId = link.backupIngressId;
        try {
          await this.livekit.deleteIngress(link.backupIngressId);
        } catch {
          /* backup may already be gone */
        }
        this.safeAuthRemove(app, link.backupIngressId);
      }
      this.safeBackupUnlink(app, id);
    }
    return {
      data: {
        ingressId: id,
        deleted: true,
        ...(cascadedBackupId ? { backupIngressId: cascadedBackupId } : {}),
      },
    };
  }

  /** ingress_backup pairing lookup that never throws (link/db may be absent). */
  private safeLink(app: string, ingressId: string) {
    try {
      return this.ingressBackup.getLinkFor(app, ingressId);
    } catch {
      return null;
    }
  }

  /** Drop the pairing referencing an ingress id, swallowing any error. */
  private safeBackupUnlink(app: string, ingressId: string): void {
    try {
      this.ingressBackup.remove(app, ingressId);
    } catch {
      /* best-effort */
    }
  }

  /** Remove an ingress_auth row, swallowing any error (cascade cleanup). */
  private safeAuthRemove(app: string, ingressId: string): void {
    try {
      this.ingressAuth.remove(app, ingressId);
    } catch {
      /* best-effort */
    }
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
