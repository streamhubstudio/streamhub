import { Injectable, Logger, Optional } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

import { FrameHub, HubViewer } from './frame-hub';
import { WsIngestService } from './ws-ingest.service';
import { WsIngestMetrics } from './ws-ingest.metrics';

/**
 * Minimal response seam (subset of express/http.ServerResponse) so the MJPEG
 * streaming logic is unit-testable with hand-rolled fakes — no HTTP server.
 */
export interface HttpResLike {
  writeHead(status: number, headers?: Record<string, string | number>): void;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string): void;
  once(event: string, listener: () => void): void;
  on(event: string, listener: () => void): void;
  writableEnded?: boolean;
}

export interface HttpReqLike {
  /** URL relative to the /live mount, e.g. `/<app>/<room>/mjpeg?token=…`. */
  url?: string;
  method?: string;
  on(event: string, listener: () => void): void;
}

const CRLF = '\r\n';
const BOUNDARY = 'frame';

/**
 * Playback endpoints WITHOUT transcode (ESP32-WS-INGEST.md §4a):
 *
 *   GET /live/<app>/<room>/mjpeg      multipart/x-mixed-replace (works in <img>)
 *   GET /live/<app>/<room>/frame.jpg  last frame (thumbnails / snapshots)
 *
 * Auth mirrors /play: public while `features.publicPlayback` is on (default);
 * when off, a LiveKit subscribe token for the room must ride as `?token=`.
 * Backpressure per HTTP viewer: while the response buffer is full
 * (`write() === false`) frames are skipped until 'drain' — never queued.
 */
@Injectable()
export class LiveHttpService {
  private readonly logger = new Logger(LiveHttpService.name);

  constructor(
    private readonly svc: WsIngestService,
    private readonly hub: FrameHub,
    @Optional() private readonly metrics?: WsIngestMetrics,
  ) {}

  /** Express-style entry point for the whole `/live` mount. Terminal (404s). */
  async handle(req: HttpReqLike, res: HttpResLike): Promise<void> {
    try {
      const url = req.url ?? '';
      const q = url.indexOf('?');
      const pathname = q >= 0 ? url.slice(0, q) : url;
      const params = new URLSearchParams(q >= 0 ? url.slice(q + 1) : '');
      const m = /^\/([^/]+)\/([^/]+)\/(mjpeg|frame\.jpg)$/.exec(pathname);
      if (!m || (req.method && req.method !== 'GET' && req.method !== 'HEAD')) {
        this.notFound(res);
        return;
      }
      const [, app, room] = m.map((s) => decodeURIComponent(s ?? ''));

      const resolved = await this.svc.resolveRoom(app, room);
      if (!resolved) {
        this.notFound(res);
        return;
      }
      const allowed = await this.svc.playbackAllowed(
        resolved.cfg,
        resolved.room,
        params.get('token'),
      );
      if (!allowed) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            data: null,
            error: { code: 'unauthorized', message: 'play token required' },
          }),
        );
        return;
      }

      if (m[3] === 'frame.jpg') {
        this.serveFrame(app, resolved.room, res);
      } else {
        this.serveMjpeg(app, resolved.room, req, res);
      }
    } catch (err) {
      this.logger.warn(`/live handler error: ${String(err)}`);
      try {
        this.notFound(res);
      } catch {
        /* headers already sent */
      }
    }
  }

  /** Last JPEG of the room — instant snapshot without ffmpeg. */
  serveFrame(app: string, room: string, res: HttpResLike): void {
    const last = this.hub.lastFrame(app, room);
    if (!last) {
      this.notFound(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': last.frame.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(last.frame);
  }

  /** Long-lived multipart/x-mixed-replace stream fed by the frame hub. */
  serveMjpeg(
    app: string,
    room: string,
    req: HttpReqLike,
    res: HttpResLike,
  ): void {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      // Disable proxy buffering so frames flush immediately (nginx honors this).
      'X-Accel-Buffering': 'no',
    });

    let awaitingDrain = false;
    const viewer: HubViewer = {
      kind: 'http',
      dropped: 0,
      ready: () => !awaitingDrain && !res.writableEnded,
      send: (frame) => {
        const head =
          `--${BOUNDARY}${CRLF}` +
          `Content-Type: image/jpeg${CRLF}` +
          `Content-Length: ${frame.length}${CRLF}${CRLF}`;
        const ok = res.write(
          Buffer.concat([Buffer.from(head), frame, Buffer.from(CRLF)]),
        );
        if (!ok) {
          awaitingDrain = true;
          res.once('drain', () => {
            awaitingDrain = false;
          });
        }
      },
    };

    this.hub.subscribe(app, room, viewer);
    this.metrics?.setViewers(app, 'http', this.hub.viewerCount(app, room));
    const cleanup = () => {
      this.hub.unsubscribe(app, room, viewer);
      this.metrics?.setViewers(app, 'http', this.hub.viewerCount(app, room));
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  private notFound(res: HttpResLike): void {
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(
      JSON.stringify({
        data: null,
        error: { code: 'not_found', message: 'live resource not found' },
      }),
    );
  }
}

/**
 * Mount `/live/*` on the raw express app (called from main.ts, same pattern as
 * mountHlsStatic — `/live` lives OUTSIDE the `/api/v1` prefix and must run
 * ahead of the SPA fallback). Terminal: unknown /live paths 404, never fall
 * through to index.html.
 */
export function mountLiveHttp(app: INestApplication): void {
  const svc = app.get(LiveHttpService, { strict: false });
  app.use('/live', (req: HttpReqLike, res: HttpResLike) => {
    void svc.handle(req, res);
  });
}
