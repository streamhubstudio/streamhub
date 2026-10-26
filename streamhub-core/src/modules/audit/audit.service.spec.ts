/**
 * Unit — audit/AuditService (append-only security audit trail, ISO 8.15/8.16).
 *
 * Invariants locked down:
 *  - idempotent schema bootstrap on the GLOBAL DB (mirrors ip_rules),
 *  - record() persists {actor, action, target, tenant, ip, result, meta, ts},
 *  - the table is APPEND-ONLY: direct UPDATE/DELETE raise (SQLite triggers) —
 *    there is deliberately no update/delete API on the service,
 *  - hash chain: each row links to its predecessor; verifyChain() detects a
 *    tampered row (brokenAt),
 *  - query(): action prefix / actor / result / date filters + pagination with
 *    total, newest first, limit clamped to 500,
 *  - record() NEVER throws (unserializable meta degrades gracefully),
 *  - retention: purgeExpired() removes rows older than
 *    STREAMHUB_AUDIT_RETENTION_DAYS (default 90; 0 = keep forever) and leaves
 *    the delete guard in place afterwards.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AuditService } from './audit.service';

const RETENTION_ENV = 'STREAMHUB_AUDIT_RETENTION_DAYS';

describe('audit/AuditService', () => {
  let ctx: UnitContext;
  let audit: AuditService;
  const originalRetention = process.env[RETENTION_ENV];

  beforeEach(() => {
    delete process.env[RETENTION_ENV];
    ctx = makeUnitContext();
    audit = ctx.newService(AuditService, ctx.config, ctx.db);
    audit.onModuleInit();
  });

  afterEach(() => {
    audit.onModuleDestroy();
    ctx.cleanup();
    if (originalRetention === undefined) delete process.env[RETENTION_ENV];
    else process.env[RETENTION_ENV] = originalRetention;
  });

  it('bootstraps idempotently (onModuleInit twice is harmless)', () => {
    expect(() => audit.onModuleInit()).not.toThrow();
    expect(audit.count()).toBe(0);
  });

  describe('record()', () => {
    it('persists actor, action, target, tenant, ip, result and meta', () => {
      audit.record({
        action: 'token.create',
        actorType: 'admin',
        actorId: 'admin',
        tenantId: 'platform',
        targetType: 'token',
        targetId: '7',
        ip: '203.0.113.9',
        result: 'success',
        meta: { name: 'ci', scope: 'global' },
      });
      const { entries, total } = audit.query();
      expect(total).toBe(1);
      expect(entries[0]).toMatchObject({
        action: 'token.create',
        actorType: 'admin',
        actorId: 'admin',
        tenantId: 'platform',
        targetType: 'token',
        targetId: '7',
        ip: '203.0.113.9',
        result: 'success',
        meta: { name: 'ci', scope: 'global' },
      });
      expect(entries[0].ts).toBeTruthy();
    });

    it('defaults: actorType system, result success, nullable fields null', () => {
      audit.record({ action: 'system.boot' });
      const { entries } = audit.query();
      expect(entries[0]).toMatchObject({
        action: 'system.boot',
        actorType: 'system',
        actorId: null,
        tenantId: null,
        targetType: null,
        targetId: null,
        ip: null,
        result: 'success',
        meta: null,
      });
    });

    it('never throws — unserializable meta degrades to a note', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() =>
        audit.record({ action: 'x.y', meta: circular }),
      ).not.toThrow();
      expect(audit.query().entries[0].meta).toEqual({
        note: 'meta not serializable',
      });
    });
  });

  describe('append-only enforcement (the audit invariant)', () => {
    it('rejects direct UPDATE and DELETE via triggers', () => {
      audit.record({ action: 'auth.login', result: 'failure' });
      const db = ctx.db.global();
      expect(() =>
        db.prepare(`UPDATE audit_log SET action = 'forged'`).run(),
      ).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(
        /append-only/,
      );
      // The row is intact.
      expect(audit.query().entries[0].action).toBe('auth.login');
    });
  });

  describe('hash chain', () => {
    it('links each entry to its predecessor and verifies clean', () => {
      audit.record({ action: 'a.one' });
      audit.record({ action: 'a.two' });
      audit.record({ action: 'a.three' });
      const rows = ctx.db
        .global()
        .prepare('SELECT id, prev_hash, hash FROM audit_log ORDER BY id ASC')
        .all() as { id: number; prev_hash: string | null; hash: string }[];
      expect(rows[0].prev_hash).toBeNull();
      expect(rows[1].prev_hash).toBe(rows[0].hash);
      expect(rows[2].prev_hash).toBe(rows[1].hash);
      expect(audit.verifyChain()).toEqual({
        ok: true,
        checked: 3,
        brokenAt: null,
      });
    });

    it('detects tampering (verifyChain reports brokenAt)', () => {
      audit.record({ action: 'a.one' });
      audit.record({ action: 'a.two' });
      // Simulate an attacker with raw DB access bypassing the trigger.
      const db = ctx.db.global();
      db.exec('DROP TRIGGER audit_log_no_update');
      db.prepare(
        `UPDATE audit_log SET action = 'forged' WHERE action = 'a.one'`,
      ).run();
      const report = audit.verifyChain();
      expect(report.ok).toBe(false);
      expect(report.brokenAt).not.toBeNull();
    });
  });

  describe('query()', () => {
    beforeEach(() => {
      audit.record({ action: 'auth.login', actorId: 'alice', result: 'failure' });
      audit.record({ action: 'auth.login', actorId: 'bob', result: 'success' });
      audit.record({ action: 'token.create', actorId: 'alice' });
      audit.record({ action: 'authz.deny', actorId: 'bob', result: 'deny' });
    });

    it('filters by action prefix', () => {
      const { entries, total } = audit.query({ action: 'auth.' });
      expect(total).toBe(2);
      expect(entries.every((e) => e.action.startsWith('auth.'))).toBe(true);
    });

    it('filters by exact actor and by result', () => {
      expect(audit.query({ actor: 'alice' }).total).toBe(2);
      expect(audit.query({ result: 'deny' }).total).toBe(1);
      expect(audit.query({ actor: 'bob', result: 'success' }).total).toBe(1);
    });

    it('paginates newest-first with a stable total', () => {
      const page1 = audit.query({ limit: 2, offset: 0 });
      const page2 = audit.query({ limit: 2, offset: 2 });
      expect(page1.total).toBe(4);
      expect(page1.entries).toHaveLength(2);
      expect(page2.entries).toHaveLength(2);
      // Newest first: the last recorded action leads page 1.
      expect(page1.entries[0].action).toBe('authz.deny');
      expect(page1.entries[0].id).toBeGreaterThan(page2.entries[0].id);
    });

    it('clamps limit to 500 and floors offset at 0', () => {
      const out = audit.query({ limit: 99_999, offset: -5 });
      expect(out.limit).toBe(500);
      expect(out.offset).toBe(0);
    });

    it('filters by from/to ISO bounds', () => {
      const all = audit.query();
      const newestTs = all.entries[0].ts;
      expect(audit.query({ from: newestTs }).total).toBeGreaterThanOrEqual(1);
      expect(audit.query({ to: '2000-01-01T00:00:00.000Z' }).total).toBe(0);
    });
  });

  describe('retention', () => {
    it('defaults to 90 days; env override and 0=forever are honoured', () => {
      expect(audit.retentionDays).toBe(90);
      process.env[RETENTION_ENV] = '30';
      expect(audit.retentionDays).toBe(30);
      process.env[RETENTION_ENV] = '0';
      expect(audit.retentionDays).toBe(0);
      process.env[RETENTION_ENV] = 'nonsense';
      expect(audit.retentionDays).toBe(90);
    });

    it('purges rows past the window and keeps the delete guard armed', () => {
      process.env[RETENTION_ENV] = '30';
      // An old row (INSERT is allowed — only UPDATE/DELETE are guarded).
      ctx.db
        .global()
        .prepare(
          `INSERT INTO audit_log (ts, actor_type, action, result, hash)
           VALUES ('2020-01-01T00:00:00.000Z', 'system', 'old.event', 'success', 'x')`,
        )
        .run();
      audit.record({ action: 'new.event' });
      expect(audit.count()).toBe(2);

      expect(audit.purgeExpired()).toBe(1);
      expect(audit.count()).toBe(1);
      expect(audit.query().entries[0].action).toBe('new.event');
      // Guard is recreated after the pass.
      expect(() =>
        ctx.db.global().prepare('DELETE FROM audit_log').run(),
      ).toThrow(/append-only/);
    });

    it('retention 0 purges nothing', () => {
      process.env[RETENTION_ENV] = '0';
      audit.record({ action: 'keep.me' });
      expect(audit.purgeExpired()).toBe(0);
      expect(audit.count()).toBe(1);
    });
  });
});
