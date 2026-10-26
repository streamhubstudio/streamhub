import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';

import { NetworkGuardService } from '../security/network-guard.service';
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
    @Optional() private readonly netGuard?: NetworkGuardService,
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

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.routeUpgrade(req, socket, head);
    });
    this.logger.log(
      `ws-ingest gateway listening on ${INGEST_PATH} (+ viewers on ${VIEWER_PATH})`,
    );
  }

  /**
   * Route one HTTP `upgrade` for OUR two paths (camera ingest + viewer fan-out).
   * Public for unit tests. Before accepting one of our upgrades it runs the
   * network-security IP gate (Flag B — internal design notes): a banned /
   * blocklisted peer is rejected with a bare HTTP 403 and the socket destroyed,
   * so the auto-ban that covers the HTTP plane now also covers WS upgrades. Any
   * other path is left to the cooperative multi-gateway reject.
   */
  routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '').split('?')[0];
    const isOurs = pathname === INGEST_PATH || pathname === VIEWER_PATH;

    if (isOurs) {
      const reason = this.netGuard?.rejectUpgradeReason(this.clientIp(req));
      if (reason) {
        this.rejectUpgrade(socket, reason);
        return;
      }
    }

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
    // Not one of OUR paths. Another gateway (e.g. the edge WS control channel)
    // hangs its own 'upgrade' listener off this same server and may still claim
    // this socket — every listener runs for every upgrade. Defer the reject to
    // the next tick and only destroy if nobody stamped the request as handled
    // (cooperative multi-gateway upgrade routing).
    setImmediate(() => {
      const handled = (req as unknown as Record<string, boolean>)
        .__streamhubUpgradeHandled;
      if (!handled && !socket.destroyed) socket.destroy();
    });
  }

  /** Reject a WS upgrade with a bare HTTP 403 and drop the socket. */
  private rejectUpgrade(socket: Duplex, reason: string): void {
    try {
      socket.write(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n\r\n',
      );
    } catch {
      /* peer already gone */
    }
    try {
      socket.destroy();
    } catch {
      /* already destroyed */
    }
    this.logger.warn(`ws upgrade rejected by network-security (${reason})`);
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
    return {
      url: req.url ?? '',
      authorization: req.headers.authorization,
      ip: this.clientIp(req),
    };
  }

  /** Peer IP for the upgrade — X-Forwarded-For first (behind Caddy/nginx). */
  private clientIp(req: IncomingMessage): string | undefined {
    const fwd = req.headers['x-forwarded-for'];
    return (
      (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined
    );
  }
}
