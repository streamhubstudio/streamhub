/**
 * Unit spec — PassthroughService (RTMP→HLS passthrough orchestration + the
 * prePublish AUTH GATE). Driven directly with a real (temp) DB for the key store
 * and a FAKE RemuxManager, so no ffmpeg / no port is ever touched (mirrors how
 * ws-ingest.service.spec drives a fake socket). Locks down:
 *  - prePublish: a valid `ptk_` key ACCEPTS + arms the remux; an unknown or
 *    non-passthrough key is REJECTED with NO spawn;
 *  - create() mints a key, arms, and returns the :1937 rtmp_url + /hls/… url +
 *    the capabilities-lost block; disabled → 503;
 *  - remove() stops the remux and drops the key;
 *  - concurrent ingresses get distinct ports from the base;
 *  - SRT: create(…,'srt') mints a pti_srt_ id, arms an SRT acceptor
 *    (transport 'srt') and returns the srt://…?streamid=<key> push URL +
 *    hls url + capabilities.latencyMs; re-arm derives the transport from the
 *    persisted id; the RTMP surface stays byte-for-byte unchanged.
 */
import { ServiceUnavailableException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import * as fs from 'fs';
import * as path from 'path';

import { IngressAuthService } from '../livekit/ingress-auth.service';
import { PassthroughService } from './passthrough.service';
import type { RemuxManager } from './remux.manager';
import {
  PASSTHROUGH_HLS_PLAYLIST,
  passthroughHlsDir,
} from './remux-args.util';

const APP = 'live';

function fakeRemux() {
  return {
    start: jest.fn(() => ({ status: 'live' })),
    stop: jest.fn(() => ({ status: 'off' })),
    status: jest.fn(() => ({ status: 'live' })),
    isActive: jest.fn(() => true),
    logs: jest.fn(() => []),
    list: jest.fn(() => [] as Array<{ app: string; room: string; ingressId: string; desired: 'live' | 'stopped' }>),
  };
}

/** Fake StreamsService + the ModuleRef that lazily resolves it. */
function fakeStreamsRef() {
  const streams = {
    upsert: jest.fn(async () => ({}) as never),
    end: jest.fn(async () => undefined),
  };
  const moduleRef = { get: jest.fn(() => streams) };
  return { streams, moduleRef };
}

describe('PassthroughService', () => {
  let ctx: UnitContext;
  let svc: PassthroughService;
  let ingressAuth: IngressAuthService;
  let remux: ReturnType<typeof fakeRemux>;
  let streamsRef: ReturnType<typeof fakeStreamsRef>;

  function seedApp(name = APP): void {
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
      .run(name, name);
  }

  beforeEach(() => {
    // makeUnitContext writes overrides into process.env and never unsets them
    // (ConfigService snapshots env at construction). Clear the MediaMTX switch
    // so the non-MediaMTX default context is deterministic even after a
    // MediaMTX-mode test in this file flipped it on.
    delete process.env.STREAMHUB_MEDIAMTX_ENABLE;
    delete process.env.STREAMHUB_MEDIAMTX_RTMP_PORT;
    delete process.env.STREAMHUB_MEDIAMTX_HOOK_SECRET;
    ctx = makeUnitContext({
      STREAMHUB_RTMP_PASSTHROUGH_ENABLE: 'on',
      RTMP_PUBLIC_HOST: 'media.test',
      STREAMHUB_RTMP_PASSTHROUGH_PORT: '1937',
    });
    seedApp();
    ingressAuth = new IngressAuthService(ctx.db);
    remux = fakeRemux();
    streamsRef = fakeStreamsRef();
    svc = new PassthroughService(
      ctx.config,
      ingressAuth,
      remux as unknown as RemuxManager,
      streamsRef.moduleRef as never,
    );
  });

  afterEach(() => {
    ctx.cleanup();
    // Contain the MediaMTX env flip so it can't leak into another spec file that
    // shares this jest worker (process.env is per-worker, reset per-file only here).
    delete process.env.STREAMHUB_MEDIAMTX_ENABLE;
    delete process.env.STREAMHUB_MEDIAMTX_RTMP_PORT;
    delete process.env.STREAMHUB_MEDIAMTX_HOOK_SECRET;
  });

  // ---------------------------------------------------------------------------
  // prePublish auth gate
  // ---------------------------------------------------------------------------

  describe('handlePublish (prePublish auth)', () => {
    it('ACCEPTS a valid ptk_ key and arms the remux with the right spec', () => {
      const { ingressId, streamKey } = ingressAuth.registerPassthrough({
        app: APP,
        room: 'live-ch1',
      });

      const res = svc.handlePublish(APP, streamKey);

      expect(res).toEqual({ accepted: true, ingressId, port: 1937 });
      expect(remux.start).toHaveBeenCalledTimes(1);
      expect(remux.start).toHaveBeenCalledWith(
        ingressId,
        expect.objectContaining({
          app: APP,
          room: 'live-ch1',
          streamKey,
          port: 1937,
          hlsDir: expect.stringContaining('/apps/live/hls/live-ch1'),
        }),
      );
    });

    it('REJECTS an unknown key → NO spawn', () => {
      const res = svc.handlePublish(APP, 'ptk_never-minted');
      expect(res).toEqual({ accepted: false });
      expect(remux.start).not.toHaveBeenCalled();
    });

    it('REJECTS a non-passthrough key (e.g. a wsk_ ws-ingest key) → NO spawn', () => {
      const { streamKey } = ingressAuth.registerWsIngest({
        app: APP,
        room: 'live-cam1',
      });
      const res = svc.handlePublish(APP, streamKey);
      expect(res.accepted).toBe(false);
      expect(remux.start).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // create / remove / list
  // ---------------------------------------------------------------------------

  describe('create', () => {
    it('mints + arms and returns the :1937 rtmp_url, /hls url and capabilities', () => {
      const info = svc.create(APP, 'live-ch1');

      expect(info.mode).toBe('passthrough');
      expect(info.ingressId).toMatch(/^pti_/);
      expect(info.streamKey).toMatch(/^ptk_/);
      expect(info.rtmpUrl).toBe(
        `rtmp://media.test:1937/live/${info.streamKey}`,
      );
      expect(info.hlsUrl).toBe('/hls/live/live-ch1/index.m3u8');
      expect(info.playerUrl).toBe('/play/live/live-ch1');
      expect(info.capabilities).toMatchObject({
        mode: 'passthrough',
        remux: true,
        webrtc: false,
        adaptiveBitrate: false,
        transcode: false,
        recording: false,
      });
      expect(info.capabilities.lost.length).toBeGreaterThan(0);
      expect(remux.start).toHaveBeenCalledTimes(1);

      // the minted key is persisted and now authenticates a push
      expect(ingressAuth.findByStreamKey(APP, info.streamKey)?.ingressId).toBe(
        info.ingressId,
      );
    });

    it('throws 503 when the feature is disabled', () => {
      const off = makeUnitContext({
        STREAMHUB_RTMP_PASSTHROUGH_ENABLE: 'off',
      });
      try {
        const svc2 = new PassthroughService(
          off.config,
          new IngressAuthService(off.db),
          remux as unknown as RemuxManager,
          fakeStreamsRef().moduleRef as never,
        );
        expect(() => svc2.create(APP, 'live-ch1')).toThrow(
          ServiceUnavailableException,
        );
        expect(remux.start).not.toHaveBeenCalled();
      } finally {
        off.cleanup();
      }
    });

    it('gives concurrent ingresses distinct ports from the base', () => {
      const a = svc.create(APP, 'live-a');
      const b = svc.create(APP, 'live-b');
      const portA = (remux.start.mock.calls[0][1] as { port: number }).port;
      const portB = (remux.start.mock.calls[1][1] as { port: number }).port;
      expect(portA).toBe(1937);
      expect(portB).toBe(1938);
      expect(a.ingressId).not.toBe(b.ingressId);
    });
  });

  describe('remove', () => {
    it('stops the remux and drops the key', () => {
      const info = svc.create(APP, 'live-ch1');
      expect(svc.list(APP)).toHaveLength(1);

      const wasPassthrough = svc.remove(APP, info.ingressId);

      expect(wasPassthrough).toBe(true);
      expect(remux.stop).toHaveBeenCalledWith(info.ingressId);
      expect(svc.list(APP)).toHaveLength(0);
      expect(ingressAuth.findByStreamKey(APP, info.streamKey)).toBeNull();
    });

    it('ignores a non-passthrough id (returns false, no stop)', () => {
      expect(svc.remove(APP, 'IN_livekit')).toBe(false);
      expect(remux.stop).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // SRT passthrough (srt://…?mode=listener acceptor — same plane, same gate)
  // ---------------------------------------------------------------------------

  describe('create (inputType srt)', () => {
    it('mints + arms an SRT acceptor and returns the srt:// push URL + hls url', () => {
      const info = svc.create(APP, 'live-ch1', undefined, 'srt');

      expect(info.mode).toBe('passthrough');
      expect(info.ingressId).toMatch(/^pti_srt_/);
      expect(info.streamKey).toMatch(/^ptk_/);
      expect(info.inputType).toBe('srt');
      expect(info.srtUrl).toBe(
        `srt://media.test:1937?streamid=${info.streamKey}`,
      );
      expect(info.rtmpUrl).toBe(''); // no RTMP push surface for an SRT ingress
      expect(info.hlsUrl).toBe('/hls/live/live-ch1/index.m3u8');
      expect(info.playerUrl).toBe('/play/live/live-ch1');
      // capabilities: same lost-block, PLUS the SRT latency note (~120 ms).
      expect(info.capabilities).toMatchObject({
        mode: 'passthrough',
        remux: true,
        webrtc: false,
        transcode: false,
        latencyMs: 120,
      });

      expect(remux.start).toHaveBeenCalledTimes(1);
      expect(remux.start).toHaveBeenCalledWith(
        info.ingressId,
        expect.objectContaining({
          app: APP,
          room: 'live-ch1',
          streamKey: info.streamKey,
          port: 1937,
          transport: 'srt',
          hlsDir: expect.stringContaining('/apps/live/hls/live-ch1'),
        }),
      );
    });

    it('re-arm (handlePublish) derives the SRT transport from the persisted id', () => {
      const { ingressId, streamKey } = ingressAuth.registerPassthrough({
        app: APP,
        room: 'live-ch1',
        transport: 'srt',
      });

      const res = svc.handlePublish(APP, streamKey);

      expect(res).toEqual({ accepted: true, ingressId, port: 1937 });
      expect(remux.start).toHaveBeenCalledWith(
        ingressId,
        expect.objectContaining({ transport: 'srt' }),
      );
    });

    it('shares the port pool and gate with RTMP (mixed transports, distinct ports)', () => {
      const a = svc.create(APP, 'live-a'); // rtmp
      const b = svc.create(APP, 'live-b', undefined, 'srt');
      const specA = remux.start.mock.calls[0][1] as { port: number; transport?: string };
      const specB = remux.start.mock.calls[1][1] as { port: number; transport?: string };
      expect(specA.port).toBe(1937);
      expect(specB.port).toBe(1938);
      expect(specA.transport).toBe('rtmp');
      expect(specB.transport).toBe('srt');
      expect(a.ingressId).not.toBe(b.ingressId);
    });

    it('an RTMP create keeps the pre-SRT surface (no srtUrl, no latencyMs, rtmp transport)', () => {
      const info = svc.create(APP, 'live-ch1');
      expect(info.inputType).toBe('rtmp');
      expect(info.srtUrl).toBeUndefined();
      expect(info.capabilities.latencyMs).toBeUndefined();
      expect(remux.start).toHaveBeenCalledWith(
        info.ingressId,
        expect.objectContaining({ transport: 'rtmp' }),
      );
    });

    it('remove() tears an SRT ingress down like any passthrough ingress', () => {
      const info = svc.create(APP, 'live-ch1', undefined, 'srt');
      expect(svc.remove(APP, info.ingressId)).toBe(true);
      expect(remux.stop).toHaveBeenCalledWith(info.ingressId);
      expect(ingressAuth.findByStreamKey(APP, info.streamKey)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // MPEG-TS over UDP (unicast + multicast) — a PULL source: no listener/port,
  // the udp:// input is persisted in source_url and armed immediately.
  // ---------------------------------------------------------------------------

  describe('create (inputType mpegts)', () => {
    const SRC = 'udp://@239.1.1.1:5000?overrun_nonfatal=1';

    it('mints a pti_mpegts_ ingress, arms a PULL remux with the source, surfaces sourceUrl (no push URL/port)', () => {
      const info = svc.create(APP, 'live-ch1', undefined, 'mpegts', SRC);

      expect(info.mode).toBe('passthrough');
      expect(info.ingressId).toMatch(/^pti_mpegts_/);
      expect(info.streamKey).toMatch(/^ptk_/);
      expect(info.inputType).toBe('mpegts');
      expect(info.sourceUrl).toBe(SRC);
      expect(info.rtmpUrl).toBe(''); // no push surface at all — it PULLS
      expect(info.srtUrl).toBeUndefined();
      expect(info.hlsUrl).toBe('/hls/live/live-ch1/index.m3u8');
      expect(info.capabilities).toMatchObject({
        mode: 'passthrough',
        remux: true,
        webrtc: false,
        transcode: false,
      });
      expect(info.capabilities.latencyMs).toBeUndefined(); // latency note is SRT-only

      expect(remux.start).toHaveBeenCalledTimes(1);
      expect(remux.start).toHaveBeenCalledWith(
        info.ingressId,
        expect.objectContaining({
          app: APP,
          room: 'live-ch1',
          transport: 'mpegts',
          mode: 'pull',
          sourceUrl: SRC,
          port: 0,
          hlsDir: expect.stringContaining('/apps/live/hls/live-ch1'),
        }),
      );
    });

    it('persists source_url so re-arm (handlePublish) rebuilds the exact udp:// input', () => {
      const { ingressId, streamKey } = ingressAuth.registerPassthrough({
        app: APP,
        room: 'live-ch1',
        transport: 'mpegts',
        sourceUrl: SRC,
      });

      const res = svc.handlePublish(APP, streamKey);

      expect(res).toEqual({ accepted: true, ingressId });
      expect(remux.start).toHaveBeenCalledWith(
        ingressId,
        expect.objectContaining({ transport: 'mpegts', mode: 'pull', sourceUrl: SRC }),
      );
    });

    it('REJECTS an mpegts key with no persisted source (defensive) → NO spawn', () => {
      const { streamKey } = ingressAuth.registerPassthrough({
        app: APP,
        room: 'live-ch1',
        transport: 'mpegts',
        // no sourceUrl
      });
      const res = svc.handlePublish(APP, streamKey);
      expect(res).toEqual({ accepted: false });
      expect(remux.start).not.toHaveBeenCalled();
    });

    it('does NOT consume a listener port (PULL) — a later RTMP ingress still gets the base port', () => {
      svc.create(APP, 'live-mc', undefined, 'mpegts', SRC);
      const rtmp = svc.create(APP, 'live-rtmp'); // rtmp listener
      const mpegtsSpec = remux.start.mock.calls[0][1] as { port: number };
      const rtmpSpec = remux.start.mock.calls[1][1] as { port: number };
      expect(mpegtsSpec.port).toBe(0);
      expect(rtmpSpec.port).toBe(1937); // base port, not bumped by the mpegts ingress
      expect(rtmp.inputType).toBe('rtmp');
    });

    it('list() surfaces the mpegts row with its sourceUrl', () => {
      const info = svc.create(APP, 'live-ch1', undefined, 'mpegts', SRC);
      const rows = svc.list(APP);
      const row = rows.find((r) => r.ingressId === info.ingressId);
      expect(row?.inputType).toBe('mpegts');
      expect(row?.sourceUrl).toBe(SRC);
      expect(row?.rtmpUrl).toBe('');
    });

    it('remove() tears an mpegts ingress down like any passthrough ingress', () => {
      const info = svc.create(APP, 'live-ch1', undefined, 'mpegts', SRC);
      expect(svc.remove(APP, info.ingressId)).toBe(true);
      expect(remux.stop).toHaveBeenCalledWith(info.ingressId);
      expect(ingressAuth.findByStreamKey(APP, info.streamKey)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // MediaMTX single-port switch (STREAMHUB_MEDIAMTX_ENABLE) — RTMP arming is
  // driven by the MediaMTX ready hook in PULL mode; NO per-ingress listener port.
  // ---------------------------------------------------------------------------

  describe('MediaMTX single-port switch (mediamtxEnable)', () => {
    let mtx: UnitContext;
    let mtxSvc: PassthroughService;
    let mtxAuth: IngressAuthService;
    let mtxRemux: ReturnType<typeof fakeRemux>;

    beforeEach(() => {
      mtx = makeUnitContext({
        STREAMHUB_RTMP_PASSTHROUGH_ENABLE: 'on',
        RTMP_PUBLIC_HOST: 'media.test',
        STREAMHUB_RTMP_PASSTHROUGH_PORT: '1937',
        STREAMHUB_MEDIAMTX_ENABLE: 'on',
        STREAMHUB_MEDIAMTX_RTMP_PORT: '1935',
        STREAMHUB_MEDIAMTX_HOOK_SECRET: 's3cret',
      });
      mtx.db
        .global()
        .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
        .run(APP, APP);
      mtxAuth = new IngressAuthService(mtx.db);
      mtxRemux = fakeRemux();
      mtxSvc = new PassthroughService(
        mtx.config,
        mtxAuth,
        mtxRemux as unknown as RemuxManager,
        fakeStreamsRef().moduleRef as never,
      );
    });

    afterEach(() => mtx.cleanup());

    it('create() mints the key + returns the :1935 rtmp_url but does NOT arm at create', () => {
      const info = mtxSvc.create(APP, 'live-ch1');

      expect(info.ingressId).toMatch(/^pti_/);
      expect(info.streamKey).toMatch(/^ptk_/);
      // Push URL advertises the shared MediaMTX port, not the 1937 base.
      expect(info.rtmpUrl).toBe(`rtmp://media.test:1935/live/${info.streamKey}`);
      // MediaMTX drives arming via its ready hook — nothing bound at create time.
      expect(mtxRemux.start).not.toHaveBeenCalled();
      // The key is persisted and authenticates a later publish.
      expect(mtxAuth.findByStreamKey(APP, info.streamKey)?.ingressId).toBe(
        info.ingressId,
      );
    });

    it('handlePublish (ready hook) arms PULL mode on :1935 without acquiring a port', () => {
      const a = mtxAuth.registerPassthrough({ app: APP, room: 'ch-a' });
      const b = mtxAuth.registerPassthrough({ app: APP, room: 'ch-b' });

      const resA = mtxSvc.handlePublish(APP, a.streamKey);
      const resB = mtxSvc.handlePublish(APP, b.streamKey);

      // Both use the shared :1935 (a listener pool would hand out 1937 then 1938).
      expect(resA).toEqual({ accepted: true, ingressId: a.ingressId, port: 1935 });
      expect(resB).toEqual({ accepted: true, ingressId: b.ingressId, port: 1935 });
      expect(mtxRemux.start).toHaveBeenNthCalledWith(
        1,
        a.ingressId,
        expect.objectContaining({ mode: 'pull', port: 1935, transport: 'rtmp' }),
      );
      expect(mtxRemux.start).toHaveBeenNthCalledWith(
        2,
        b.ingressId,
        expect.objectContaining({ mode: 'pull', port: 1935 }),
      );
    });

    it('still REJECTS an unknown/non-passthrough key (auth gate unchanged)', () => {
      expect(mtxSvc.handlePublish(APP, 'ptk_never').accepted).toBe(false);
      const { streamKey } = mtxAuth.registerWsIngest({ app: APP, room: 'x' });
      expect(mtxSvc.handlePublish(APP, streamKey).accepted).toBe(false);
      expect(mtxRemux.start).not.toHaveBeenCalled();
    });

    it('authorizeKey() validates a key WITHOUT arming (the auth hook path)', () => {
      const { streamKey } = mtxAuth.registerPassthrough({ app: APP, room: 'ch1' });
      expect(mtxSvc.authorizeKey(APP, streamKey)).toBe(true);
      expect(mtxSvc.authorizeKey(APP, 'ptk_bogus')).toBe(false);
      const ws = mtxAuth.registerWsIngest({ app: APP, room: 'y' });
      expect(mtxSvc.authorizeKey(APP, ws.streamKey)).toBe(false);
      expect(mtxRemux.start).not.toHaveBeenCalled();
    });

    it('SRT is unaffected: still arms its own listener + acquires a port', () => {
      const info = mtxSvc.create(APP, 'live-srt', undefined, 'srt');
      expect(info.inputType).toBe('srt');
      // SRT keeps the multi-port listener (MediaMTX front is RTMP-only).
      expect(info.srtUrl).toBe(`srt://media.test:1937?streamid=${info.streamKey}`);
      expect(mtxRemux.start).toHaveBeenCalledWith(
        info.ingressId,
        expect.objectContaining({ transport: 'srt', port: 1937 }),
      );
      // listen mode (no pull) for SRT.
      const spec = mtxRemux.start.mock.calls[0][1] as { mode?: string };
      expect(spec.mode).toBeUndefined();
    });

    // LiveKit-plane forward — the core owns routing (MediaMTX is dumb).
    it('handleForwardPublish arms a hidden `fwd_` child pull:1935 → push:11935', () => {
      mtxSvc.handleForwardPublish('sk_livekit');
      expect(mtxRemux.start).toHaveBeenCalledWith(
        'fwd_sk_livekit',
        expect.objectContaining({
          kind: 'forward',
          app: 'live',
          forwardKey: 'sk_livekit',
          port: 1935, // MediaMTX pull source
          destPort: 11935, // moved LiveKit ingress (default)
        }),
      );
      // The forward must NOT create a passthrough ingress or a list() row.
      expect(mtxAuth.findByStreamKey(APP, 'sk_livekit')).toBeNull();
      expect(mtxSvc.list(APP)).toHaveLength(0);
    });

    it('handleForwardDone stops the `fwd_` child', () => {
      mtxSvc.handleForwardDone('sk_livekit');
      expect(mtxRemux.stop).toHaveBeenCalledWith('fwd_sk_livekit');
    });
  });

  it('handleForwardPublish is a no-op when the single-port switch is OFF', () => {
    // Outer ctx has mediamtxEnable=false → a stray LiveKit hook must arm nothing.
    svc.handleForwardPublish('sk_livekit');
    expect(remux.start).not.toHaveBeenCalled();
  });

  it('URL builder: passthrough push port is :1935 under MediaMTX, :1937 without', () => {
    // Without MediaMTX (the default ctx from the outer beforeEach): :1937.
    const plain = svc.create(APP, 'live-plain');
    expect(plain.rtmpUrl).toBe(`rtmp://media.test:1937/live/${plain.streamKey}`);

    // With MediaMTX enabled: :1935.
    const mtx = makeUnitContext({
      STREAMHUB_RTMP_PASSTHROUGH_ENABLE: 'on',
      RTMP_PUBLIC_HOST: 'media.test',
      STREAMHUB_MEDIAMTX_ENABLE: 'on',
    });
    try {
      mtx.db
        .global()
        .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
        .run(APP, APP);
      const mtxSvc = new PassthroughService(
        mtx.config,
        new IngressAuthService(mtx.db),
        fakeRemux() as unknown as RemuxManager,
        fakeStreamsRef().moduleRef as never,
      );
      const info = mtxSvc.create(APP, 'live-mtx');
      expect(info.rtmpUrl).toBe(`rtmp://media.test:1935/live/${info.streamKey}`);
    } finally {
      mtx.cleanup();
    }
  });

  describe('list', () => {
    it('reports each passthrough ingress with its live status + urls', () => {
      const info = svc.create(APP, 'live-ch1');
      const rows = svc.list(APP);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        mode: 'passthrough',
        ingressId: info.ingressId,
        room: 'live-ch1',
        status: 'live',
        rtmpUrl: `rtmp://media.test:1937/live/${info.streamKey}`,
        hlsUrl: '/hls/live/live-ch1/index.m3u8',
      });
    });
  });

  it('isPassthroughId identifies the plane (rtmp AND srt ids)', () => {
    expect(PassthroughService.isPassthroughId('pti_abc')).toBe(true);
    expect(PassthroughService.isPassthroughId('pti_srt_abc')).toBe(true);
    expect(PassthroughService.isPassthroughId('IN_livekit')).toBe(false);
    expect(PassthroughService.isPassthroughId('wsi_x')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // streams-table sync — dashboard visibility (passthrough bypasses LiveKit,
  // so no webhook ever creates the `streams` row; this sync mirrors it)
  // ---------------------------------------------------------------------------

  describe('syncStreamRows (dashboard Streams visibility)', () => {
    const ROOM = 'live-ch1';

    function armed(desired: 'live' | 'stopped' = 'live') {
      remux.list.mockReturnValue([
        { app: APP, room: ROOM, ingressId: 'pti_x', desired },
      ]);
    }

    /** Write a REAL playlist into the test dataDir; `ageMs` backdates its mtime. */
    function writePlaylist(ageMs = 0): void {
      const dir = passthroughHlsDir(ctx.config.dataDir, APP, ROOM);
      fs.mkdirSync(dir, { recursive: true });
      const pl = path.join(dir, PASSTHROUGH_HLS_PLAYLIST);
      fs.writeFileSync(pl, '#EXTM3U\n');
      if (ageMs > 0) {
        const t = new Date(Date.now() - ageMs);
        fs.utimesSync(pl, t, t);
      }
    }

    it('upserts an ACTIVE <room>/passthrough row when the playlist is FRESH', async () => {
      armed();
      writePlaylist();
      await svc.syncStreamRows();
      expect(streamsRef.streams.upsert).toHaveBeenCalledWith(
        APP,
        `${ROOM}/passthrough`,
        'rtmp',
        ROOM,
        'passthrough',
      );
      // Self-healing: EVERY live tick re-upserts (idempotent at the SQL layer),
      // so the row recovers even if something else ended it between ticks.
      await svc.syncStreamRows();
      expect(streamsRef.streams.upsert).toHaveBeenCalledTimes(2);
    });

    it('ENDS the row when the playlist goes stale (publisher gone)', async () => {
      armed();
      writePlaylist();
      await svc.syncStreamRows(); // goes live
      writePlaylist(120_000); // backdate: stale
      await svc.syncStreamRows(); // stale → ended
      expect(streamsRef.streams.end).toHaveBeenCalledWith(
        APP,
        `${ROOM}/passthrough`,
      );
    });

    it('never upserts for a stopped acceptor and never throws on streams errors', async () => {
      armed('stopped');
      writePlaylist();
      await svc.syncStreamRows();
      expect(streamsRef.streams.upsert).not.toHaveBeenCalled();
      // errors are swallowed (media plane must never depend on the dashboard)
      armed('live');
      streamsRef.streams.upsert.mockRejectedValueOnce(new Error('db locked'));
      await expect(svc.syncStreamRows()).resolves.toBeUndefined();
    });

    it('remove() ends the mirrored row for that room', async () => {
      const { ingressId } = ingressAuth.registerPassthrough({
        app: APP,
        room: ROOM,
      });
      svc.remove(APP, ingressId);
      expect(streamsRef.streams.end).toHaveBeenCalledWith(
        APP,
        `${ROOM}/passthrough`,
      );
    });
  });
});
