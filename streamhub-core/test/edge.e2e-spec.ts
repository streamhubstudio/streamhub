/**
 * E2E — Vision Edge manager surface over the FULL request pipeline (supertest).
 *
 * The edge REST routes are global-scope Bearer admin endpoints (like /cluster/*):
 * this covers the real Bearer guard (401 anon), the ValidationPipe (400), node
 * list/patch, assignment schedule/list/revoke (parked pending with no edge
 * connected), and the WS-backed command/logs routes returning 503 when the node
 * is offline.
 *
 * EdgeModule is imported ALONGSIDE AppModule here so the suite is green before
 * the lead wires EdgeModule into AppModule; once it is, Nest dedupes the module
 * (single instance) so this keeps passing unchanged.
 */
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../src/app.module';
import { EdgeModule } from '../src/modules/edge/edge.module';
import { createTmpDataDir } from './helpers';
import { signJwt } from '../src/shared/auth/jwt.util';

const P = '/api/v1';
const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
const TOKEN = 'e2e-edge-cluster-token';

function adminBearer(): string {
  return `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;
}

describe('edge (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  const auth = adminBearer();
  const req = (): TestAgent => request(app.getHttpServer());

  beforeAll(async () => {
    dataDir = createTmpDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.STREAMHUB_JWT_SECRET = JWT_SECRET;
    process.env.STREAMHUB_CLUSTER_TOKEN = TOKEN; // origin self-registers

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, EdgeModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    try {
      const fs = await import('fs');
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // ---- nodes ---------------------------------------------------------------
  it('GET /edge/nodes requires auth (401 anonymous)', async () => {
    await req().get(`${P}/edge/nodes`).expect(401);
  });

  it('GET /edge/nodes lists nodes (incl. the self-registered origin) for a superadmin', async () => {
    const res = await req().get(`${P}/edge/nodes`).set('Authorization', auth).expect(200);
    expect(res.body.error).toBeNull();
    expect(Array.isArray(res.body.data)).toBe(true);
    const origin = res.body.data.find((n: { id: string }) => n.id === 'origin');
    expect(origin).toBeDefined();
    expect(origin).toHaveProperty('connected');
    expect(origin).toHaveProperty('weight');
    expect(origin).toHaveProperty('stats');
  });

  it('PATCH /edge/nodes/:id sets type + weight (200); 404 unknown; 401 anon', async () => {
    const res = await req()
      .patch(`${P}/edge/nodes/origin`)
      .set('Authorization', auth)
      .send({ type: 'edge', weight: 50 })
      .expect(200);
    expect(res.body.data.type).toBe('edge');
    expect(res.body.data.weight).toBe(50);

    await req()
      .patch(`${P}/edge/nodes/does-not-exist`)
      .set('Authorization', auth)
      .send({ weight: 10 })
      .expect(404);

    await req().patch(`${P}/edge/nodes/origin`).send({ weight: 10 }).expect(401);
  });

  it('PATCH /edge/nodes/:id 400 on an out-of-enum type (real ValidationPipe)', async () => {
    await req()
      .patch(`${P}/edge/nodes/origin`)
      .set('Authorization', auth)
      .send({ type: 'bogus' })
      .expect(400);
  });

  // ---- assignments ---------------------------------------------------------
  it('POST /edge/assignments requires auth (401 anonymous)', async () => {
    await req().post(`${P}/edge/assignments`).send({ app: 'live', pluginId: 'refapp' }).expect(401);
  });

  it('POST /edge/assignments 400 on an invalid app slug', async () => {
    await req()
      .post(`${P}/edge/assignments`)
      .set('Authorization', auth)
      .send({ app: 'bad slug!', pluginId: 'refapp' })
      .expect(400);
  });

  let assignmentId = '';
  it('POST /edge/assignments parks the assignment pending (no edge connected)', async () => {
    const res = await req()
      .post(`${P}/edge/assignments`)
      .set('Authorization', auth)
      .send({ app: 'live', pluginId: 'refapp', config: { conf: 0.4 } })
      .expect(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.app).toBe('live');
    assignmentId = res.body.data.id;
    expect(typeof assignmentId).toBe('string');
  });

  it('GET /edge/assignments?app=live includes the new assignment', async () => {
    const res = await req()
      .get(`${P}/edge/assignments`)
      .query({ app: 'live' })
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.data.some((a: { id: string }) => a.id === assignmentId)).toBe(true);
  });

  it('DELETE /edge/assignments/:id revokes it; 404 for an unknown id', async () => {
    const res = await req()
      .delete(`${P}/edge/assignments/${assignmentId}`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.data).toEqual({ id: assignmentId, revoked: true });

    await req()
      .delete(`${P}/edge/assignments/does-not-exist`)
      .set('Authorization', auth)
      .expect(404);
  });

  // ---- WS-backed routes (no node connected → 503) --------------------------
  it('POST /edge/nodes/:id/command 503 when the node is not connected; 401 anon', async () => {
    await req()
      .post(`${P}/edge/nodes/origin/command`)
      .set('Authorization', auth)
      .send({ command: 'ping' })
      .expect(503);

    await req().post(`${P}/edge/nodes/origin/command`).send({ command: 'ping' }).expect(401);
  });

  it('GET /edge/nodes/:id/logs 503 when the node is not connected', async () => {
    await req()
      .get(`${P}/edge/nodes/origin/logs`)
      .query({ lines: 50 })
      .set('Authorization', auth)
      .expect(503);
  });
});
