/**
 * Unit specs for LiveHttpService — the transcode-less MJPEG playback endpoints
 * (ESP32-WS-INGEST.md §4a): GET /live/<app>/<room>/mjpeg (multipart) and
 * /frame.jpg (last frame). Exercised through hand-rolled req/res fakes — no
 * HTTP server, no sockets (repo testing rule).
 *
 * Locked down:
 *  - mjpeg answers `multipart/x-mixed-replace; boundary=frame`, pushes the
 *    last known frame immediately and streams subsequent frames;
 *  - per-viewer backpressure: while write() returns false frames are skipped
 *    until 'drain' (never queued);
 *  - frame.jpg serves the last JPEG with image/jpeg + no-store (404 when the
 *    room has no frame);
 *  - playback gate: publicPlayback=false without a token → 401;
 *  - unknown app / path → terminal 404 (no SPA fallthrough).
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';
import { IngressAuthService } from '../livekit/ingress-auth.service';
import { FrameHub } from './frame-hub';
import { LiveHttpService, type HttpReqLike, type HttpResLike } from './live-http';
import { WsIngestService } from './ws-ingest.service';

const APP = 'live';

class FakeRes implements HttpResLike {
  status?: number;
  headers: Record<string, string | number> = {};
  chunks: Buffer[] = [];
  ended = false;
  writableEnded = false;
  /** Next write() return value (false = saturated). */
  writeOk = true;
  private listeners = new Map<string, (() => void)[]>();
  private onceListeners = new Map<string, (() => void)[]>();

  writeHead(status: number, headers?: Record<string, string | number>): void {
    this.status = status;
    this.headers = headers ?? {};
  }
  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return this.writeOk;
  }
  end(chunk?: Buffer | string): void {
    if (chunk) this.write(chunk);
    this.ended = true;
    this.writableEnded = true;
  }
  once(event: string, listener: () => void): void {
    const arr = this.onceListeners.get(event) ?? [];
    arr.push(listener);
    this.onceListeners.set(event, arr);
  }
  on(event: string, listener: () => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  emit(event: string): void {
    for (const l of this.listeners.get(event) ?? []) l();
    const once = this.onceListeners.get(event) ?? [];
    this.onceListeners.set(event, []);
    for (const l of once) l();
  }
  body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

class FakeReq implements HttpReqLike {
  method = 'GET';
  private listeners = new Map<string, (() => void)[]>();
  constructor(public url: string) {}
  on(event: string, listener: () => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  emit(event: string): void {
    for (const l of this.listeners.get(event) ?? []) l();
  }
}

function jpegFrame(tag: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag)]);
}

function appConfig(publicPlayback = true): AppConfig {
  return {
    roomPrefix: APP,
    features: { publicPlayback },
  } as AppConfig;
}

describe('LiveHttpService (/live MJPEG playback)', () => {
  let ctx: UnitContext;
  let hub: FrameHub;
  let http: LiveHttpService;

  beforeEach(() => {
    ctx = makeUnitContext();
    ctx.db
      .global()
      .prepare('INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)')
      .run(APP, APP);
    ctx.mocks.apps.getConfig.mockResolvedValue(appConfig());
    hub = new FrameHub();
    const svc = new WsIngestService(
      ctx.config,
      ctx.db,
      new IngressAuthService(ctx.db),
      hub,
      undefined,
      ctx.mocks.apps,
    );
    http = new LiveHttpService(svc, hub);
  });

  afterEach(() => ctx.cleanup());

  // NOTE: req.url below is RELATIVE to the /live mount — `/<app>/<room>/…` —
  // and the app under test is literally named 'live' (hence '/live/cam1/…').
  describe('frame.jpg', () => {
    it('serves /<app>/<room>/frame.jpg (short room gets namespaced)', async () => {
      hub.publish(APP, 'live-cam1', jpegFrame('hello'));
      const res = new FakeRes();
      await http.handle(new FakeReq('/live/cam1/frame.jpg'), res);
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/jpeg');
      expect(String(res.headers['Cache-Control'])).toContain('no-store');
      expect(res.body()).toContain('hello');
      expect(res.ended).toBe(true);
    });

    it('accepts the already-namespaced room too', async () => {
      hub.publish(APP, 'live-cam1', jpegFrame('x'));
      const res = new FakeRes();
      await http.handle(new FakeReq('/live/live-cam1/frame.jpg'), res);
      expect(res.status).toBe(200);
    });

    it('404s when the room has no frame yet', async () => {
      const res = new FakeRes();
      await http.handle(new FakeReq('/live/cam1/frame.jpg'), res);
      expect(res.status).toBe(404);
    });
  });

  describe('mjpeg', () => {
    it('multipart headers + immediate last frame + streaming fan-out', async () => {
      hub.publish(APP, 'live-cam1', jpegFrame('first'));
      const req = new FakeReq('/live/cam1/mjpeg');
      const res = new FakeRes();
      await http.handle(req, res);

      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toBe(
        'multipart/x-mixed-replace; boundary=frame',
      );
      // The last known frame is pushed immediately (instant picture).
      expect(res.body()).toContain('--frame');
      expect(res.body()).toContain('Content-Type: image/jpeg');
      expect(res.body()).toContain('first');

      // New frames keep flowing into the open response.
      hub.publish(APP, 'live-cam1', jpegFrame('second'));
      expect(res.body()).toContain('second');
      expect(res.body().match(/--frame/g)).toHaveLength(2);
      // Each part declares its exact Content-Length.
      expect(res.body()).toContain(`Content-Length: ${jpegFrame('second').length}`);
      expect(res.ended).toBe(false); // long-lived stream
    });

    it('skips frames for a saturated viewer until drain (never queues)', async () => {
      hub.publish(APP, 'live-cam1', jpegFrame('a'));
      const req = new FakeReq('/live/cam1/mjpeg');
      const res = new FakeRes();
      res.writeOk = false; // the initial frame saturates the response
      await http.handle(req, res);
      expect(res.chunks).toHaveLength(1);

      // Saturated → the next frames are dropped for this viewer.
      hub.publish(APP, 'live-cam1', jpegFrame('DROPPED-1'));
      hub.publish(APP, 'live-cam1', jpegFrame('DROPPED-2'));
      expect(res.chunks).toHaveLength(1);

      // After drain the viewer receives the NEXT frame (no backlog replay).
      res.writeOk = true;
      res.emit('drain');
      hub.publish(APP, 'live-cam1', jpegFrame('AFTER-DRAIN'));
      expect(res.chunks).toHaveLength(2);
      expect(res.body()).toContain('AFTER-DRAIN');
      expect(res.body()).not.toContain('DROPPED');
    });

    it('client disconnect unsubscribes the viewer', async () => {
      const req = new FakeReq('/live/cam1/mjpeg');
      const res = new FakeRes();
      await http.handle(req, res);
      expect(hub.viewerCount(APP, 'live-cam1')).toBe(1);
      req.emit('close');
      expect(hub.viewerCount(APP, 'live-cam1')).toBe(0);
    });
  });

  describe('gates', () => {
    it('unknown app → terminal 404 (JSON, no SPA fallthrough)', async () => {
      const res = new FakeRes();
      await http.handle(new FakeReq('/ghost/cam1/mjpeg'), res);
      expect(res.status).toBe(404);
      expect(res.body()).toContain('not_found');
    });

    it('unknown path shape → 404', async () => {
      const res = new FakeRes();
      await http.handle(new FakeReq('/live/cam1/evil.txt'), res);
      expect(res.status).toBe(404);
    });

    it('publicPlayback=false without token → 401', async () => {
      ctx.mocks.apps.getConfig.mockResolvedValue(appConfig(false));
      hub.publish(APP, 'live-cam1', jpegFrame('x'));
      for (const path of ['/live/cam1/mjpeg', '/live/cam1/frame.jpg']) {
        const res = new FakeRes();
        await http.handle(new FakeReq(path), res);
        expect(res.status).toBe(401);
      }
      // A garbage token does not open it either (no verifier in test env).
      const res = new FakeRes();
      await http.handle(new FakeReq('/live/cam1/mjpeg?token=garbage'), res);
      expect(res.status).toBe(401);
    });
  });
});
