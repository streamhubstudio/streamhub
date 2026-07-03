/**
 * Unit — tenancy/TenancyService (multi-tenant control-plane).
 *
 * Covers the CRUD + lookup surface the auth guard depends on (users,
 * teams/tenants, memberships, quotas) and the idempotent boot "migration
 * finisher" (onModuleInit): platform tenant, admin mirroring, and the
 * users.password_hash/status column adds.
 *
 * Owned by: auth-tenancy test agent.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { PLATFORM_TENANT_ID } from '../../shared/auth-context';
import { TenancyService } from './tenancy.service';

function make(overrides: Record<string, string> = {}): {
  ctx: UnitContext;
  tenancy: TenancyService;
} {
  const ctx = makeUnitContext({ ADMIN_USER: '', ADMIN_PASS: '', ...overrides });
  const tenancy = ctx.newService(TenancyService, ctx.db, ctx.config);
  return { ctx, tenancy };
}

describe('tenancy/TenancyService', () => {
  // ===========================================================================
  // Boot: idempotent migration finisher
  // ===========================================================================
  describe('onModuleInit bootstrap', () => {
    it('ensures the platform tenant + an effectively-unlimited quota', () => {
      const { ctx, tenancy } = make();
      tenancy.onModuleInit();
      const tenant = tenancy.getTenant(PLATFORM_TENANT_ID);
      expect(tenant).toMatchObject({ id: PLATFORM_TENANT_ID, plan: 'platform' });
      const quota = tenancy.getQuota(PLATFORM_TENANT_ID)!;
      expect(quota.max_apps).toBeGreaterThanOrEqual(100000);
      ctx.cleanup();
    });

    it('adds users.password_hash and users.status columns (idempotently)', () => {
      const { ctx, tenancy } = make();
      tenancy.onModuleInit();
      const cols = (
        ctx.db.global().prepare('PRAGMA table_info(users)').all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['password_hash', 'status']));
      // Second run must not throw (idempotent).
      expect(() => tenancy.onModuleInit()).not.toThrow();
      ctx.cleanup();
    });

    it('mirrors the break-glass ADMIN_USER as a superadmin owner of platform', () => {
      const { ctx, tenancy } = make({ ADMIN_USER: 'root@corp.com' });
      tenancy.onModuleInit();
      const admin = tenancy.getUser(TenancyService.ADMIN_USER_ID)!;
      expect(admin).toMatchObject({ email: 'root@corp.com', is_superadmin: 1 });
      expect(tenancy.isSuperadmin(TenancyService.ADMIN_USER_ID)).toBe(true);
      expect(
        tenancy.roleInTenant(TenancyService.ADMIN_USER_ID, PLATFORM_TENANT_ID),
      ).toBe('owner');
      ctx.cleanup();
    });

    it('does NOT create an admin user when ADMIN_USER is unset', () => {
      const { ctx, tenancy } = make();
      tenancy.onModuleInit();
      expect(tenancy.getUser(TenancyService.ADMIN_USER_ID)).toBeNull();
      ctx.cleanup();
    });

    it('never throws out of onModuleInit even if seeding hiccups', () => {
      const { ctx, tenancy } = make({ ADMIN_USER: 'root@corp.com' });
      expect(() => tenancy.onModuleInit()).not.toThrow();
      ctx.cleanup();
    });
  });

  // ===========================================================================
  // Users
  // ===========================================================================
  describe('users', () => {
    let ctx: UnitContext;
    let tenancy: TenancyService;
    beforeEach(() => {
      ({ ctx, tenancy } = make());
      tenancy.onModuleInit();
    });
    afterEach(() => ctx.cleanup());

    it('creates a user with a stable usr_ id and looks it up', () => {
      const id = tenancy.createUser({
        email: 'a@b.com',
        passwordHash: 'scrypt$…',
        status: 'active',
      });
      expect(id).toMatch(/^usr_/);
      expect(tenancy.getUser(id)).toMatchObject({ email: 'a@b.com', status: 'active' });
    });

    it('getUserByEmail is case-insensitive', () => {
      tenancy.createUser({ email: 'Mixed@Case.com' });
      expect(tenancy.getUserByEmail('mixed@case.com')).not.toBeNull();
      expect(tenancy.getUserByEmail('MIXED@CASE.COM')).not.toBeNull();
    });

    it('returns null for unknown user/email', () => {
      expect(tenancy.getUser('usr_nope')).toBeNull();
      expect(tenancy.getUserByEmail('nobody@x.com')).toBeNull();
    });

    it('setPassword stores the hash and flips status to active', () => {
      const id = tenancy.createUser({ email: 'p@x.com', status: 'pending' });
      tenancy.setPassword(id, 'scrypt$new');
      const u = tenancy.getUser(id)!;
      expect(u.password_hash).toBe('scrypt$new');
      expect(u.status).toBe('active');
    });

    it('ensureUser is an idempotent upsert that preserves email', () => {
      tenancy.ensureUser('usr_fixed', 'first@x.com');
      tenancy.ensureUser('usr_fixed'); // no email → keep existing
      expect(tenancy.getUser('usr_fixed')!.email).toBe('first@x.com');
    });
  });

  // ===========================================================================
  // Teams / tenants / quotas
  // ===========================================================================
  describe('teams & quotas', () => {
    let ctx: UnitContext;
    let tenancy: TenancyService;
    beforeEach(() => {
      ({ ctx, tenancy } = make());
      tenancy.onModuleInit();
    });
    afterEach(() => ctx.cleanup());

    it('createTeam mints a tnt_ id and seeds a free-plan quota', () => {
      const id = tenancy.createTeam('Acme');
      expect(id).toMatch(/^tnt_/);
      expect(tenancy.getTenant(id)).toMatchObject({ name: 'Acme', plan: 'free' });
      expect(tenancy.getQuota(id)).toMatchObject({
        max_apps: 2,
        max_concurrent_streams: 2,
        max_recording_minutes_month: 300,
      });
    });

    it('ensureTenant is idempotent (no duplicate / overwrite)', () => {
      tenancy.ensureTenant('tnt_a', 'First', 'pro');
      tenancy.ensureTenant('tnt_a', 'Second', 'free'); // ignored
      expect(tenancy.getTenant('tnt_a')).toMatchObject({ name: 'First', plan: 'pro' });
    });

    it('getTenant / getQuota return null for unknown ids', () => {
      expect(tenancy.getTenant('tnt_ghost')).toBeNull();
      expect(tenancy.getQuota('tnt_ghost')).toBeNull();
    });
  });

  // ===========================================================================
  // Memberships
  // ===========================================================================
  describe('memberships', () => {
    let ctx: UnitContext;
    let tenancy: TenancyService;
    let userId: string;
    let tenantId: string;
    beforeEach(() => {
      ({ ctx, tenancy } = make());
      tenancy.onModuleInit();
      userId = tenancy.createUser({ email: 'm@x.com' });
      tenantId = tenancy.createTeam('Team');
    });
    afterEach(() => ctx.cleanup());

    it('addMembership sets the role and roleInTenant reads it back', () => {
      tenancy.addMembership(userId, tenantId, 'editor');
      expect(tenancy.roleInTenant(userId, tenantId)).toBe('editor');
    });

    it('addMembership is idempotent and upgrades the role on conflict', () => {
      tenancy.addMembership(userId, tenantId, 'viewer');
      tenancy.addMembership(userId, tenantId, 'owner'); // same (user,tenant) → update
      expect(tenancy.roleInTenant(userId, tenantId)).toBe('owner');
      expect(tenancy.listMembers(tenantId)).toHaveLength(1);
    });

    it('roleInTenant returns null for a non-member', () => {
      expect(tenancy.roleInTenant(userId, tenantId)).toBeNull();
    });

    it('primaryMembership prefers the owner team over other memberships', () => {
      const viewerTeam = tenancy.createTeam('Viewer Team');
      const ownerTeam = tenancy.createTeam('Owner Team');
      tenancy.addMembership(userId, viewerTeam, 'viewer');
      tenancy.addMembership(userId, ownerTeam, 'owner');
      expect(tenancy.primaryMembership(userId)).toEqual({
        tenantId: ownerTeam,
        role: 'owner',
      });
    });

    it('primaryMembership returns null when the user belongs to no team', () => {
      expect(tenancy.primaryMembership(userId)).toBeNull();
    });

    it('listMembers flattens membership + user, oldest first', () => {
      const u2 = tenancy.createUser({ email: 'second@x.com' });
      tenancy.addMembership(userId, tenantId, 'owner');
      tenancy.addMembership(u2, tenantId, 'viewer');
      const members = tenancy.listMembers(tenantId);
      expect(members.map((m) => m.email)).toEqual(['m@x.com', 'second@x.com']);
      expect(members[0]).toMatchObject({ role: 'owner', status: 'active', isSuperadmin: false });
    });
  });

  // ===========================================================================
  // App → tenant lookups
  // ===========================================================================
  describe('app → tenant lookups', () => {
    let ctx: UnitContext;
    let tenancy: TenancyService;
    beforeEach(() => {
      ({ ctx, tenancy } = make());
      tenancy.onModuleInit();
    });
    afterEach(() => ctx.cleanup());

    it('tenantForApp / tenantForAppId resolve an app to its tenant', () => {
      const res = ctx.db
        .global()
        .prepare('INSERT INTO apps (name, tenant_id) VALUES (?, ?)')
        .run('shop', 'tnt_shop');
      const appId = Number(res.lastInsertRowid);
      expect(tenancy.tenantForApp('shop')).toBe('tnt_shop');
      expect(tenancy.tenantForAppId(appId)).toBe('tnt_shop');
    });

    it('return null for an unknown app', () => {
      expect(tenancy.tenantForApp('ghost')).toBeNull();
      expect(tenancy.tenantForAppId(4242)).toBeNull();
    });
  });
});
