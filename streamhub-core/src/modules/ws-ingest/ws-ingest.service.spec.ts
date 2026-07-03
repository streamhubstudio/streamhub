/**
 * Unit specs for WsIngestService — handshake auth, protocol limits and stream
 * lifecycle of the direct WS MJPEG ingest (ESP32-WS-INGEST.md §3), driven
 * entirely with FAKE sockets (no `ws`, no network — repo testing rule).
 *
 * Locked down:
 *  - handshake: valid wsk_ key → `ready` + streams.upsert(type 'ws-mjpeg') +
 *    stream_started; missing/invalid key, unknown app, room mismatch → 4401
 *    with NO registration; feature off / quota exceeded / camera cap → 4403.
 *  - duplicate key → the NEW connection wins (old gets 4409) and the takeover
 *    does NOT end the stream row.
 *  - limits: oversized frame → 4413; fps above the cap → silent drop; non-JPEG
 *    garbage → drop then close after reincidence; idle 30 s → 4408.
 *  - disconnect → streams.end + stream_ended callback + publisher cleared.
 *  - boot cleanup ends stale 'active' ws-mjpeg rows only.
 *  - playback gate: public by default; publicPlayback=false requires a valid
 *    LiveKit subscribe token for the room.
 */
import { AccessToken } from 'livekit-server-sdk';
import { HttpException, HttpStatus } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import { IngressAuthService } from '../livekit/ingress-auth.service';
import type { QuotasService } from '../quotas/quotas.service';
import { FrameHub } from './frame-hub';
import {
  WS_CLOSE,
  WsIngestService,
  type WsLikeSocket,
} from './ws-ingest.service';

const APP = 'live';

// ---------------------------------------------------------------------------
// Fake socket
// ---------------------------------------------------------------------------

class FakeSocket implements WsLikeSocket {
  sent: (string | Buffer)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;
  bufferedAmount = 0;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed || this.terminated) return;
    this.closed = { code, reason };
    this.emit('close');
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('close');
  }
  ping(): void {
    this.pings++;
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  // -- test helpers ----------------------------------------------------------
  /** JSON control messages sent by the server, in order. */
  json(): Record<string, unknown>[] {
    return this.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => JSON.parse(m) as Record<string, unknown>);
  }
  ready(): Record<string, unknown> | undefined {
    return this.json().find((m) => m.type === 'ready');
  }
  frame(buf: Buffer): void {
    this.emit('message', buf, true);
  }
  text(s: string): void {
    this.emit('message', Buffer.from(s), false);
  }
}

/** Flush pending microtasks (async close/finalize chains under fake timers). */
async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** A syntactically valid JPEG-ish frame (FF D8 … FF D9). */
function jpeg(size = 16): Buffer {
  const b = Buffer.alloc(size, 0x20);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}

function appConfig(over: Partial<AppConfig['features']> = {}, roomPrefix = APP): AppConfig {
  return {
    roomPrefix,
    features: {
      rtmpPassword: false,
      viewerCounter: false,
      chat: false,
      reactions: false,
      hiddenQc: false,
      adaptivePlayer: false,
      publicPlayback: true,
      wsIngest: { enabled: true, maxCameras: 0, maxFps: 15, maxFrameKb: 256 },
      ...over,
    },
  } as AppConfig;
}

describe('WsIngestService (direct WS MJPEG ingest)', () => {
  let ctx: UnitContext;
  let svc: WsIngestService;
  let hub: FrameHub;
  let ingressAuth: IngressAuthService;
  let quotas: { enforceConcurrentStreams: jest.Mock };
  let appId: number;

  function seedApp(name = APP): number {
    const res = ctx.db
      .global()
      .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
      .run(name, name);
    return Number(res.lastInsertRowid);
  }

  function mintKey(room = 'live-cam1'): { ingressId: string; streamKey: string } {
    return ingressAuth.registerWsIngest({ app: APP, room });
  }

  async function connect(opts: {
    key?: string;
    app?: string;
    room?: string;
    identity?: string;
    viaHeader?: boolean;
    ip?: string;
  } = {}): Promise<FakeSocket> {
    const sock = new FakeSocket();
    const app = opts.app ?? APP;
    const room = opts.room ?? 'cam1';
    const params = new URLSearchParams({ app, room });
    if (opts.identity) params.set('identity', opts.identity);
    let authorization: string | undefined;
    if (opts.key !== undefined) {
      if (opts.viaHeader) authorization = `Bearer ${opts.key}`;
      else params.set('key', opts.key);
    }
    await svc.handleIngest(sock, {
      url: `/ingest/ws?${params.toString()}`,
      authorization,
      ip: opts.ip ?? '203.0.113.7',
    });
    return sock;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    ctx = makeUnitContext();
    appId = seedApp();
    ingressAuth = new IngressAuthService(ctx.db);
    hub = new FrameHub();
    quotas = { enforceConcurrentStreams: jest.fn(async () => undefined) };
    ctx.mocks.apps.getConfig.mockResolvedValue(appConfig());
    ctx.mocks.streams.upsert.mockResolvedValue({} as never);
    svc = new WsIngestService(
      ctx.config,
      ctx.db,
      ingressAuth,
      hub,
      quotas as unknown as QuotasService,
      ctx.mocks.apps,
      ctx.mocks.streams,
      ctx.mocks.callbacks,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    ctx.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Handshake auth
  // ---------------------------------------------------------------------------

  describe('handshake', () => {
    it('accepts a valid wsk_ key (query) → ready + upsert + stream_started', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });

      const ready = sock.ready();
      expect(ready).toMatchObject({
        type: 'ready',
        room: 'live-cam1',
        maxFps: 15,
        maxFrameBytes: 256 * 1024,
        idleTimeoutSec: 30,
      });
      const identity = `wscam-${streamKey.slice(-6)}`;
      expect(ready!.streamId).toBe(`live-cam1/${identity}`);
      expect(sock.closed).toBeNull();

      expect(ctx.mocks.streams.upsert).toHaveBeenCalledWith(
        APP,
        `live-cam1/${identity}`,
        'ws-mjpeg',
        'live-cam1',
        identity,
      );
      expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
        APP,
        'stream_started',
        expect.objectContaining({ type: 'ws-mjpeg', room: 'live-cam1' }),
      );
      expect(hub.hasPublisher(APP, 'live-cam1')).toBe(true);
      expect(svc.countCameras(APP)).toBe(1);
    });

    it('accepts the key via Authorization: Bearer header (preferred form)', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey, viaHeader: true });
      expect(sock.ready()).toBeDefined();
      expect(sock.closed).toBeNull();
    });

    it('missing key → close 4401 and NO registration', async () => {
      const sock = await connect({});
      expect(sock.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
      expect(ctx.mocks.streams.upsert).not.toHaveBeenCalled();
      expect(ctx.mocks.callbacks.dispatch).not.toHaveBeenCalled();
    });

    it('unknown / non-wsk key → close 4401', async () => {
      expect((await connect({ key: 'wsk_never-minted' })).closed?.code).toBe(
        WS_CLOSE.UNAUTHORIZED,
      );
      expect((await connect({ key: 'sk_wrong-plane' })).closed?.code).toBe(
        WS_CLOSE.UNAUTHORIZED,
      );
      expect(ctx.mocks.streams.upsert).not.toHaveBeenCalled();
    });

    it('unknown app → close 4401', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey, app: 'ghost' });
      expect(sock.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
    });

    it('key bound to another room → close 4401 (room mismatch)', async () => {
      const { streamKey } = mintKey('live-cam1');
      const sock = await connect({ key: streamKey, room: 'cam2' });
      expect(sock.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
    });

    it('app with wsIngest disabled → close 4403', async () => {
      ctx.mocks.apps.getConfig.mockResolvedValue(
        appConfig({
          wsIngest: { enabled: false, maxCameras: 0, maxFps: 15, maxFrameKb: 256 },
        }),
      );
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      expect(sock.closed?.code).toBe(WS_CLOSE.FORBIDDEN);
      expect(ctx.mocks.streams.upsert).not.toHaveBeenCalled();
    });

    it('quota exceeded → close 4403', async () => {
      quotas.enforceConcurrentStreams.mockRejectedValue(
        new HttpException({ error: 'quota_exceeded' }, HttpStatus.TOO_MANY_REQUESTS),
      );
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      expect(sock.closed?.code).toBe(WS_CLOSE.FORBIDDEN);
      expect(ctx.mocks.streams.upsert).not.toHaveBeenCalled();
    });

    it('per-app camera cap (features.ws_ingest.max_cameras) → close 4403', async () => {
      ctx.mocks.apps.getConfig.mockResolvedValue(
        appConfig({
          wsIngest: { enabled: true, maxCameras: 1, maxFps: 15, maxFrameKb: 256 },
        }),
      );
      const first = await connect({ key: mintKey('live-cam1').streamKey });
      expect(first.ready()).toBeDefined();
      const second = await connect({
        key: mintKey('live-cam2').streamKey,
        room: 'cam2',
      });
      expect(second.closed?.code).toBe(WS_CLOSE.FORBIDDEN);
    });

    it('duplicate key → the NEW connection wins, old gets 4409, stream survives', async () => {
      const { streamKey } = mintKey();
      const oldSock = await connect({ key: streamKey });
      expect(oldSock.ready()).toBeDefined();
      ctx.mocks.streams.end.mockClear();

      const newSock = await connect({ key: streamKey });
      expect(oldSock.closed?.code).toBe(WS_CLOSE.REPLACED);
      expect(newSock.ready()).toBeDefined();
      expect(newSock.closed).toBeNull();

      // The takeover must NOT end the (shared) stream row nor drop the hub slot.
      expect(ctx.mocks.streams.end).not.toHaveBeenCalled();
      expect(hub.hasPublisher(APP, 'live-cam1')).toBe(true);
      expect(svc.countCameras(APP)).toBe(1);
    });

    it('rate-limits handshakes per IP → close 4429', async () => {
      const { streamKey } = mintKey();
      let last: FakeSocket | null = null;
      for (let i = 0; i < 61; i++) {
        last = await connect({ key: streamKey, ip: '198.51.100.9' });
      }
      expect(last!.closed?.code).toBe(WS_CLOSE.RATE_LIMITED);
    });
  });

  // ---------------------------------------------------------------------------
  // Frame limits
  // ---------------------------------------------------------------------------

  describe('frames + limits', () => {
    it('publishes valid JPEG frames into the hub (last frame wins)', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      sock.frame(jpeg(32));
      sock.frame(jpeg(64));
      expect(hub.lastFrame(APP, 'live-cam1')?.frame.length).toBe(64);
      expect(hub.info(APP, 'live-cam1')?.frames).toBe(2);
    });

    it('frame > maxFrameBytes → error + close 4413', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      sock.frame(jpeg(256 * 1024 + 1));
      expect(sock.closed?.code).toBe(WS_CLOSE.FRAME_TOO_LARGE);
      expect(
        sock.json().some((m) => m.type === 'error' && m.code === 'frame_too_large'),
      ).toBe(true);
    });

    it('fps above the cap → excess frames dropped IN SILENCE (no close)', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      for (let i = 0; i < 20; i++) sock.frame(jpeg(16));
      // Bucket = 15 tokens (maxFps 15, no time elapsed under fake timers).
      expect(hub.info(APP, 'live-cam1')?.frames).toBe(15);
      expect(sock.closed).toBeNull();

      // A second later the bucket refills and frames flow again.
      jest.advanceTimersByTime(1000);
      sock.frame(jpeg(16));
      expect(hub.info(APP, 'live-cam1')?.frames).toBe(16);
    });

    it('non-JPEG garbage is dropped; reincidence closes the connection', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      for (let i = 0; i < 4; i++) sock.frame(Buffer.from('garbage-data'));
      expect(sock.closed).toBeNull(); // tolerated (dropped)
      sock.frame(Buffer.from('garbage-data'));
      expect(sock.closed?.code).toBe(1003);
      expect(hub.info(APP, 'live-cam1')?.frames ?? 0).toBe(0);
    });

    it('a stats text message lands in streams.last_stats_json', async () => {
      const { streamKey } = mintKey();
      const identity = `wscam-${streamKey.slice(-6)}`;
      const streamId = `live-cam1/${identity}`;
      ctx.db
        .appDb(APP)
        .prepare(
          `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
           VALUES (?, ?, 'ws-mjpeg', 'live-cam1', ?, 'active')`,
        )
        .run(appId, streamId, identity);

      const sock = await connect({ key: streamKey });
      sock.frame(jpeg(16));
      sock.text(JSON.stringify({ type: 'stats', fps: 12, rssi: -61 }));

      const row = ctx.db
        .appDb(APP)
        .prepare('SELECT last_stats_json FROM streams WHERE stream_id = ?')
        .get(streamId) as { last_stats_json: string };
      const stats = JSON.parse(row.last_stats_json) as Record<string, unknown>;
      expect(stats).toMatchObject({ fps: 12, rssi: -61, live: true, framesReceived: 1 });
    });

    it('malformed text messages are ignored without closing', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      sock.text('not-json{{{');
      expect(sock.closed).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Keepalive / lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('idle 30 s without frames → close 4408 + streams.end + stream_ended', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      // Keep pongs flowing so only the idle watchdog can fire.
      const keepAlive = setInterval(() => sock.emit('pong'), 5000);

      await jest.advanceTimersByTimeAsync(36_000);
      clearInterval(keepAlive);
      await flush();

      expect(sock.closed?.code).toBe(WS_CLOSE.IDLE);
      expect(ctx.mocks.streams.end).toHaveBeenCalledWith(
        APP,
        expect.stringContaining('live-cam1/'),
      );
      expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
        APP,
        'stream_ended',
        expect.objectContaining({ type: 'ws-mjpeg' }),
      );
      expect(hub.hasPublisher(APP, 'live-cam1')).toBe(false);
      expect(svc.countCameras(APP)).toBe(0);
    });

    it('frames keep the connection alive past the idle window', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(10_000);
        sock.emit('pong');
        sock.frame(jpeg(16));
      }
      expect(sock.closed).toBeNull();
    });

    it('2 lost pongs → connection terminated (dead camera)', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      // Feed frames so the idle watchdog stays quiet; never answer pings.
      for (let i = 0; i < 9; i++) {
        jest.advanceTimersByTime(5_000);
        sock.frame(jpeg(16));
        if (sock.terminated) break;
      }
      expect(sock.terminated).toBe(true);
    });

    it('camera disconnect → streams.end + stream_ended + publisher cleared', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      sock.close(1000, 'device off');
      // finalize is async — flush microtasks.
      await flush();

      expect(ctx.mocks.streams.end).toHaveBeenCalled();
      expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
        APP,
        'stream_ended',
        expect.objectContaining({ type: 'ws-mjpeg' }),
      );
      expect(hub.hasPublisher(APP, 'live-cam1')).toBe(false);
      expect(svc.countCameras(APP)).toBe(0);
    });

    it('boot cleanup ends stale active ws-mjpeg rows ONLY', () => {
      const adb = ctx.db.appDb(APP);
      adb
        .prepare(
          `INSERT INTO streams (app_id, stream_id, type, room, participant, status)
           VALUES (?, 'live-cam1/wscam-x', 'ws-mjpeg', 'live-cam1', 'wscam-x', 'active'),
                  (?, 'live-r/obs', 'rtmp', 'live-r', 'obs', 'active')`,
        )
        .run(appId, appId);

      svc.onModuleInit();

      const rows = adb
        .prepare('SELECT stream_id, status FROM streams ORDER BY stream_id')
        .all() as { stream_id: string; status: string }[];
      expect(rows).toEqual([
        { stream_id: 'live-cam1/wscam-x', status: 'ended' },
        { stream_id: 'live-r/obs', status: 'active' },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Viewers + playback gate
  // ---------------------------------------------------------------------------

  describe('viewers + playback gate', () => {
    it('WS viewer receives fanned-out frames; saturated buffer → drop', async () => {
      const { streamKey } = mintKey();
      const cam = await connect({ key: streamKey });

      const view = new FakeSocket();
      await svc.handleViewer(view, { url: '/live/ws?app=live&room=cam1' });
      expect(view.closed).toBeNull();

      cam.frame(jpeg(32));
      expect(view.sent.filter((m) => Buffer.isBuffer(m))).toHaveLength(1);

      // Saturate the viewer buffer → the next frame is dropped for it.
      view.bufferedAmount = 600 * 1024;
      jest.advanceTimersByTime(1000); // refill the camera fps bucket
      cam.frame(jpeg(48));
      expect(view.sent.filter((m) => Buffer.isBuffer(m))).toHaveLength(1);

      // Disconnecting the viewer unsubscribes it.
      view.close(1000);
      jest.advanceTimersByTime(1000);
      cam.frame(jpeg(64));
      expect(view.sent.filter((m) => Buffer.isBuffer(m))).toHaveLength(1);
    });

    it('viewer for an unknown app → 4401', async () => {
      const view = new FakeSocket();
      await svc.handleViewer(view, { url: '/live/ws?app=ghost&room=cam1' });
      expect(view.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
    });

    it('publicPlayback=false without token → viewer rejected 4401', async () => {
      ctx.mocks.apps.getConfig.mockResolvedValue(
        appConfig({ publicPlayback: false }),
      );
      const view = new FakeSocket();
      await svc.handleViewer(view, { url: '/live/ws?app=live&room=cam1' });
      expect(view.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
    });

    it('playbackAllowed honors a real LiveKit subscribe token for the room', async () => {
      // Re-pin LiveKit creds so a TokenVerifier can be built (pure JWT, no I/O).
      const ctx2 = makeUnitContext({
        LIVEKIT_API_KEY: 'testkey',
        LIVEKIT_API_SECRET: 'testsecret-testsecret-testsecret',
      });
      try {
        const svc2 = new WsIngestService(
          ctx2.config,
          ctx2.db,
          new IngressAuthService(ctx2.db),
          new FrameHub(),
        );
        const cfg = appConfig({ publicPlayback: false });

        const at = new AccessToken('testkey', 'testsecret-testsecret-testsecret', {
          identity: 'viewer-1',
        });
        at.addGrant({ room: 'live-cam1', roomJoin: true, canSubscribe: true });
        const token = await at.toJwt();

        await expect(svc2.playbackAllowed(cfg, 'live-cam1', token)).resolves.toBe(true);
        // Token for ANOTHER room must not open this one.
        await expect(svc2.playbackAllowed(cfg, 'live-cam2', token)).resolves.toBe(false);
        await expect(svc2.playbackAllowed(cfg, 'live-cam1', 'garbage')).resolves.toBe(false);
        await expect(svc2.playbackAllowed(cfg, 'live-cam1', undefined)).resolves.toBe(false);
      } finally {
        ctx2.cleanup();
        // makeTestConfig writes overrides into process.env — restore the harness
        // default (empty LiveKit creds) so later contexts stay verifier-less.
        process.env.LIVEKIT_API_KEY = '';
        process.env.LIVEKIT_API_SECRET = '';
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Provisioning / status backing
  // ---------------------------------------------------------------------------

  describe('provisioning + liveInfo', () => {
    it('provision mints a wsk_ key with namespaced room + URLs', async () => {
      const out = await svc.provision(APP, 'cam9');
      expect(out.id).toMatch(/^wsi_/);
      expect(out.streamKey).toMatch(/^wsk_/);
      expect(out.room).toBe('live-cam9');
      expect(out.wsUrl).toContain('/ingest/ws?app=live&room=cam9');
      expect(out.mjpegUrl).toContain('/live/live/live-cam9/mjpeg');
      expect(out.playerUrl).toContain('/play/live/live-cam9');
      // The minted key authenticates a camera end-to-end.
      const sock = await connect({ key: out.streamKey, room: 'cam9' });
      expect(sock.ready()).toBeDefined();
    });

    it('listKeys reports live state; revoke closes the active camera', async () => {
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      let rows = svc.listKeys(APP);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ active: true, room: 'live-cam1' });

      svc.revoke(APP, rows[0].id);
      expect(sock.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
      rows = svc.listKeys(APP);
      expect(rows).toHaveLength(0);
      // Revoked key no longer authenticates.
      const again = await connect({ key: streamKey });
      expect(again.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED);
    });

    it('liveInfo flips active with the camera lifecycle', async () => {
      await expect(svc.liveInfo(APP, 'cam1')).resolves.toMatchObject({
        active: false,
        type: null,
      });
      const { streamKey } = mintKey();
      const sock = await connect({ key: streamKey });
      await expect(svc.liveInfo(APP, 'cam1')).resolves.toMatchObject({
        active: true,
        type: 'ws-mjpeg',
        room: 'live-cam1',
        mjpegUrl: expect.stringContaining('/live/live/live-cam1/mjpeg'),
      });
      sock.close(1000);
      await flush();
      await expect(svc.liveInfo(APP, 'cam1')).resolves.toMatchObject({
        active: false,
      });
    });

    it('liveInfo 404s when publicPlayback is off (mirrors /play-token)', async () => {
      ctx.mocks.apps.getConfig.mockResolvedValue(
        appConfig({ publicPlayback: false }),
      );
      const { NotFoundException } = await import('@nestjs/common');
      await expect(svc.liveInfo(APP, 'cam1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
