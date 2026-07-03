/**
 * E2E specs for the streams controller — HTTP envelope + auth wiring.
 *
 * Boots the full AppModule over supertest (harness `bootstrapTestApp`, which
 * auto-seeds the `live` app). The test env ships empty LiveKit creds, so the
 * RoomServiceClient is never built and reconcile is a no-op — list() reflects
 * only what is in the per-app DB. That is exactly what we want to assert the
 * `{ data }` response envelope and the not-found / auth behaviour without any
 * external infra.
 *
 * A superadmin Bearer JWT (sub='admin') is minted with the test JWT secret so
 * the global auth guard + authz guard both pass.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { signJwt } from '../src/shared/auth/jwt.util';

const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';

function adminBearer(): string {
  return `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;
}

describe('streams controller (e2e)', () => {
  let ctx: TestApp;
  let auth: string;

  beforeAll(async () => {
    ctx = await bootstrapTestApp({ env: { STREAMHUB_JWT_SECRET: JWT_SECRET } });
    auth = adminBearer();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('GET /apps/:app/streams', () => {
    it('wraps the list in a { data: [...] } envelope', async () => {
      const res = await ctx
        .request()
        .get('/api/v1/apps/live/streams')
        .set('Authorization', auth)
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('reflects upserted active streams inside { data }', async () => {
      // Seed one active stream directly in the app DB via the real service.
      const svc = ctx.app.get(
        (await import('../src/modules/streams/streams.service')).StreamsService,
      );
      await svc.upsert('live', 'live-room/pub', 'rtmp', 'live-room', 'pub');

      const res = await ctx
        .request()
        .get('/api/v1/apps/live/streams')
        .set('Authorization', auth)
        .expect(200);

      const ids = (res.body.data as { streamId: string }[]).map(
        (s) => s.streamId,
      );
      expect(ids).toContain('live-room/pub');
      // envelope entries carry the mapped record shape
      const rec = (res.body.data as { streamId: string; type: string }[]).find(
        (s) => s.streamId === 'live-room/pub',
      );
      expect(rec).toMatchObject({ streamId: 'live-room/pub', type: 'rtmp' });
    });

    it('rejects an unauthenticated request with 401', async () => {
      await ctx.request().get('/api/v1/apps/live/streams').expect(401);
    });

    it('returns 404 for an unknown app', async () => {
      await ctx
        .request()
        .get('/api/v1/apps/ghost/streams')
        .set('Authorization', auth)
        .expect(404);
    });
  });

  describe('GET /apps/:app/streams/:id', () => {
    it('wraps a single stream in { data }', async () => {
      const svc = ctx.app.get(
        (await import('../src/modules/streams/streams.service')).StreamsService,
      );
      await svc.upsert('live', 'live-room/detail', 'webrtc', 'live-room', 'detail');

      const res = await ctx
        .request()
        .get('/api/v1/apps/live/streams/live-room%2Fdetail')
        .set('Authorization', auth)
        .expect(200);

      expect(res.body.data).toMatchObject({
        streamId: 'live-room/detail',
        type: 'webrtc',
      });
    });

    it('returns 404 for an unknown stream id', async () => {
      await ctx
        .request()
        .get('/api/v1/apps/live/streams/does-not-exist')
        .set('Authorization', auth)
        .expect(404);
    });
  });

  describe('DELETE /apps/:app/streams/:id', () => {
    it('stops a stream (204) and marks it ended so it drops out of the list', async () => {
      const svc = ctx.app.get(
        (await import('../src/modules/streams/streams.service')).StreamsService,
      );
      await svc.upsert('live', 'live-room/stopme', 'webrtc', 'live-room', 'stopme');

      await ctx
        .request()
        .delete('/api/v1/apps/live/streams/live-room%2Fstopme')
        .set('Authorization', auth)
        .expect(204);

      const res = await ctx
        .request()
        .get('/api/v1/apps/live/streams')
        .set('Authorization', auth)
        .expect(200);
      const ids = (res.body.data as { streamId: string }[]).map(
        (s) => s.streamId,
      );
      expect(ids).not.toContain('live-room/stopme');
    });

    it('returns 404 stopping an unknown stream', async () => {
      await ctx
        .request()
        .delete('/api/v1/apps/live/streams/nope')
        .set('Authorization', auth)
        .expect(404);
    });
  });
});
