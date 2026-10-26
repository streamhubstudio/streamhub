/**
 * E2E — MediaMTX internal hook routes (single-port :1935 switch) over the real
 * HTTP stack. Proves the three loopback-only routes are wired under
 * /api/v1/internal/mediamtx/*, are @Public (no Bearer needed), and enforce the
 * shared-secret guard. RemuxManager is mocked so /ready arms NOTHING real (no
 * ffmpeg, no network) — the arming logic itself is unit-tested elsewhere.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { IngressAuthService } from '../src/modules/livekit/ingress-auth.service';
import { RemuxManager } from '../src/modules/passthrough/remux.manager';

const SECRET = 'e2e-secret';
const HDR = 'X-MediaMTX-Secret';

function fakeRemux() {
  return {
    start: jest.fn(() => ({ status: 'live' })),
    stop: jest.fn(() => ({ status: 'off' })),
    status: jest.fn(() => undefined),
    isActive: jest.fn(() => false),
    logs: jest.fn(() => []),
    list: jest.fn(() => []),
  };
}

describe('MediaMTX hooks (e2e)', () => {
  let ctx: TestApp;
  let remux: ReturnType<typeof fakeRemux>;
  let streamKey: string;

  beforeAll(async () => {
    remux = fakeRemux();
    ctx = await bootstrapTestApp({
      env: {
        STREAMHUB_RTMP_PASSTHROUGH_ENABLE: 'on',
        STREAMHUB_MEDIAMTX_ENABLE: 'on',
        STREAMHUB_MEDIAMTX_RTMP_PORT: '1935',
        STREAMHUB_MEDIAMTX_HOOK_SECRET: SECRET,
      },
      overrides: (b) => b.overrideProvider(RemuxManager).useValue(remux),
    });
    // Mint a real passthrough key for the seeded `live` app.
    const auth = ctx.app.get(IngressAuthService);
    streamKey = auth.registerPassthrough({ app: 'live', room: 'e2e' }).streamKey;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const path = (p: string) => `/api/v1/internal/mediamtx/${p}`;

  describe('guard', () => {
    it('403 without the secret header (and it is NOT the Bearer guard → not 401)', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .send({ action: 'publish', path: `live/${streamKey}` })
        .expect(403);
    });

    it('403 with a wrong secret', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .set(HDR, 'wrong')
        .send({ action: 'publish', path: `live/${streamKey}` })
        .expect(403);
    });
  });

  describe('/auth', () => {
    it('200 for a valid passthrough key (app "live" + ptk_ key)', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .set(HDR, SECRET)
        .send({ action: 'publish', path: `live/${streamKey}` })
        .expect(200);
    });

    it('200 for a non-publish action', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .set(HDR, SECRET)
        .send({ action: 'read', path: 'whatever' })
        .expect(200);
    });

    it('200 for a real LiveKit push (live/<non-ptk key>)', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .set(HDR, SECRET)
        .send({ action: 'publish', path: 'live/sk_livekit' })
        .expect(200);
    });

    it('401 for an unknown passthrough key', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .set(HDR, SECRET)
        .send({ action: 'publish', path: 'live/ptk_bogus' })
        .expect(401);
    });

    it('401 for a garbage path', async () => {
      await ctx
        .request()
        .post(path('auth'))
        .set(HDR, SECRET)
        .send({ action: 'publish', path: 'garbage' })
        .expect(401);
    });
  });

  describe('/ready + /notready', () => {
    it('/ready arms the remux (mocked) for the passthrough path', async () => {
      await ctx
        .request()
        .post(path('ready'))
        .set(HDR, SECRET)
        .send({ path: `live/${streamKey}` })
        .expect(200);
      expect(remux.start).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ mode: 'pull', port: 1935 }),
      );
    });

    it('/notready stops the remux for the passthrough path', async () => {
      await ctx
        .request()
        .post(path('notready'))
        .set(HDR, SECRET)
        .send({ path: `live/${streamKey}` })
        .expect(200);
      expect(remux.stop).toHaveBeenCalled();
    });

    it('/ready arms the FORWARD (mocked) for the LiveKit plane — core owns routing', async () => {
      remux.start.mockClear();
      await ctx
        .request()
        .post(path('ready'))
        .set(HDR, SECRET)
        .send({ path: 'live/sk_livekit' })
        .expect(200);
      expect(remux.start).toHaveBeenCalledWith(
        'fwd_sk_livekit',
        expect.objectContaining({
          kind: 'forward',
          port: 1935,
          destPort: 11935,
          forwardKey: 'sk_livekit',
        }),
      );
    });
  });

  describe('secret via query param (authHTTPAddress cannot set headers)', () => {
    it('200 for a valid passthrough key with ?secret= and no header', async () => {
      await ctx
        .request()
        .post(`${path('auth')}?secret=${SECRET}`)
        .send({ action: 'publish', path: `live/${streamKey}` })
        .expect(200);
    });

    it('403 for a wrong ?secret=', async () => {
      await ctx
        .request()
        .post(`${path('auth')}?secret=wrong`)
        .send({ action: 'publish', path: `live/${streamKey}` })
        .expect(403);
    });
  });
});
