/**
 * StreamHub-core Jest config (test HARNESS — scaffolder-owned).
 *
 * Runs both unit specs (`*.spec.ts`, next to the code under src/) and e2e specs
 * (`*.e2e-spec.ts`, under test/). ts-jest transpiles TS using the project
 * tsconfig (decorators + emitDecoratorMetadata are already on there).
 *
 * External infra is kept OUT of the process:
 *  - `bullmq` / `ioredis` are hard-mapped to in-memory fakes in test/helpers/mocks
 *    so importing the RecordingService (which opens a BullMQ queue+worker on
 *    onModuleInit) never dials Redis.
 *  - LiveKit and S3 are NOT globally mapped — they only touch the network when a
 *    request actually calls them. Suites mock them per-service via the factories
 *    in test/helpers (see makeUnitContext / e2e overrides).
 *
 * `forceExit` is a safety net: nestjs-pino's pretty transport (dev/test) and
 * better-sqlite3 can leave a worker/handle open; the harness still exits clean.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '\\.(spec|e2e-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],

  // Default env (STREAMHUB_JWT_SECRET dummy, AUTHZ=log, no OIDC, tmp DATA_DIR).
  // Runs before the test module graph is required, so ConfigService / AppModule
  // observe test values.
  setupFiles: ['<rootDir>/test/helpers/env.ts'],

  // Keep Redis/BullMQ out of the process (see header).
  moduleNameMapper: {
    '^bullmq$': '<rootDir>/test/helpers/mocks/bullmq.ts',
    '^ioredis$': '<rootDir>/test/helpers/mocks/ioredis.ts',
  },

  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }],
  },

  testTimeout: 30000,
  forceExit: true,
  clearMocks: true,

  // Coverage (`npm run test:cov`).
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/dto/**',
    '!src/main.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'lcov'],
};
