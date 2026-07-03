/**
 * StreamHub-core test harness — shared helpers (scaffolder-owned).
 *
 * Import everything from here:
 *   import { makeUnitContext, bootstrapTestApp, mockLiveKitService } from '../../test/helpers';
 *
 * - test-db        : isolated temp DATA_DIR + migrated SQLite (createTestDb, makeTestConfig)
 * - service-mocks  : jest-fn fakes of the cross-module contracts (LiveKit/S3/...)
 * - service-factory: makeUnitContext() — real DB + all mocks, for unit specs
 * - e2e-app        : bootstrapTestApp() — full AppModule over supertest
 */
export * from './test-db';
export * from './service-mocks';
export * from './service-factory';
export * from './e2e-app';
