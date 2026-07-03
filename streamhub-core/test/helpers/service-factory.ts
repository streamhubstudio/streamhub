/**
 * Unit-test service factory (harness).
 *
 * `makeUnitContext()` gives a suite everything to exercise ONE service in
 * isolation against a real (migrated, temp) SQLite DB while every cross-module
 * collaborator and all external infra (LiveKit / Redis / S3) is a jest mock:
 *
 *   const ctx = makeUnitContext();
 *   const svc = ctx.newService(AppsService, ctx.config, ctx.db, ctx.mocks.s3, ...);
 *   ...
 *   afterEach(() => ctx.cleanup());
 *
 * `newService` is a thin `new Cls(...deps)` — you pass the ctor args in order,
 * mixing the real `config`/`db` with `ctx.mocks.*`. This keeps unit tests free
 * of the Nest DI container while still using the genuine DB schema.
 */
import { createTestDb, type TestDbContext } from './test-db';
import {
  mockAppsService,
  mockCallbacksService,
  mockLiveKitService,
  mockLogsService,
  mockRecordingService,
  mockS3Service,
  mockSamplesService,
  mockStreamsService,
} from './service-mocks';

export interface UnitContext extends TestDbContext {
  /** Ready-to-use jest mocks for every cross-module contract. */
  mocks: {
    livekit: ReturnType<typeof mockLiveKitService>;
    s3: ReturnType<typeof mockS3Service>;
    logs: ReturnType<typeof mockLogsService>;
    callbacks: ReturnType<typeof mockCallbacksService>;
    apps: ReturnType<typeof mockAppsService>;
    streams: ReturnType<typeof mockStreamsService>;
    samples: ReturnType<typeof mockSamplesService>;
    recording: ReturnType<typeof mockRecordingService>;
  };
  /** `new Cls(...deps)` — instantiate a service with hand-picked ctor args. */
  newService: <T, A extends unknown[]>(
    Cls: new (...args: A) => T,
    ...deps: A
  ) => T;
}

/**
 * Build an isolated unit-test context: temp DB + fresh config + a full set of
 * contract mocks. `overrides` pin extra env for the ConfigService (same keys as
 * makeTestConfig, e.g. LIVEKIT_URL, STREAMHUB_AUTHZ_ENFORCE).
 */
export function makeUnitContext(
  overrides: Record<string, string> = {},
): UnitContext {
  const dbCtx = createTestDb(overrides);
  return {
    ...dbCtx,
    mocks: {
      livekit: mockLiveKitService(),
      s3: mockS3Service(),
      logs: mockLogsService(),
      callbacks: mockCallbacksService(),
      apps: mockAppsService(),
      streams: mockStreamsService(),
      samples: mockSamplesService(),
      recording: mockRecordingService(),
    },
    newService: (Cls, ...deps) => new Cls(...deps),
  };
}
