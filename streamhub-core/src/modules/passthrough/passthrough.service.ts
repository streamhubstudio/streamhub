/**
 * PASSTHROUGH SERVICE — orchestration + auth gate for RTMP/SRT→HLS passthrough
 * (remux, no transcode). This is the ONLY place the passthrough ingest plane
 * touches the rest of the system; it never calls LiveKit.
 *
 * Auth model (the "prePublish" gate): the passthrough stream key IS the
 * capability. {@link handlePublish} looks the key up via
 * `IngressAuthService.findByStreamKey`; an unknown key (or a non-passthrough
 * key) is REJECTED and NO ffmpeg is spawned. A valid `ptk_` key arms the remux
 * ({@link RemuxManager.start}) which stream-copies the RTMP/SRT push into the
 * app's HLS dir. Deleting the ingress ({@link remove}) stops the remux, drops
 * the key and cleans the HLS dir.
 *
 * The embedded ingest front (an ffmpeg acceptor per ingress: `-listen 1` RTMP /
 * `srt://…?mode=listener` SRT — the transport is persisted in the ingress id,
 * see `passthroughTransportOf`) is armed at ingress-create time, so in practice
 * `handlePublish` runs when the operator creates the ingress; it is factored out
 * as its own method so a real central RTMP server (should one ever be added) can
 * call it on its prePublish event and so the accept/reject invariant is
 * unit-testable with a fake driver.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';

import { ConfigService } from '../../shared/config/config.service';
import {
  PassthroughCapabilities,
  PassthroughIngressInfo,
  STREAMS_SERVICE,
  StreamsServiceContract,
} from '../../shared/contracts';
import {
  IngressAuthService,
  PASSTHROUGH_INGRESS_ID_PREFIX,
  passthroughTransportOf,
} from '../livekit/ingress-auth.service';
import {
  buildPassthroughRtmpUrl,
  buildPassthroughSrtUrl,
  DEFAULT_RTMP_HOST,
  RTMP_APP,
} from '../livekit/ingress-rtmp-url.util';
import {
  PASSTHROUGH_HLS_PLAYLIST,
  PASSTHROUGH_SRT_LATENCY_MS,
  passthroughHlsDir,
  PassthroughTransport,
} from './remux-args.util';
import { RemuxManager, RemuxStatus } from './remux.manager';

/** A playlist written within this window is considered "fresh" (live). */
const PLAYLIST_FRESH_MS = 30_000;

/** Remux-id namespace for the LiveKit-plane forward children (single-port switch). */
const FORWARD_ID_PREFIX = 'fwd_';
const forwardRemuxId = (key: string): string => `${FORWARD_ID_PREFIX}${key}`;

/**
 * How often the passthrough→streams-table sync runs. Passthrough bypasses
 * LiveKit, so no webhook ever upserts a `streams` row — without this sync a
 * live passthrough channel is invisible in the dashboard's Streams view
 * ("no active streams" while HLS is very much on air).
 */
const STREAM_SYNC_INTERVAL_MS = 15_000;

export interface HandlePublishResult {
  accepted: boolean;
  ingressId?: string;
  port?: number;
}

@Injectable()
export class PassthroughService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PassthroughService.name);
  /** Ports currently bound by armed listeners. */
  private readonly usedPorts = new Set<number>();
  /** ingressId → its assigned listener port (stable while armed). */
  private readonly portById = new Map<string, number>();
  /** streams-table sync timer (see {@link syncStreamRows}). */
  private syncTimer?: ReturnType<typeof setInterval>;
  /** Rooms currently marked active in the streams table (avoid redundant writes). */
  private readonly liveRooms = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly ingressAuth: IngressAuthService,
    private readonly remux: RemuxManager,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    if (!this.config.rtmpPassthroughEnable) return;
    this.syncTimer = setInterval(
      () => void this.syncStreamRows(),
      STREAM_SYNC_INTERVAL_MS,
    );
    this.syncTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
  }

  /** Lazily resolved StreamsService (ModuleRef, no hard module import). */
  private streams(): StreamsServiceContract | null {
    try {
      return this.moduleRef.get<StreamsServiceContract>(STREAMS_SERVICE, {
        strict: false,
      });
    } catch {
      return null;
    }
  }

  /**
   * Mirror live passthrough remuxes into the per-app `streams` table so the
   * dashboard Streams view shows them (passthrough bypasses LiveKit ⇒ no
   * webhook ever creates the row). Fresh playlist ⇒ upsert an ACTIVE row
   * (`<room>/passthrough`, one publisher = one stream); stale/stopped ⇒ end it
   * (contract: `end` is a no-op when absent/already ended). Best-effort — a
   * failure here must never affect the media plane.
   */
  async syncStreamRows(): Promise<void> {
    const streams = this.streams();
    if (!streams) return;
    for (const e of this.remux.list()) {
      const key = `${e.app}::${e.room}`;
      const streamId = `${e.room}/passthrough`;
      try {
        const live = e.desired === 'live' && this.playlistFresh(e.app, e.room);
        if (live) {
          // Upsert EVERY tick while live (idempotent, sets status active): the
          // row must self-heal even if something else ended it between ticks.
          await streams.upsert(e.app, streamId, 'rtmp', e.room, 'passthrough');
          this.liveRooms.add(key);
        } else if (this.liveRooms.has(key)) {
          await streams.end(e.app, streamId);
          this.liveRooms.delete(key);
        }
      } catch (err) {
        this.logger.warn(
          `streams-table sync failed for ${key}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  /** Master switch (STREAMHUB_RTMP_PASSTHROUGH_ENABLE). */
  enabled(): boolean {
    return this.config.rtmpPassthroughEnable;
  }

  /** Whether an ingress id belongs to the passthrough plane. */
  static isPassthroughId(id: string): boolean {
    return id.startsWith(PASSTHROUGH_INGRESS_ID_PREFIX);
  }

  /**
   * Create a passthrough ingress for an ALREADY-namespaced room: mint a `ptk_`
   * key, arm the remux and return the push/playback surface + the
   * capabilities-lost block. The remux is a push LISTENER for RTMP (`-listen 1`)
   * / SRT (`mode=listener`), or a PULL for MPEG-TS (`-f mpegts -i udp://@…`, the
   * canonical `sourceUrl` — REQUIRED for that transport). Throws 503 when the
   * feature is disabled.
   */
  create(
    app: string,
    room: string,
    appId?: number | null,
    inputType: PassthroughTransport = 'rtmp',
    sourceUrl?: string,
  ): PassthroughIngressInfo {
    if (!this.enabled()) {
      throw new ServiceUnavailableException(
        'RTMP/SRT/MPEG-TS passthrough is disabled — set STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on to use it',
      );
    }
    const { ingressId, streamKey } = this.ingressAuth.registerPassthrough({
      app,
      room,
      transport: inputType,
      sourceUrl,
    });
    // Arm immediately (a freshly minted key always passes the auth gate) EXCEPT
    // for an RTMP ingress under the MediaMTX single-port switch: there MediaMTX
    // owns :1935 and drives arming via its `ready` hook ({@link handlePublish}
    // in pull mode), so nothing is bound at create time. SRT + MPEG-TS keep
    // their own ffmpeg process and still arm here (MediaMTX front is RTMP-only).
    // handlePublish re-reads the persisted transport + source from the row, so
    // the MPEG-TS udp:// input is rebuilt identically on boot re-arm.
    const armed = this.pullDriven(inputType)
      ? undefined
      : this.handlePublish(app, streamKey, appId);
    return this.buildInfo(
      { ingressId, app, room, streamKey, sourceUrl },
      armed?.port,
    );
  }

  /**
   * Whether this ingest is armed by MediaMTX (pull mode) rather than a local
   * `-listen` acceptor: the single-port switch is ON and the transport is RTMP
   * (SRT stays on its own listener — MediaMTX front is RTMP-only).
   */
  private pullDriven(transport: PassthroughTransport): boolean {
    return this.config.mediamtxEnable && transport === 'rtmp';
  }

  /**
   * prePublish gate: authorize a publish attempt for `streamKey` and (on accept)
   * arm the remux. Unknown / non-passthrough key → `{ accepted: false }` with NO
   * ffmpeg spawned. This is the unit-tested accept/reject invariant.
   */
  handlePublish(
    app: string,
    streamKey: string,
    appId?: number | null,
  ): HandlePublishResult {
    const row = this.ingressAuth.findByStreamKey(app, streamKey);
    if (!row || !PassthroughService.isPassthroughId(row.ingressId)) {
      this.logger.warn(
        `passthrough publish REJECTED for app "${app}" (unknown/invalid key)`,
      );
      return { accepted: false };
    }
    const room = row.room ?? app;
    // Transport is persisted in the ingress id (pti_srt_… = SRT, pti_mpegts_… =
    // MPEG-TS), so boot re-arm rebuilds the right acceptor/source after a core
    // restart.
    const transport = passthroughTransportOf(row.ingressId);
    const hlsDir = passthroughHlsDir(this.config.dataDir, app, room);

    if (transport === 'mpegts') {
      // MPEG-TS is a PULL source: no client push, no per-ingress listener port.
      // The remux `ffmpeg -f mpegts -i <sourceUrl>` connects OUT to the multicast
      // group / unicast port. The canonical udp:// input is persisted in
      // `source_url`, so boot re-arm rebuilds it byte-for-byte. A row with no
      // source (should never happen — create() always persists one) is rejected.
      if (!row.sourceUrl) {
        this.logger.warn(
          `mpegts publish REJECTED for app "${app}" (ingress ${row.ingressId} has no source_url)`,
        );
        return { accepted: false };
      }
      this.remux.start(row.ingressId, {
        app,
        room,
        streamKey,
        port: 0,
        hlsDir,
        transport: 'mpegts',
        mode: 'pull',
        sourceUrl: row.sourceUrl,
        appId: appId ?? null,
      });
      return { accepted: true, ingressId: row.ingressId };
    }

    if (this.pullDriven(transport)) {
      // Single-port switch: MediaMTX owns :1935 and already accepted the push.
      // We do NOT acquire a per-ingress listener port — ffmpeg PULLS from the
      // front MediaMTX (`rtmp://127.0.0.1:<mediamtxRtmpPort>/<app>/<key>`).
      const port = this.config.mediamtxRtmpPort;
      this.remux.start(row.ingressId, {
        app,
        room,
        streamKey,
        port,
        hlsDir,
        transport,
        mode: 'pull',
        appId: appId ?? null,
      });
      return { accepted: true, ingressId: row.ingressId, port };
    }

    const port = this.acquirePort(row.ingressId);
    this.remux.start(row.ingressId, {
      app,
      room,
      streamKey,
      port,
      hlsDir,
      transport,
      appId: appId ?? null,
    });
    return { accepted: true, ingressId: row.ingressId, port };
  }

  /**
   * Auth-only gate for the MediaMTX `authHTTPAddress` hook: is `streamKey` a
   * known passthrough key for `app`? Unlike {@link handlePublish} this arms
   * NOTHING — MediaMTX has accepted the TCP connection and only asks whether to
   * allow the publish; the remux is armed later by the `ready` hook.
   */
  authorizeKey(app: string, streamKey: string): boolean {
    const row = this.ingressAuth.findByStreamKey(app, streamKey);
    return !!row && PassthroughService.isPassthroughId(row.ingressId);
  }

  /**
   * donePublish: stop the remux for a publish that ended but KEEP the key (the
   * central-server seam). Best-effort. Delete uses {@link remove} instead.
   */
  handleDone(app: string, streamKey: string): void {
    const row = this.ingressAuth.findByStreamKey(app, streamKey);
    if (!row || !PassthroughService.isPassthroughId(row.ingressId)) return;
    this.remux.stop(row.ingressId);
    this.releasePort(row.ingressId);
  }

  /**
   * MediaMTX `ready` for the LiveKit plane (`live/<key>`): under the single-port
   * switch MediaMTX is dumb (no path regexes/forwards), so the CORE owns routing
   * and relays this publish itself — arm a supervised `-c copy` FORWARD child
   * that pulls off the front MediaMTX and pushes FLV to the moved LiveKit ingress
   * (`:livekitIngressRtmpPort`). The forward is HIDDEN from list()/streams-sync
   * (its streams row comes from the LiveKit webhook). No-op unless the switch is
   * on. Idempotent while live (RemuxManager dedupes).
   */
  handleForwardPublish(key: string): void {
    if (!this.config.mediamtxEnable || !key) return;
    this.remux.start(forwardRemuxId(key), {
      kind: 'forward',
      app: RTMP_APP,
      room: key, // logs correlation only — no HLS dir
      streamKey: key,
      forwardKey: key,
      port: this.config.mediamtxRtmpPort, // pull source (MediaMTX)
      destPort: this.config.livekitIngressRtmpPort, // push dest (LiveKit ingress)
      hlsDir: '',
      appId: null,
    });
  }

  /** MediaMTX `notready` for the LiveKit plane: stop the forward child. */
  handleForwardDone(key: string): void {
    if (!key) return;
    this.remux.stop(forwardRemuxId(key));
  }

  /**
   * Tear down a passthrough ingress: stop the remux (+ clean HLS dir), release
   * the port and drop the key. Returns true if `id` was a passthrough ingress.
   */
  remove(app: string, id: string): boolean {
    if (!PassthroughService.isPassthroughId(id)) return false;
    // End the mirrored streams-table row (dashboard) before dropping the key.
    const room = this.ingressAuth
      .listPassthrough(app)
      .find((r) => r.ingressId === id)?.room;
    this.remux.stop(id);
    this.releasePort(id);
    this.ingressAuth.remove(app, id);
    if (room) {
      this.liveRooms.delete(`${app}::${room}`);
      void this.streams()
        ?.end(app, `${room}/passthrough`)
        .catch(() => undefined);
    }
    return true;
  }

  /** One passthrough ingress by id (merged with live status), or null. */
  get(app: string, id: string): PassthroughIngressInfo | null {
    if (!PassthroughService.isPassthroughId(id)) return null;
    const row = this.ingressAuth
      .listPassthrough(app)
      .find((r) => r.ingressId === id);
    if (!row || !row.streamKey) return null;
    return this.buildInfo({
      ingressId: row.ingressId,
      app,
      room: row.room ?? app,
      streamKey: row.streamKey,
      sourceUrl: row.sourceUrl ?? undefined,
    });
  }

  /** All passthrough ingresses of an app, merged with live remux status. */
  list(app: string): PassthroughIngressInfo[] {
    return this.ingressAuth
      .listPassthrough(app)
      .filter((r) => !!r.streamKey)
      .map((r) =>
        this.buildInfo({
          ingressId: r.ingressId,
          app,
          room: r.room ?? app,
          streamKey: r.streamKey!,
          sourceUrl: r.sourceUrl ?? undefined,
        }),
      );
  }

  /**
   * The "what you lose vs the LiveKit path" capabilities block (drives the UI
   * warning). Everything here is OFF because the media never enters LiveKit.
   * SRT ingresses additionally carry `latencyMs` — SRT adds a configurable
   * receive-latency budget (libsrt default ~120 ms) on top of the HLS latency.
   */
  capabilities(inputType: PassthroughTransport = 'rtmp'): PassthroughCapabilities {
    return {
      mode: 'passthrough',
      remux: true,
      webrtc: false,
      subSecondLatency: false,
      adaptiveBitrate: false,
      transcode: false,
      requiresH264Aac: true,
      recording: false,
      roomFeatures: false,
      backupKey: false,
      gpu: false,
      ...(inputType === 'srt'
        ? { latencyMs: PASSTHROUGH_SRT_LATENCY_MS }
        : {}),
      lost: [
        'No WebRTC / sub-second playback — HLS only (~2 segments of latency).',
        'No adaptive bitrate (ABR) — a single passthrough rendition.',
        'No server-side transcode safety net — the source MUST be H.264/AAC.',
        'No egress recording / VOD for this ingress.',
        'No room features (viewer count, chat, reactions, moderation, snapshots, track plugins).',
        'No backup/failover key and no GPU acceleration.',
      ],
    };
  }

  // ---------------------------------------------------------------------------

  private buildInfo(
    row: {
      ingressId: string;
      app: string;
      room: string;
      streamKey: string;
      /** MPEG-TS PULL ingress: the canonical udp:// source it reads from. */
      sourceUrl?: string;
    },
    armedPort?: number,
  ): PassthroughIngressInfo {
    const host = this.config.rtmpPublicHost || DEFAULT_RTMP_HOST;
    // Transport rides in the ingress id (pti_srt_… = SRT, pti_mpegts_… = MPEG-TS).
    const inputType = passthroughTransportOf(row.ingressId);
    // Push port: a live-armed listener's port wins; else under the MediaMTX
    // single-port switch an RTMP ingress advertises the shared :1935 (MediaMTX
    // owns it, no per-ingress port), otherwise the multi-port passthrough base.
    // MPEG-TS is a PULL — no push port at all (the group/port lives in sourceUrl).
    const port =
      armedPort ??
      this.portById.get(row.ingressId) ??
      (this.pullDriven(inputType)
        ? this.config.mediamtxRtmpPort
        : this.config.rtmpPassthroughPort);
    const rtmpUrl =
      inputType === 'rtmp'
        ? (buildPassthroughRtmpUrl(row.streamKey, { host, port, app: row.app }) ?? '')
        : '';
    const srtUrl =
      inputType === 'srt'
        ? buildPassthroughSrtUrl(row.streamKey, { host, port })
        : undefined;
    const base = (this.config.publicBaseUrl || '').replace(/\/+$/, '');
    const hlsPath = `/hls/${encodeURIComponent(row.app)}/${encodeURIComponent(row.room)}/${PASSTHROUGH_HLS_PLAYLIST}`;
    const playerPath = `/play/${encodeURIComponent(row.app)}/${encodeURIComponent(row.room)}`;
    const remuxStatus = this.remux.status(row.ingressId)?.status as
      | RemuxStatus
      | undefined;
    return {
      mode: 'passthrough',
      ingressId: row.ingressId,
      app: row.app,
      room: row.room,
      streamKey: row.streamKey,
      inputType,
      rtmpUrl,
      ...(srtUrl ? { srtUrl } : {}),
      // MPEG-TS PULL: surface the udp:// source it reads from (no push URL).
      ...(inputType === 'mpegts' && row.sourceUrl
        ? { sourceUrl: row.sourceUrl }
        : {}),
      hlsUrl: base ? `${base}${hlsPath}` : hlsPath,
      playerUrl: base ? `${base}${playerPath}` : playerPath,
      status: remuxStatus ?? 'off',
      playlistFresh: this.playlistFresh(row.app, row.room),
      capabilities: this.capabilities(inputType),
    };
  }

  /** Whether the HLS playlist for a room was written within the fresh window. */
  private playlistFresh(app: string, room: string): boolean {
    try {
      const pl = path.join(
        passthroughHlsDir(this.config.dataDir, app, room),
        PASSTHROUGH_HLS_PLAYLIST,
      );
      const st = fs.statSync(pl);
      return Date.now() - st.mtimeMs < PLAYLIST_FRESH_MS;
    } catch {
      return false;
    }
  }

  private acquirePort(id: string): number {
    const existing = this.portById.get(id);
    if (existing !== undefined) return existing;
    let p = this.config.rtmpPassthroughPort;
    while (this.usedPorts.has(p)) p += 1;
    this.usedPorts.add(p);
    this.portById.set(id, p);
    return p;
  }

  private releasePort(id: string): void {
    const p = this.portById.get(id);
    if (p !== undefined) {
      this.usedPorts.delete(p);
      this.portById.delete(id);
    }
  }
}
