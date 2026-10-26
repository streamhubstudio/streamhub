/**
 * E2E spec for the direct WS MJPEG ingest — the gap the design flagged: the
 * ws-ingest protocol had unit coverage via fake sockets but was NEVER exercised
 * end-to-end over a REAL socket. This boots the full AppModule on a real port,
 * opens a genuine `ws` client, handshake-upgrades with a seeded `wsk_` key, and:
 *
 *   (a) pushes a JPEG frame → reads it back on `/live/<app>/<room>/frame.jpg`;
 *   (b) pushes a `{"type":"data",…}` frame → asserts a CallbacksService.dispatch
 *       fired with `iot.data` + the `{topic, deviceId, data, source:'ws'}` payload
 *       (the IoT data plane funnel).
 *
 * No external network: LiveKit/S3/Redis are mocked/absent per the repo harness;
 * the only socket is the in-process one we open to our own server.
 */
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import { AppModule } from '../src/app.module';
import { CallbacksService } from '../src/modules/callbacks/callbacks.service';
import { WsIngestService } from '../src/modules/ws-ingest/ws-ingest.service';
import { mountLiveHttp } from '../src/modules/ws-ingest/live-http';
import { createTmpDataDir } from './helpers/test-db';

/** A syntactically valid JPEG frame (FF D8 … FF D9). */
function jpeg(size = 64): Buffer {
  const b = Buffer.alloc(size, 0x20);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Poll an async predicate until it resolves truthy (or time out). */
async function waitForAsync(
  pred: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - started > timeoutMs) throw new Error('waitForAsync timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ws-ingest (e2e, real socket)', () => {
  let app: INestApplication;
  let port: number;
  let dispatchSpy: jest.SpyInstance;
  let streamKey: string;
  let room: string;

  beforeAll(async () => {
    process.env.DATA_DIR = createTmpDataDir();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
    );
    mountLiveHttp(app);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    // Provision a wsk_ key for room "cam1" on the seeded "live" app.
    const provisioned = await app.get(WsIngestService).provision('live', 'cam1');
    streamKey = provisioned.streamKey;
    room = provisioned.room; // "live-cam1"

    dispatchSpy = jest.spyOn(app.get(CallbacksService), 'dispatch');
  });

  afterAll(async () => {
    await app?.close();
  });

  function openCamera(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest/ws?app=live&room=cam1`, {
      headers: { authorization: `Bearer ${streamKey}` },
    });
    let ready = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        if ((JSON.parse(data.toString()) as { type?: string }).type === 'ready') ready = true;
      } catch {
        /* ignore */
      }
    });
    return new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', async () => {
        try {
          await waitFor(() => ready);
          resolve(ws);
        } catch (e) {
          reject(e as Error);
        }
      });
    });
  }

  it('accepts a JPEG frame and serves it back on /live/.../frame.jpg', async () => {
    const ws = await openCamera();
    ws.send(jpeg(64));

    // Wait until the frame is available on the HTTP frame endpoint.
    let bytes: Buffer | null = null;
    let contentType = '';
    await waitForAsync(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/live/live/cam1/frame.jpg`);
      if (res.status !== 200) return false;
      contentType = res.headers.get('content-type') ?? '';
      bytes = Buffer.from(await res.arrayBuffer());
      return bytes.length > 0;
    });

    expect(contentType).toContain('image/jpeg');
    expect(bytes).not.toBeNull();
    expect((bytes as unknown as Buffer)[0]).toBe(0xff);
    expect((bytes as unknown as Buffer)[1]).toBe(0xd8);

    ws.close();
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
  });

  it('routes a {"type":"data"} frame as an iot.data dispatch', async () => {
    const ws = await openCamera();
    dispatchSpy.mockClear();
    ws.send(JSON.stringify({ type: 'data', topic: 'temp', data: { c: 22 } }));

    await waitFor(() =>
      dispatchSpy.mock.calls.some(
        (c) => c[1] === 'iot.data' && (c[2] as { topic?: string })?.topic === 'temp',
      ),
    );

    const call = dispatchSpy.mock.calls.find((c) => c[1] === 'iot.data');
    expect(call?.[0]).toBe('live');
    expect(call?.[2]).toMatchObject({
      topic: 'temp',
      data: { c: 22 },
      source: 'ws',
    });
    expect((call?.[2] as { deviceId?: string }).deviceId).toBeTruthy();

    ws.close();
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
  });

  it('serves nothing under a room with no publisher (404)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/live/live/ghostroom/frame.jpg`);
    expect(res.status).toBe(404);
    void room;
  });
});
