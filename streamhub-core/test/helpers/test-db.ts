/**
 * Isolated test DB + config (harness).
 *
 * Each suite gets its OWN temp DATA_DIR (mkdtemp) so its `data/streamhub.db`
 * (and any per-app `apps/<name>/vods.db`) is a fresh, migrated, throwaway
 * SQLite file — no shared state between suites, nothing touching the real
 * DATA_DIR. `DbService` runs its numbered migrations on first open, so the
 * schema is real (not a hand-rolled fixture).
 *
 * Usage:
 *   const ctx = createTestDb();
 *   const gdb = ctx.db.global();        // migrated data/streamhub.db
 *   ...
 *   afterAll(() => ctx.cleanup());
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConfigService } from '../../src/shared/config/config.service';
import { DbService } from '../../src/shared/db/db.service';

export interface TestDbContext {
  /** The ConfigService pinned to this suite's temp DATA_DIR. */
  config: ConfigService;
  /** A DbService already opened + migrated against the temp DATA_DIR. */
  db: DbService;
  /** Absolute path of the temp DATA_DIR. */
  dataDir: string;
  /** Close DB handles and remove the temp dir. Call in afterAll/afterEach. */
  cleanup: () => void;
}

/** Create a unique temp DATA_DIR under the OS tmp dir. */
export function createTmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-test-'));
}

/**
 * Build a ConfigService bound to a temp DATA_DIR (created if not supplied).
 * `overrides` are written to process.env before construction so any config
 * field can be pinned for a suite (e.g. LIVEKIT_URL, STREAMHUB_AUTHZ_ENFORCE).
 * Returns the config plus the dataDir it was pinned to.
 */
export function makeTestConfig(
  overrides: Record<string, string> = {},
): { config: ConfigService; dataDir: string } {
  const dataDir = overrides.DATA_DIR ?? createTmpDataDir();
  process.env.DATA_DIR = dataDir;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  // ConfigService snapshots process.env in its constructor.
  return { config: new ConfigService(), dataDir };
}

/**
 * Create an isolated, migrated DbService over a fresh temp DATA_DIR.
 * Pass `overrides` to pin extra env for the ConfigService the DB reads.
 */
export function createTestDb(
  overrides: Record<string, string> = {},
): TestDbContext {
  const { config, dataDir } = makeTestConfig(overrides);
  const db = new DbService(config);
  // Trigger open + migrations now so the schema is ready and failures surface
  // at setup rather than mid-test.
  db.onModuleInit();

  const cleanup = (): void => {
    try {
      db.onModuleDestroy();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  return { config, db, dataDir, cleanup };
}
