/**
 * Unit spec — WsIngestGateway upgrade routing (the gateway had zero specs).
 * Drives `routeUpgrade` directly with fake req/socket/head (no `ws` handshake,
 * no network): path matching (ingest vs viewer vs other), X-Forwarded-For IP
 * extraction, the cooperative multi-gateway reject flag, and the network-security
 * banned/blocklisted-IP reject (Flag B).
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

import { WsIngestGateway } from './ws-ingest.gateway';
import type { NetworkGuardService } from '../security/network-guard.service';
import type { WsIngestService } from './ws-ingest.service';

class FakeSocket {
  written: string[] = [];
  destroyed = false;
  write(s: string): boolean {
    this.written.push(s);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeServer {
  private listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  on(event: string, cb: (...a: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(cb);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
}

function makeReq(url: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    url,
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
    ...over,
  } as unknown as IncomingMessage;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('WsIngestGateway.routeUpgrade', () => {
  let gateway: WsIngestGateway;
  let svc: { handleIngest: jest.Mock; handleViewer: jest.Mock };
  let netGuard: { rejectUpgradeReason: jest.Mock };
  let server: FakeServer;

  beforeEach(() => {
    svc = { handleIngest: jest.fn(), handleViewer: jest.fn() };
    netGuard = { rejectUpgradeReason: jest.fn(() => null) };
    gateway = new WsIngestGateway(
      {} as never,
      svc as unknown as WsIngestService,
      netGuard as unknown as NetworkGuardService,
    );
    server = new FakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gateway.attach(server as any);
    // Stub the real ws handshakes so we never touch a socket.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).ingestWss.handleUpgrade = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).viewerWss.handleUpgrade = jest.fn();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ingestWss = () => (gateway as any).ingestWss.handleUpgrade as jest.Mock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerWss = () => (gateway as any).viewerWss.handleUpgrade as jest.Mock;

  it('routes /ingest/ws to the ingest WSS → handleIngest', () => {
    const sock = new FakeSocket();
    server.emit('upgrade', makeReq('/ingest/ws?app=live&room=cam1'), sock, Buffer.alloc(0));
    expect(ingestWss()).toHaveBeenCalledTimes(1);
    expect(viewerWss()).not.toHaveBeenCalled();
    // The handshake callback bridges to the service.
    const cb = ingestWss().mock.calls[0][3] as (ws: unknown) => void;
    cb({ fake: 'ws' });
    expect(svc.handleIngest).toHaveBeenCalledTimes(1);
  });

  it('routes /live/ws to the viewer WSS → handleViewer', () => {
    server.emit('upgrade', makeReq('/live/ws?app=live&room=cam1'), new FakeSocket(), Buffer.alloc(0));
    expect(viewerWss()).toHaveBeenCalledTimes(1);
    expect(ingestWss()).not.toHaveBeenCalled();
    const cb = viewerWss().mock.calls[0][3] as (ws: unknown) => void;
    cb({ fake: 'ws' });
    expect(svc.handleViewer).toHaveBeenCalledTimes(1);
  });

  it('extracts the client IP from X-Forwarded-For (first hop)', () => {
    const req = makeReq('/ingest/ws', {
      headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    } as never);
    server.emit('upgrade', req, new FakeSocket(), Buffer.alloc(0));
    expect(netGuard.rejectUpgradeReason).toHaveBeenCalledWith('198.51.100.9');
  });

  it('falls back to socket.remoteAddress when there is no XFF header', () => {
    server.emit('upgrade', makeReq('/ingest/ws'), new FakeSocket(), Buffer.alloc(0));
    expect(netGuard.rejectUpgradeReason).toHaveBeenCalledWith('203.0.113.7');
  });

  it('rejects a banned IP at the upgrade with HTTP 403 (never reaches the WSS)', () => {
    netGuard.rejectUpgradeReason.mockReturnValue('banned');
    const sock = new FakeSocket();
    server.emit('upgrade', makeReq('/ingest/ws'), sock, Buffer.alloc(0));
    expect(ingestWss()).not.toHaveBeenCalled();
    expect(svc.handleIngest).not.toHaveBeenCalled();
    expect(sock.written[0]).toContain('403 Forbidden');
    expect(sock.destroyed).toBe(true);
  });

  it('also gates the viewer upgrade on a blocklisted IP', () => {
    netGuard.rejectUpgradeReason.mockReturnValue('blocked');
    const sock = new FakeSocket();
    server.emit('upgrade', makeReq('/live/ws'), sock, Buffer.alloc(0));
    expect(viewerWss()).not.toHaveBeenCalled();
    expect(sock.destroyed).toBe(true);
  });

  it('does NOT run the security gate for a non-our path', () => {
    server.emit('upgrade', makeReq('/some/other/upgrade'), new FakeSocket(), Buffer.alloc(0));
    expect(netGuard.rejectUpgradeReason).not.toHaveBeenCalled();
  });

  it('cooperatively rejects an unclaimed foreign upgrade next tick', async () => {
    const sock = new FakeSocket();
    server.emit('upgrade', makeReq('/edge/ws'), sock, Buffer.alloc(0));
    expect(sock.destroyed).toBe(false); // deferred
    await tick();
    expect(sock.destroyed).toBe(true);
  });

  it('leaves a foreign upgrade alone when another gateway claimed it', async () => {
    const sock = new FakeSocket();
    const req = makeReq('/edge/ws');
    // Another gateway stamps the request as handled synchronously.
    (req as unknown as Record<string, boolean>).__streamhubUpgradeHandled = true;
    server.emit('upgrade', req, sock, Buffer.alloc(0));
    await tick();
    expect(sock.destroyed).toBe(false);
  });
});
