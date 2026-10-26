/**
 * E2E specs for the vision Studio Apps controller + the app-scoped edge
 * assignments API — HTTP envelope + auth + validation, over the full AppModule
 * (harness `bootstrapTestApp`, auto-seeds the `live` app). VisionAppsModule is
 * HOSTED by EdgeModule, so the parametrized `/apps/:app/plugins/:visionApp`
 * routes are live without any app.module.ts change.
 *
 * Covers: settings PUT/GET round-trip + polygon validation (400) + unknown model
 * (404), the per-app events read (seeded via the real VisionStore), the
 * overview/streams shapes, the generic edge-assignments create→list→revoke cycle
 * (parked pending with no edge node), the validation gate (non-edge plugin 400),
 * and the unauthenticated (401) boundary.
 */
import * as path from 'path';
import * as fs from 'fs';

// COMPOSED-GATED (vision-4 exodus): the vision model-apps live in their own
// repo; this suite exercises the CORE vision-apps module THROUGH the composed
// occupancy app, so it runs at full strength when apps-pull composed it (CI
// always does) and skips hermetically.
const VISION_COMPOSED = fs.existsSync(
  path.join(__dirname, '..', 'src', 'plugins-vendor', 'occupancy', 'streamhub.app.json'),
);
const describeComposed = VISION_COMPOSED ? describe : describe.skip;


import { bootstrapTestApp, type TestApp } from './helpers';
import { signJwt } from '../src/shared/auth/jwt.util';
import { VisionStore } from '../src/modules/vision-apps/vision.store';

const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';

function adminBearer(): string {
  return `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;
}

describeComposed('vision apps + edge assignments (e2e)', () => {
  let ctx: TestApp;
  let auth: string;

  beforeAll(async () => {
    ctx = await bootstrapTestApp({
      env: {
        STREAMHUB_JWT_SECRET: JWT_SECRET,
        // Discover the synthetic fixtures so the "non-edge plugin" rejection can
        // use `reftool` (a fixture) instead of a real shipping app that decouples.
        STREAMHUB_PLUGIN_FIXTURE_ROOT: path.join(__dirname, 'fixtures', 'plugins'),
      },
    });
    auth = adminBearer();
  });

  afterAll(async () => {
    await ctx?.close();
    delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  });

  /** A vision model-app route, e.g. url('occupancy', '/overview'). */
  const url = (model: string, p: string) =>
    `/api/v1/apps/live/plugins/${model}${p}`;

  describe('settings round-trip', () => {
    it('PUTs a polygon, normalizes it, and reads it back', async () => {
      const put = await ctx
        .request()
        .put(url('occupancy', '/streams/gate/settings'))
        .set('Authorization', auth)
        .send({
          config: {
            zones: [
              {
                id: 'z1',
                tag: 'store-a',
                detect: 'personas',
                points: [[1.5, -0.1], [0.5, 0.2], [0.1, 0.9]],
              },
            ],
          },
        })
        .expect(200);
      expect(put.body.data.config.zones[0].points).toEqual([
        [1, 0],
        [0.5, 0.2],
        [0.1, 0.9],
      ]);

      const get = await ctx
        .request()
        .get(url('occupancy', '/streams/gate/settings'))
        .set('Authorization', auth)
        .expect(200);
      expect(get.body.data.config.zones[0].id).toBe('z1');
      expect(get.body.data.resolved.zones).toHaveLength(1);
    });

    it('rejects an invalid polygon (400) and an unknown model (404)', async () => {
      await ctx
        .request()
        .put(url('occupancy', '/streams/gate/settings'))
        .set('Authorization', auth)
        .send({ config: { zones: [{ points: [[0, 0], [1, 1]] }] } })
        .expect(400);
      await ctx
        .request()
        .put(url('facerec', '/streams/gate/settings'))
        .set('Authorization', auth)
        .send({ config: {} })
        .expect(404);
    });
  });

  describe('events read', () => {
    it('lists recent events for a model seeded in its per-app db', async () => {
      const store = ctx.app.get(VisionStore);
      const appDir = path.join(ctx.dataDir, 'apps', 'live');
      store.recordCount('live', appDir, 'gate', 'count.in', { line: 'l1', tag: 'door' });

      const res = await ctx
        .request()
        .get(url('counting', '/events?limit=10'))
        .set('Authorization', auth)
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toMatchObject({ model: 'counting', event: 'count.in', room: 'gate' });
    });

    it('404s an unknown model app', async () => {
      await ctx
        .request()
        .get(url('nope', '/events'))
        .set('Authorization', auth)
        .expect(404);
    });
  });

  describe('reads', () => {
    it('returns overview / streams shapes', async () => {
      const ov = await ctx.request().get(url('occupancy', '/overview')).set('Authorization', auth).expect(200);
      expect(ov.body.data).toMatchObject({ model: 'occupancy' });
      expect(ov.body.data).toHaveProperty('enabled');
      expect(ov.body.data).toHaveProperty('assignments');

      const st = await ctx.request().get(url('occupancy', '/streams')).set('Authorization', auth).expect(200);
      expect(Array.isArray(st.body.data)).toBe(true);
    });

    it('404s for an unknown app', async () => {
      await ctx
        .request()
        .get('/api/v1/apps/ghost/plugins/occupancy/overview')
        .set('Authorization', auth)
        .expect(404);
    });
  });

  describe('edge assignments (generic, app-scoped)', () => {
    const edgeUrl = (p: string) => `/api/v1/apps/live/edge${p}`;

    it('creates → lists → revokes an edge assignment (pending, no edge node)', async () => {
      // The plugin must be installed in the app first.
      await ctx
        .request()
        .post(url('occupancy', '/install'))
        .set('Authorization', auth)
        .expect(201);

      const created = await ctx
        .request()
        .post(edgeUrl('/assignments'))
        .set('Authorization', auth)
        .send({ pluginId: 'occupancy', streamId: 'gate' })
        .expect(201);
      const id = created.body.data.id as string;
      expect(created.body.data).toMatchObject({ pluginId: 'occupancy', streamId: 'gate' });

      const list = await ctx.request().get(edgeUrl('/assignments')).set('Authorization', auth).expect(200);
      expect((list.body.data as { id: string }[]).some((a) => a.id === id)).toBe(true);

      await ctx.request().delete(edgeUrl(`/assignments/${id}`)).set('Authorization', auth).expect(200);
    });

    it('rejects a non-edge-capable plugin (400)', async () => {
      // `reftool` is a worker app WITHOUT worker.edge (synthetic fixture).
      await ctx
        .request()
        .post(edgeUrl('/assignments'))
        .set('Authorization', auth)
        .send({ pluginId: 'reftool' })
        .expect(400);
    });
  });

  describe('auth', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await ctx.request().get(url('occupancy', '/overview')).expect(401);
    });
  });
});
