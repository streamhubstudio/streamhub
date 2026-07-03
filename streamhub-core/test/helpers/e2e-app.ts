/**
 * E2E app harness (supertest).
 *
 * `bootstrapTestApp()` boots the FULL AppModule the same way main.ts does
 * (global prefix `api/v1` + the whitelisting ValidationPipe) but:
 *   - against a fresh temp DATA_DIR (isolated streamhub.db, auto-seeded `live`
 *     app + samples);
 *   - with the test env from setupFiles (dummy STREAMHUB_JWT_SECRET,
 *     STREAMHUB_AUTHZ_ENFORCE=log, no OIDC, empty LiveKit creds);
 *   - with BullMQ/Redis mocked out (jest moduleNameMapper), so RecordingService
 *     boots without a broker.
 *
 * LiveKit/S3 are only hit when a request actually calls them; override those
 * providers via `opts.overrides` when a spec drives such an endpoint, e.g.:
 *
 *   const ctx = await bootstrapTestApp({
 *     overrides: (b) => b
 *       .overrideProvider(LIVEKIT_SERVICE).useValue(mockLiveKitService())
 *       .overrideProvider(S3_SERVICE).useValue(mockS3Service()),
 *   });
 *   await ctx.request().get('/api/v1/health').expect(200);
 *   await ctx.close();
 *
 * `request()` returns a supertest instance bound to the running HTTP server (no
 * TCP port is opened — app.init(), not app.listen()). Note the `api/v1` prefix
 * is NOT added for you; include it in the path.
 */
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';

import { AppModule } from '../../src/app.module';
import { ConfigService } from '../../src/shared/config/config.service';
import { createTmpDataDir } from './test-db';

export const API_PREFIX = 'api/v1';

export interface BootstrapOptions {
  /** Extra env pinned before the module compiles (ConfigService reads env). */
  env?: Record<string, string>;
  /** Hook to override providers on the TestingModule (LiveKit/S3/etc). */
  overrides?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface TestApp {
  app: INestApplication;
  config: ConfigService;
  dataDir: string;
  /** supertest agent bound to the app's HTTP server. Prefix paths with /api/v1. */
  request: () => TestAgent;
  /** Shut the app down and remove the temp DATA_DIR. */
  close: () => Promise<void>;
}

export async function bootstrapTestApp(
  opts: BootstrapOptions = {},
): Promise<TestApp> {
  const dataDir = opts.env?.DATA_DIR ?? createTmpDataDir();
  process.env.DATA_DIR = dataDir;
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.overrides) builder = opts.overrides(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });

  // Mirror main.ts request handling so e2e behaviour matches production.
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.init();

  const config = app.get(ConfigService);

  const close = async (): Promise<void> => {
    await app.close();
    try {
      const fs = await import('fs');
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  return {
    app,
    config,
    dataDir,
    request: () => request(app.getHttpServer()),
    close,
  };
}
