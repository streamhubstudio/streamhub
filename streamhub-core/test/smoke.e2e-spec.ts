/**
 * Harness smoke test. Validates that the e2e helper boots the real AppModule and
 * that the isolated-DB helper produces a migrated schema. If this passes, the
 * harness (jest config + helpers + mocks) is wired correctly. Module specs are
 * owned by other agents.
 */
import { bootstrapTestApp, createTestDb, type TestApp } from './helpers';

describe('harness smoke', () => {
  describe('e2e — GET /api/v1/health', () => {
    let ctx: TestApp;

    beforeAll(async () => {
      ctx = await bootstrapTestApp();
    });

    afterAll(async () => {
      await ctx?.close();
    });

    it('returns 200 and up:true (public, no auth)', async () => {
      const res = await ctx.request().get('/api/v1/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', up: true });
      expect(typeof res.body.version).toBe('string');
      expect(typeof res.body.ts).toBe('string');
    });
  });

  describe('isolated DB helper', () => {
    it('opens a fresh, migrated streamhub.db per suite', () => {
      const db = createTestDb();
      try {
        const tables = db.db
          .global()
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all() as { name: string }[];
        // Migrations ran → the core `apps` table exists.
        expect(tables.some((t) => t.name === 'apps')).toBe(true);
      } finally {
        db.cleanup();
      }
    });
  });
});
