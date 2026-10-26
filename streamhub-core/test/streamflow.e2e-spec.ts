/**
 * E2E specs for the Streamflow controller — HTTP envelope + auth + workflow
 * CRUD + manual run + runs listing + the box palette, over the full AppModule.
 *
 * StreamflowModule is registered in app.module.ts by the lead; to keep this
 * suite self-contained (and green whether or not that wiring has landed) it
 * bootstraps a testing module that imports BOTH AppModule and StreamflowModule.
 * Nest dedupes the module by class reference, so this stays correct after the
 * app.module.ts registration lands.
 */
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { StreamflowModule } from '../src/modules/streamflow/streamflow.module';
import { ConfigService } from '../src/shared/config/config.service';
import { signJwt } from '../src/shared/auth/jwt.util';
import { createTmpDataDir } from './helpers/test-db';

const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
const adminBearer = () => `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;

describe('streamflow controller (e2e)', () => {
  let app: INestApplication;
  let auth: string;
  const url = (p: string) => `/api/v1/apps/live/plugins/streamflow${p}`;

  beforeAll(async () => {
    const dataDir = createTmpDataDir();
    process.env.DATA_DIR = dataDir;
    process.env.STREAMHUB_JWT_SECRET = JWT_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, StreamflowModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
    );
    await app.init();
    void app.get(ConfigService);
    auth = adminBearer();
  });

  afterAll(async () => {
    await app?.close();
  });

  const req = () => request(app.getHttpServer());

  it('serves the box catalogue', async () => {
    const res = await req().get(url('/boxes')).set('Authorization', auth).expect(200);
    const types = (res.body.data as Array<{ type: string; group: string }>).map((b) => b.type);
    expect(types).toContain('trigger.event');
    expect(types).toContain('action.ai');
    expect(types).toContain('logic.condition');
  });

  it('CRUDs a workflow', async () => {
    const created = await req()
      .post(url('/workflows'))
      .set('Authorization', auth)
      .send({
        name: 'Intrusion flow',
        graph: {
          boxes: [
            { id: 't', type: 'trigger.event', config: { event: 'perimeter.intrusion' } },
            { id: 'e', type: 'action.emit', config: { event: 'streamflow.output' } },
          ],
          edges: [{ from: 't', to: 'e' }],
        },
      })
      .expect(201);
    const id = created.body.data.id as string;
    expect(created.body.data.name).toBe('Intrusion flow');
    expect(created.body.data.enabled).toBe(true);

    const list = await req().get(url('/workflows')).set('Authorization', auth).expect(200);
    expect((list.body.data as Array<{ id: string }>).some((w) => w.id === id)).toBe(true);

    const got = await req().get(url(`/workflows/${id}`)).set('Authorization', auth).expect(200);
    expect(got.body.data.graph.boxes).toHaveLength(2);

    const upd = await req()
      .put(url(`/workflows/${id}`))
      .set('Authorization', auth)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(upd.body.data.name).toBe('Renamed');

    await req()
      .post(url(`/workflows/${id}/enable`))
      .set('Authorization', auth)
      .send({ enabled: false })
      .expect(201);

    await req().delete(url(`/workflows/${id}`)).set('Authorization', auth).expect(200);
    await req().get(url(`/workflows/${id}`)).set('Authorization', auth).expect(404);
  });

  it('rejects a workflow with no name (400)', async () => {
    await req().post(url('/workflows')).set('Authorization', auth).send({}).expect(400);
  });

  it('runs a workflow manually and lists the run', async () => {
    const created = await req()
      .post(url('/workflows'))
      .set('Authorization', auth)
      .send({
        name: 'Manual',
        graph: {
          boxes: [
            { id: 'm', type: 'trigger.manual', config: {} },
            { id: 'e', type: 'action.emit', config: { event: 'streamflow.output', payload: { hi: 1 } } },
          ],
          edges: [{ from: 'm', to: 'e' }],
        },
      })
      .expect(201);
    const id = created.body.data.id as string;

    const run = await req()
      .post(url(`/workflows/${id}/run`))
      .set('Authorization', auth)
      .send({ payload: { source: 'test' } })
      .expect(201);
    const runId = run.body.data?.id as string;
    expect(runId).toBeTruthy();

    const runs = await req()
      .get(url(`/runs?workflowId=${id}`))
      .set('Authorization', auth)
      .expect(200);
    expect((runs.body.data as Array<{ id: string }>).some((r) => r.id === runId)).toBe(true);

    const detail = await req().get(url(`/runs/${runId}`)).set('Authorization', auth).expect(200);
    expect(detail.body.data.run.id).toBe(runId);
    expect(Array.isArray(detail.body.data.steps)).toBe(true);
  });

  it('404s for an unknown app', async () => {
    await req().get('/api/v1/apps/ghost/plugins/streamflow/workflows').set('Authorization', auth).expect(404);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await req().get(url('/boxes')).expect(401);
  });
});
