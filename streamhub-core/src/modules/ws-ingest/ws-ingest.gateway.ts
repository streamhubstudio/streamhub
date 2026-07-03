import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { WsIngestService, WsLikeSocket } from './ws-ingest.service';

const INGEST_PATH = '/ingest/ws';
const VIEWER_PATH = '/live/ws';

/**
 * WebSocket gateway of the direct MJPEG ingest (ESP32-WS-INGEST.md §8):
 * two `ws.Server({ noServer: true })` instances (camera ingest + viewer
 * fan-out) hung off the core's HTTP server via the `upgrade` event — no
 * main.ts changes needed for the WS side, and every other upgrade path is
 * left untouched for future users.
 *
 * `perMessageDeflate` is OFF by design (JPEG does not compress; deflate would
 * only burn CPU) and UTF-8 validation is skipped for the binary hot path.
 */
@Injectable()
export class WsIngestGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WsIngestGateway.name);
  private ingestWss?: WebSocketServer;
  private viewerWss?: WebSocketServer;
  private attached = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly svc: WsIngestService,
  ) {}

  onApplicationBootstrap(): void {
    try {
      const server = this.adapterHost.httpAdapter?.getHttpServer() as
        | HttpServer
        | undefined;
      if (server && typeof server.on === 'function') this.attach(server);
    } catch (err) {
      this.logger.warn(`ws-ingest gateway not attached: ${String(err)}`);
    }
  }

  /** Attach the upgrade router to an HTTP server. Idempotent. */
  attach(server: HttpServer): void {
    if (this.attached) return;
    this.attached = true;

    this.ingestWss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      skipUTF8Validation: true,
      maxPayload: 8 * 1024 * 1024, // hard transport cap; protocol cap is per-app
    });
    this.viewerWss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    server.on(
      'upgrade',
      (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = req.url ?? '';
        const pathname = url.split('?')[0];
        if (pathname === INGEST_PATH) {
          this.ingestWss!.handleUpgrade(req, socket, head, (ws) => {
            void this.svc.handleIngest(
              ws as unknown as WsLikeSocket,
              this.upgradeInfo(req),
            );
          });
          return;
        }
        if (pathname === VIEWER_PATH) {
          this.viewerWss!.handleUpgrade(req, socket, head, (ws) => {
            void this.svc.handleViewer(
              ws as unknown as WsLikeSocket,
              this.upgradeInfo(req),
            );
          });
          return;
        }
        // Not ours and nobody else handles upgrades on this server → close
        // the socket instead of leaving it dangling.
        socket.destroy();
      },
    );
    this.logger.log(
      `ws-ingest gateway listening on ${INGEST_PATH} (+ viewers on ${VIEWER_PATH})`,
    );
  }

  onApplicationShutdown(): void {
    for (const wss of [this.ingestWss, this.viewerWss]) {
      try {
        wss?.clients.forEach((c: WebSocket) => c.terminate());
        wss?.close();
      } catch {
        /* shutting down */
      }
    }
  }

  private upgradeInfo(req: IncomingMessage) {
    // Behind Caddy/nginx (trust proxy 1) the client IP rides X-Forwarded-For.
    const fwd = req.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined;
    return {
      url: req.url ?? '',
      authorization: req.headers.authorization,
      ip,
    };
  }
}
