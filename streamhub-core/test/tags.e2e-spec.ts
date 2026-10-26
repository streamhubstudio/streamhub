/**
 * E2E specs for the tags controllers — HTTP envelope + auth + validation.
 *
 * Boots the full AppModule over supertest (harness `bootstrapTestApp`, which
 * auto-seeds the `live` app). TagsModule is hosted by StreamsModule, so the
 * `/apps/:app/tags` + `/apps/:app/streams/:id/tags` routes are live without any
 * app.module.ts change. A superadmin Bearer JWT (sub='admin') satisfies the
 * global auth guard + the RBAC guard (tag CRUD → config:*, stream tagging →
 * stream:*).
 *
 * Covers: tag CRUD round-trip, slug validation (400) + duplicate (409),
 * per-stream + per-room tagging with unknown-slug (400) / missing-stream (404)
 * validation, delete-prunes-streams, unauthenticated (401) and unknown-app
 * (404) boundaries.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { signJwt } from '../src/shared/auth/jwt.util';

const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';

function adminBearer(): string {
  return `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;
}

describe('tags controllers (e2e)', () => {
  let ctx: TestApp;
  let auth: string;

  beforeAll(async () => {
    ctx = await bootstrapTestApp({ env: { STREAMHUB_JWT_SECRET: JWT_SECRET } });
    auth = adminBearer();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** Seed an active stream row via the real service. */
  async function seedStream(streamId: string, room: string): Promise<void> {
    const svc = ctx.app.get(
      (await import('../src/modules/streams/streams.service')).StreamsService,
    );
    const [r, p] = streamId.split('/');
    await svc.upsert('live', streamId, 'rtmp', room ?? r, p ?? null);
  }

  describe('tag CRUD', () => {
    it('creates, lists, gets and updates a tag', async () => {
      const created = await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({
          slug: 'store-a',
          label: 'Store A',
          kind: 'store',
          config_json: { fps: 3 },
        })
        .expect(201);
      expect(created.body.data).toMatchObject({
        slug: 'store-a',
        label: 'Store A',
        kind: 'store',
        config_json: { fps: 3 },
      });

      const list = await ctx
        .request()
        .get('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .expect(200);
      expect(
        (list.body.data as { slug: string }[]).map((t) => t.slug),
      ).toContain('store-a');

      const one = await ctx
        .request()
        .get('/api/v1/apps/live/tags/store-a')
        .set('Authorization', auth)
        .expect(200);
      expect(one.body.data).toMatchObject({ slug: 'store-a', label: 'Store A' });

      const patched = await ctx
        .request()
        .patch('/api/v1/apps/live/tags/store-a')
        .set('Authorization', auth)
        .send({ label: 'Store A2', config_json: { fps: 5 } })
        .expect(200);
      expect(patched.body.data).toMatchObject({
        label: 'Store A2',
        config_json: { fps: 5 },
      });
    });

    it('rejects an invalid slug (400) and a duplicate (409)', async () => {
      await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({ slug: 'Not_Kebab', label: 'x' })
        .expect(400);

      await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({ slug: 'dup-tag', label: 'one' })
        .expect(201);
      await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({ slug: 'dup-tag', label: 'two' })
        .expect(409);
    });

    it('404 for an unknown tag and unknown app', async () => {
      await ctx
        .request()
        .get('/api/v1/apps/live/tags/ghost-tag')
        .set('Authorization', auth)
        .expect(404);
      await ctx
        .request()
        .get('/api/v1/apps/ghost-app/tags')
        .set('Authorization', auth)
        .expect(404);
    });
  });

  describe('stream + room tagging', () => {
    it('applies tags to a stream and reads them back', async () => {
      await seedStream('room-t/cam1', 'room-t');
      await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({ slug: 'zone-x', label: 'Zone X' })
        .expect(201);

      const set = await ctx
        .request()
        .patch('/api/v1/apps/live/streams/room-t%2Fcam1/tags')
        .set('Authorization', auth)
        .send({ tags: ['zone-x'] })
        .expect(200);
      expect(set.body.data).toEqual({ streamId: 'room-t/cam1', tags: ['zone-x'] });

      const got = await ctx
        .request()
        .get('/api/v1/apps/live/streams/room-t%2Fcam1/tags')
        .set('Authorization', auth)
        .expect(200);
      expect(got.body.data.tags).toEqual(['zone-x']);
    });

    it('rejects an unknown slug (400) and a missing stream (404)', async () => {
      await seedStream('room-t/cam2', 'room-t');
      await ctx
        .request()
        .patch('/api/v1/apps/live/streams/room-t%2Fcam2/tags')
        .set('Authorization', auth)
        .send({ tags: ['does-not-exist'] })
        .expect(400);
      await ctx
        .request()
        .patch('/api/v1/apps/live/streams/nope%2Fx/tags')
        .set('Authorization', auth)
        .send({ tags: [] })
        .expect(404);
    });

    it('applies tags to every stream row of a room', async () => {
      await seedStream('room-r/cam1', 'room-r');
      await seedStream('room-r/cam2', 'room-r');
      await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({ slug: 'room-tag', label: 'Room Tag' })
        .expect(201);

      const res = await ctx
        .request()
        .patch('/api/v1/apps/live/tags/room/room-r')
        .set('Authorization', auth)
        .send({ tags: ['room-tag'] })
        .expect(200);
      expect(res.body.data).toMatchObject({ room: 'room-r', tags: ['room-tag'] });
      expect(res.body.data.updated).toBeGreaterThanOrEqual(2);
    });
  });

  describe('delete prunes streams', () => {
    it('deletes a tag (204) and prunes it from tagged streams', async () => {
      await seedStream('room-d/cam1', 'room-d');
      await ctx
        .request()
        .post('/api/v1/apps/live/tags')
        .set('Authorization', auth)
        .send({ slug: 'prune-me', label: 'Prune' })
        .expect(201);
      await ctx
        .request()
        .patch('/api/v1/apps/live/streams/room-d%2Fcam1/tags')
        .set('Authorization', auth)
        .send({ tags: ['prune-me'] })
        .expect(200);

      await ctx
        .request()
        .delete('/api/v1/apps/live/tags/prune-me')
        .set('Authorization', auth)
        .expect(204);

      const got = await ctx
        .request()
        .get('/api/v1/apps/live/streams/room-d%2Fcam1/tags')
        .set('Authorization', auth)
        .expect(200);
      expect(got.body.data.tags).toEqual([]);
    });
  });

  describe('auth', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await ctx.request().get('/api/v1/apps/live/tags').expect(401);
    });
  });
});
