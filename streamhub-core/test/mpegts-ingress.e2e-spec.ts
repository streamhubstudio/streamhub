/**
 * E2E — MPEG-TS over UDP (unicast + multicast) passthrough ingest, over the real
 * HTTP stack. Proves the API surface of the new `mpegts` ingress type:
 *  - create validates + canonicalizes the udp:// source, returns the passthrough
 *    shape (source_url, hls_url, capabilities; NO rtmp_url/srt_url) and arms a
 *    PULL remux;
 *  - it is passthrough-LOCKED (transcode mode + transcoding flag are 400s);
 *  - bad sources (non-udp, missing port, bad multicast/SSM) are 400s;
 *  - the listing merges the row (inputType mpegts + source_url);
 *  - delete tears it down via the passthrough plane.
 *
 * RemuxManager is mocked so nothing real is spawned (no ffmpeg, NO multicast /
 * network join) — the arg-building + arming logic is unit-tested elsewhere.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';
import { LiveKitService } from '../src/modules/livekit/livekit.service';
import { RemuxManager } from '../src/modules/passthrough/remux.manager';

const P = '/api/v1';

/**
 * Minimal LiveKit stub: the ingress LISTING merges LiveKit ingresses with the
 * passthrough rows, so `GET /ingress` calls listIngress()/listRooms(). With the
 * test env's empty LiveKit creds those would 503 — stub them to empty so the
 * passthrough (mpegts) rows are all that show up. createIngress is never hit
 * (the mpegts path is passthrough-only and never touches LiveKit).
 */
function fakeLiveKit() {
  return {
    listIngress: jest.fn(async () => []),
    listRooms: jest.fn(async () => []),
    deleteIngress: jest.fn(async () => undefined),
    isReachable: jest.fn(async () => true),
  };
}

function fakeRemux() {
  return {
    start: jest.fn(() => ({ status: 'live' })),
    stop: jest.fn(() => ({ status: 'off' })),
    status: jest.fn(() => ({ status: 'live' })),
    isActive: jest.fn(() => true),
    logs: jest.fn(() => []),
    list: jest.fn(() => [] as unknown[]),
  };
}

describe('MPEG-TS/UDP passthrough ingest (e2e)', () => {
  let ctx: TestApp;
  let remux: ReturnType<typeof fakeRemux>;
  let sk: string;
  const bearer = (): [string, string] => ['Authorization', `Bearer ${sk}`];

  beforeAll(async () => {
    remux = fakeRemux();
    ctx = await bootstrapTestApp({
      env: { STREAMHUB_RTMP_PASSTHROUGH_ENABLE: 'on', RTMP_PUBLIC_HOST: 'media.test' },
      overrides: (b) =>
        b
          .overrideProvider(RemuxManager)
          .useValue(remux)
          .overrideProvider(LiveKitService)
          .useValue(fakeLiveKit()),
    });
    sk = (
      await ctx.app.get(AuthService).createToken({ name: 'ci', scope: 'global' })
    ).token;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('creates a multicast mpegts ingress: canonical source_url + hls_url + capabilities, no push URL', async () => {
    const res = await ctx
      .request()
      .post(`${P}/apps/live/ingress`)
      .set(...bearer())
      .send({
        inputType: 'mpegts',
        mode: 'passthrough',
        room: 'mc1',
        url: 'udp://@239.1.1.1:5000',
        sources: '10.0.0.5',
        fifoSize: 1000000,
      })
      .expect(201);

    const d = res.body.data;
    expect(d.mode).toBe('passthrough');
    expect(d.ingressId).toMatch(/^pti_mpegts_/);
    expect(d.inputType).toBe('mpegts');
    expect(d.source_url).toBe(
      'udp://@239.1.1.1:5000?sources=10.0.0.5&fifo_size=1000000&overrun_nonfatal=1',
    );
    expect(d.rtmp_url).toBeUndefined();
    expect(d.srt_url).toBeUndefined();
    expect(typeof d.hls_url).toBe('string');
    expect(d.capabilities?.mode).toBe('passthrough');
    // The PULL remux was armed with the canonical source.
    expect(remux.start).toHaveBeenCalledWith(
      d.ingressId,
      expect.objectContaining({ transport: 'mpegts', mode: 'pull', sourceUrl: d.source_url }),
    );
  });

  it('creates a unicast mpegts ingress (udp://@:PORT)', async () => {
    const res = await ctx
      .request()
      .post(`${P}/apps/live/ingress`)
      .set(...bearer())
      .send({ inputType: 'mpegts', mode: 'passthrough', room: 'uc1', url: 'udp://@:5001' })
      .expect(201);
    expect(res.body.data.source_url).toBe('udp://@:5001?overrun_nonfatal=1');
  });

  it('is passthrough-LOCKED: transcode mode is a 400', async () => {
    await ctx
      .request()
      .post(`${P}/apps/live/ingress`)
      .set(...bearer())
      .send({ inputType: 'mpegts', mode: 'transcode', url: 'udp://@239.1.1.1:5000' })
      .expect(400);
  });

  it('rejects an mpegts create that omits the udp source (400)', async () => {
    await ctx
      .request()
      .post(`${P}/apps/live/ingress`)
      .set(...bearer())
      .send({ inputType: 'mpegts', mode: 'passthrough', room: 'nosrc' })
      .expect(400);
  });

  it('rejects a non-udp / malformed source and a bad SSM combo (400)', async () => {
    for (const url of [
      'rtsp://cam/stream', // wrong scheme
      'udp://@239.1.1.1', // missing port
      'udp://@camera.local:5000', // hostname, not an IPv4 group
    ]) {
      await ctx
        .request()
        .post(`${P}/apps/live/ingress`)
        .set(...bearer())
        .send({ inputType: 'mpegts', mode: 'passthrough', url })
        .expect(400);
    }
    // SSM sources on a non-multicast host.
    await ctx
      .request()
      .post(`${P}/apps/live/ingress`)
      .set(...bearer())
      .send({
        inputType: 'mpegts',
        mode: 'passthrough',
        url: 'udp://@:5000',
        sources: '10.0.0.5',
      })
      .expect(400);
  });

  it('lists the mpegts ingress with inputType + source_url and deletes it', async () => {
    const created = await ctx
      .request()
      .post(`${P}/apps/live/ingress`)
      .set(...bearer())
      .send({ inputType: 'mpegts', mode: 'passthrough', room: 'mc2', url: 'udp://@239.2.2.2:5002' })
      .expect(201);
    const id = created.body.data.ingressId;

    const list = await ctx
      .request()
      .get(`${P}/apps/live/ingress`)
      .set(...bearer())
      .expect(200);
    const row = (list.body.data as Array<Record<string, unknown>>).find(
      (r) => r.ingressId === id,
    );
    expect(row).toBeTruthy();
    expect(row?.inputType).toBe('mpegts');
    expect(row?.source_url).toBe('udp://@239.2.2.2:5002?overrun_nonfatal=1');
    expect(row?.rtmp_url).toBeUndefined();

    const del = await ctx
      .request()
      .delete(`${P}/apps/live/ingress/${id}`)
      .set(...bearer())
      .expect(200);
    expect(del.body.data).toMatchObject({ ingressId: id, deleted: true, mode: 'passthrough' });
    expect(remux.stop).toHaveBeenCalledWith(id);
  });
});
