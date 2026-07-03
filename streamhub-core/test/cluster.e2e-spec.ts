/**
 * E2E — cluster edge-node registration over the FULL AppModule (supertest).
 *
 * Covers the pieces that need the real request pipeline:
 *  - the manual `X-Cluster-Token` gate (503 disabled, 401 wrong/absent),
 *  - the global ValidationPipe (400 on a bad name / ip),
 *  - the idempotent join (201 create → 200 refresh, id preserved),
 *  - heartbeat (200 / 404),
 *  - GET /cluster/nodes behind the REAL Bearer guard (401 anon, 200 for a
 *    superadmin JWT).
 *
 * A superadmin Bearer JWT (sub='admin') is minted with the test JWT secret so
 * the global auth + authz guards both pass (mirrors streams.e2e-spec.ts).
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { signJwt } from '../src/shared/auth/jwt.util';

const P = '/api/v1';
const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
const TOKEN = 'e2e-cluster-token';

function adminBearer(): string {
  return `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;
}

describe('cluster (e2e)', () => {
  describe('joining disabled (STREAMHUB_CLUSTER_TOKEN unset)', () => {
    let app: TestApp;

    beforeAll(async () => {
      app = await bootstrapTestApp({ env: { STREAMHUB_CLUSTER_TOKEN: '' } });
    });
    afterAll(async () => app?.close());

    it('503 with the exact error body on /join', async () => {
      const res = await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge', ip: '203.0.113.1' })
        .expect(503);
      expect(res.body).toEqual({
        error: 'cluster joining disabled (STREAMHUB_CLUSTER_TOKEN unset)',
      });
    });

    it('503 on /heartbeat too', async () => {
      await app
        .request()
        .post(`${P}/cluster/heartbeat`)
        .set('X-Cluster-Token', TOKEN)
        .send({ nodeId: 'x' })
        .expect(503);
    });
  });

  describe('enabled (token set)', () => {
    let app: TestApp;
    const auth = adminBearer();

    beforeAll(async () => {
      app = await bootstrapTestApp({
        env: {
          STREAMHUB_JWT_SECRET: JWT_SECRET,
          STREAMHUB_CLUSTER_TOKEN: TOKEN,
          STREAMHUB_CLUSTER_REDIS_URL: 'redis://cluster-redis:6379',
          STREAMHUB_PUBLIC_URL: 'https://media.example.com',
          PUBLIC_WS_URL: 'wss://public.example.com',
          LIVEKIT_API_KEY: 'APIe2ekey',
          LIVEKIT_API_SECRET: 'e2e-livekit-secret',
        },
      });
    });
    afterAll(async () => app?.close());

    // ---- token gate ---------------------------------------------------------
    it('401 when X-Cluster-Token is wrong', async () => {
      await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', 'wrong')
        .send({ name: 'edge', ip: '203.0.113.1' })
        .expect(401);
    });

    it('401 when X-Cluster-Token is absent', async () => {
      await app
        .request()
        .post(`${P}/cluster/join`)
        .send({ name: 'edge', ip: '203.0.113.1' })
        .expect(401);
    });

    // ---- DTO validation -----------------------------------------------------
    it('400 on an invalid name', async () => {
      await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'bad name!', ip: '203.0.113.1' })
        .expect(400);
    });

    it('400 on an invalid ip', async () => {
      await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge', ip: 'not-an-ip' })
        .expect(400);
    });

    // ---- join / upsert / heartbeat -----------------------------------------
    it('201 create → 200 refresh (id preserved), then heartbeat', async () => {
      const first = await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge-1', ip: '203.0.113.7', region: 'eu' })
        .expect(201);

      expect(first.body.error).toBeNull();
      const payload = first.body.data;
      expect(payload.name).toBe('edge-1');
      expect(typeof payload.nodeId).toBe('string');
      expect(payload.redisUrl).toBe('redis://cluster-redis:6379');
      expect(payload.publicWsUrl).toBe('wss://public.example.com');
      expect(payload.livekit).toEqual({
        apiKey: 'APIe2ekey',
        apiSecret: 'e2e-livekit-secret',
        wsUrl: 'ws://127.0.0.1:7880',
      });

      const again = await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge-1', ip: '203.0.113.99' })
        .expect(200);
      expect(again.body.data.nodeId).toBe(payload.nodeId); // idempotent

      await app
        .request()
        .post(`${P}/cluster/heartbeat`)
        .set('X-Cluster-Token', TOKEN)
        .send({ nodeId: payload.nodeId })
        .expect(200)
        .expect((r) => expect(r.body).toEqual({ data: { ok: true }, error: null }));

      await app
        .request()
        .post(`${P}/cluster/heartbeat`)
        .set('X-Cluster-Token', TOKEN)
        .send({ nodeId: 'does-not-exist' })
        .expect(404);
    });

    // ---- GET /nodes behind the real Bearer guard ---------------------------
    it('GET /cluster/nodes requires auth (401 anonymous)', async () => {
      await app.request().get(`${P}/cluster/nodes`).expect(401);
    });

    it('GET /cluster/nodes lists nodes for a superadmin', async () => {
      const res = await app
        .request()
        .get(`${P}/cluster/nodes`)
        .set('Authorization', auth)
        .expect(200);
      expect(res.body.error).toBeNull();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.some((n: { name: string }) => n.name === 'edge-1')).toBe(
        true,
      );
      // the registry carries no secrets
      expect(res.body.data[0]).not.toHaveProperty('apiSecret');
    });

    // ---- info (dashboard cluster manager) ----------------------------------
    it('GET /cluster/info requires auth (401 anonymous)', async () => {
      await app.request().get(`${P}/cluster/info`).expect(401);
    });

    it('GET /cluster/info returns the overview + join one-liner for a superadmin', async () => {
      const res = await app
        .request()
        .get(`${P}/cluster/info`)
        .set('Authorization', auth)
        .expect(200);
      expect(res.body.error).toBeNull();
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.clusterToken).toBe(TOKEN);
      expect(res.body.data.clusterRedisUrl).toBe('redis://cluster-redis:6379');
      expect(typeof res.body.data.nodesCount).toBe('number');
      expect(res.body.data.joinCommand).toContain(`--master-token ${TOKEN}`);
      expect(res.body.data.joinCommand).toContain('--master-ip <THIS_SERVER_IP>');
      expect(res.body.data.joinCommand).toContain(
        '--master-url https://media.example.com',
      );
    });

    // ---- heartbeat stats + derived stale -----------------------------------
    it('heartbeat stats persist and surface (parsed, stale=false) in /nodes', async () => {
      const joined = await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge-stats', ip: '203.0.113.20' })
        .expect(201);
      const nodeId = joined.body.data.nodeId as string;

      await app
        .request()
        .post(`${P}/cluster/heartbeat`)
        .set('X-Cluster-Token', TOKEN)
        .send({ nodeId, stats: { cpu: 0.7, activeStreams: 4 } })
        .expect(200);

      const res = await app
        .request()
        .get(`${P}/cluster/nodes`)
        .set('Authorization', auth)
        .expect(200);
      const node = res.body.data.find(
        (n: { id: string }) => n.id === nodeId,
      );
      expect(node.stats).toEqual({ cpu: 0.7, activeStreams: 4 });
      expect(node.stale).toBe(false);
    });

    // ---- PATCH /cluster/nodes/:id ------------------------------------------
    it('PATCH /cluster/nodes/:id updates a node for a superadmin', async () => {
      const joined = await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge-patch', ip: '203.0.113.21' })
        .expect(201);
      const nodeId = joined.body.data.nodeId as string;

      const res = await app
        .request()
        .patch(`${P}/cluster/nodes/${nodeId}`)
        .set('Authorization', auth)
        .send({ status: 'draining', region: 'us-east' })
        .expect(200);
      expect(res.body.error).toBeNull();
      expect(res.body.data.status).toBe('draining');
      expect(res.body.data.region).toBe('us-east');
    });

    it('PATCH 400 on an out-of-enum status (real ValidationPipe)', async () => {
      await app
        .request()
        .patch(`${P}/cluster/nodes/anything`)
        .set('Authorization', auth)
        .send({ status: 'bogus' })
        .expect(400);
    });

    it('PATCH 404 for an unknown node', async () => {
      await app
        .request()
        .patch(`${P}/cluster/nodes/does-not-exist`)
        .set('Authorization', auth)
        .send({ status: 'active' })
        .expect(404);
    });

    it('PATCH requires auth (401 anonymous)', async () => {
      await app
        .request()
        .patch(`${P}/cluster/nodes/anything`)
        .send({ status: 'active' })
        .expect(401);
    });

    // ---- DELETE /cluster/nodes/:id -----------------------------------------
    it('DELETE /cluster/nodes/:id removes a node and it disappears from /nodes', async () => {
      const joined = await app
        .request()
        .post(`${P}/cluster/join`)
        .set('X-Cluster-Token', TOKEN)
        .send({ name: 'edge-del', ip: '203.0.113.22' })
        .expect(201);
      const nodeId = joined.body.data.nodeId as string;

      const res = await app
        .request()
        .delete(`${P}/cluster/nodes/${nodeId}`)
        .set('Authorization', auth)
        .expect(200);
      expect(res.body).toEqual({
        data: { id: nodeId, deleted: true },
        error: null,
      });

      const list = await app
        .request()
        .get(`${P}/cluster/nodes`)
        .set('Authorization', auth)
        .expect(200);
      expect(
        list.body.data.some((n: { id: string }) => n.id === nodeId),
      ).toBe(false);
    });

    it('DELETE 404 for an unknown node', async () => {
      await app
        .request()
        .delete(`${P}/cluster/nodes/does-not-exist`)
        .set('Authorization', auth)
        .expect(404);
    });

    it('DELETE requires auth (401 anonymous)', async () => {
      await app.request().delete(`${P}/cluster/nodes/anything`).expect(401);
    });
  });
});
