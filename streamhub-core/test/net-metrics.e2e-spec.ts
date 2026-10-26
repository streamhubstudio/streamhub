/**
 * E2E spec — net-metrics controller (Wave 1C). Boots a focused Nest app with
 * the real NetMetricsController + NetMetricsService over a real migrated temp
 * SQLite (mirroring `main.ts`'s /api/v1 prefix), so the HTTP envelope, the
 * summary rollup and the threshold posture read from config.yaml are all
 * exercised end-to-end. APPS_SERVICE is a thin stub (only `appDir` is used).
 *
 * Standalone (not the full AppModule) on purpose: NetMetricsModule is wired
 * into AppModule by the lead, so this suite stays green independently of that
 * wiring. Auth guards are metadata-only here (no global guard) — the assertions
 * cover the response contract, not the RBAC layer (covered elsewhere).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { ConfigService } from '../src/shared/config/config.service';
import { DbService } from '../src/shared/db/db.service';
import { APPS_SERVICE, LOGS_SERVICE } from '../src/shared/contracts';
import { NetMetricsController } from '../src/modules/net-metrics/net-metrics.controller';
import { NetMetricsService } from '../src/modules/net-metrics/net-metrics.service';
import { makeTestConfig, mockLogsService } from './helpers';

const APP = 'live';
const GiB = 1024 ** 3;

describe('net-metrics controller (e2e)', () => {
  let app: INestApplication;
  let dataDir: string;
  let db: DbService;

  function seed(bucket: string, dir: string, source: string, bytes: number): void {
    db.appDb(APP)
      .prepare(
        `INSERT INTO net_samples (bucket, direction, source, bytes) VALUES (?,?,?,?)`,
      )
      .run(bucket, dir, source, bytes);
  }

  beforeAll(async () => {
    const cfg = makeTestConfig();
    dataDir = cfg.dataDir;
    // App config.yaml with a 4 GB network threshold.
    const appDir = path.join(dataDir, 'apps', APP);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'config.yaml'),
      yaml.dump({ name: APP, network: { threshold_gb_day: 4 } }),
    );

    const appsStub = {
      appDir: (name: string) => path.join(dataDir, 'apps', name),
      list: async () => [{ name: APP }],
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [NetMetricsController],
      providers: [
        { provide: ConfigService, useValue: cfg.config },
        DbService,
        NetMetricsService,
        { provide: APPS_SERVICE, useValue: appsStub },
        { provide: LOGS_SERVICE, useValue: mockLogsService() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    db = app.get(DbService);
    const nowBucket = new Date().toISOString().slice(0, 13);
    seed(nowBucket, 'out', 'hls', 3 * GiB); // 3 GiB egress today
    seed(nowBucket, 'in', 'mediamtx', 1 * GiB); // 1 GiB ingest today
  });

  afterAll(async () => {
    await app?.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('GET /apps/:app/net → summary envelope with windows + threshold', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/apps/${APP}/net`)
      .expect(200);

    expect(res.body).toHaveProperty('data');
    const d = res.body.data;
    expect(d.last24h).toEqual({ in: GiB, out: 3 * GiB, total: 4 * GiB });
    expect(d.threshold.gbPerDay).toBe(4);
    expect(d.threshold.thresholdBytes).toBe(4 * GiB);
    // 4 GiB used vs 4 GB cap → exactly at the limit → exceeded.
    expect(d.threshold.exceeded).toBe(true);
    expect(d.bySource).toEqual(
      expect.arrayContaining([
        { source: 'hls', in: 0, out: 3 * GiB },
        { source: 'mediamtx', in: GiB, out: 0 },
      ]),
    );
  });

  it('GET /apps/:app/net/history → bucketed rows within the window', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/apps/${APP}/net/history?hours=48`)
      .expect(200);

    expect(res.body.data.hours).toBe(48);
    expect(Array.isArray(res.body.data.buckets)).toBe(true);
    const total = res.body.data.buckets.reduce(
      (acc: number, b: { in: number; out: number }) => acc + b.in + b.out,
      0,
    );
    expect(total).toBe(4 * GiB);
  });

  it('clamps a bogus hours param to the default', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/apps/${APP}/net/history?hours=abc`)
      .expect(200);
    expect(res.body.data.hours).toBe(48);
  });
});
