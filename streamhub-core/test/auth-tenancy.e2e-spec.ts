/**
 * E2E — auth-tenancy over the real AppModule (supertest).
 *
 * Boots the full app (global guard + permission guard wired) against an isolated
 * temp DB and drives the HTTP surface:
 *   - POST /auth/signup, /auth/login, GET /auth/me (user_jwt, admin_jwt, sk_)
 *   - /tokens CRUD + Bearer enforcement (401 without a token)
 *   - GET /teams/mine, POST /teams/mine/members, GET /tenants/:id/usage
 *   - the CRITICAL invariant: a global sk_ token and the admin JWT are NEVER
 *     blocked, even with STREAMHUB_AUTHZ_ENFORCE=on.
 *
 * Owned by: auth-tenancy test agent.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';

const P = '/api/v1';

/** Extract the JWT from a login/signup envelope. */
function tokenOf(body: { data?: { token?: string } }): string {
  const t = body?.data?.token;
  if (!t) throw new Error(`no token in response: ${JSON.stringify(body)}`);
  return t;
}

describe('auth-tenancy (e2e)', () => {
  // ===========================================================================
  // signup / login / me  — default env (no admin, AUTHZ=log)
  // ===========================================================================
  describe('signup, login, /auth/me', () => {
    let app: TestApp;
    beforeAll(async () => {
      app = await bootstrapTestApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    it('signs up a new user + team and returns a JWT (201)', async () => {
      const res = await app
        .request()
        .post(`${P}/auth/signup`)
        .send({ email: 'alice@example.com', password: 'passw0rd-strong', teamName: 'Acme' })
        .expect(201);
      expect(tokenOf(res.body)).toMatch(/\..+\./); // looks like a JWT
    });

    it('rejects signup with a short password (ValidationPipe, 400)', async () => {
      await app
        .request()
        .post(`${P}/auth/signup`)
        .send({ email: 'x@y.com', password: 'short' })
        .expect(400);
    });

    it('rejects a duplicate signup (400)', async () => {
      await app
        .request()
        .post(`${P}/auth/signup`)
        .send({ email: 'alice@example.com', password: 'passw0rd-strong' })
        .expect(400);
    });

    it('logs in the user (200) and /auth/me reflects their tenant + role', async () => {
      const login = await app
        .request()
        .post(`${P}/auth/login`)
        .send({ user: 'alice@example.com', password: 'passw0rd-strong' })
        .expect(200);
      const jwt = tokenOf(login.body);

      const me = await app
        .request()
        .get(`${P}/auth/me`)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(me.body.data).toMatchObject({
        via: 'user_jwt',
        role: 'owner',
        isSuperadmin: false,
        scope: 'user',
        email: 'alice@example.com',
      });
      expect(me.body.data.tenantId).toMatch(/^tnt_/);
    });

    it('rejects login with a wrong password (401)', async () => {
      await app
        .request()
        .post(`${P}/auth/login`)
        .send({ user: 'alice@example.com', password: 'nope' })
        .expect(401);
    });

    it('rejects a protected route with no Bearer token (401)', async () => {
      await app.request().get(`${P}/auth/me`).expect(401);
      await app.request().get(`${P}/tokens`).expect(401);
    });

    it('rejects a garbage Bearer token (401)', async () => {
      await app
        .request()
        .get(`${P}/tokens`)
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });
  });

  // ===========================================================================
  // /tokens CRUD + sk_ back-compat (a global token authenticates like superadmin)
  // ===========================================================================
  describe('API tokens (/tokens) + sk_ back-compat', () => {
    let app: TestApp;
    let sk: string;
    beforeAll(async () => {
      app = await bootstrapTestApp();
      // Mint a real global token via the service (its plaintext is shown once).
      const created = await app.app
        .get(AuthService)
        .createToken({ name: 'ci', scope: 'global' });
      sk = created.token;
    });
    afterAll(async () => {
      await app?.close();
    });

    it('a global sk_ token authenticates and /auth/me marks it superadmin/global', async () => {
      const me = await app
        .request()
        .get(`${P}/auth/me`)
        .set('Authorization', `Bearer ${sk}`)
        .expect(200);
      expect(me.body.data).toMatchObject({
        via: 'api_token',
        role: 'service',
        isSuperadmin: true,
        scope: 'global',
        tenantId: 'platform',
      });
    });

    it('lists tokens without leaking the hash', async () => {
      const res = await app
        .request()
        .get(`${P}/tokens`)
        .set('Authorization', `Bearer ${sk}`)
        .expect(200);
      const rows = res.body?.data ?? res.body;
      const arr = Array.isArray(rows) ? rows : rows?.items ?? [];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      for (const t of arr) {
        expect(t).not.toHaveProperty('token_hash');
        expect(t).not.toHaveProperty('tokenHash');
      }
    });

    it('creates then revokes a token; the revoked token stops authenticating', async () => {
      const created = await app
        .request()
        .post(`${P}/tokens`)
        .set('Authorization', `Bearer ${sk}`)
        .send({ name: 'temp', scope: 'global' })
        .expect(201);
      const body = created.body?.data ?? created.body;
      const newToken: string = body.token;
      const id: number = body.id;
      expect(newToken.startsWith('sk_')).toBe(true);

      // works before revoke
      await app
        .request()
        .get(`${P}/auth/me`)
        .set('Authorization', `Bearer ${newToken}`)
        .expect(200);

      await app
        .request()
        .delete(`${P}/tokens/${id}`)
        .set('Authorization', `Bearer ${sk}`)
        .expect(204);

      // rejected after revoke
      await app
        .request()
        .get(`${P}/auth/me`)
        .set('Authorization', `Bearer ${newToken}`)
        .expect(401);
    });
  });

  // ===========================================================================
  // Teams + tenant usage (self-scoped)
  // ===========================================================================
  describe('teams & tenant usage', () => {
    let app: TestApp;
    let ownerJwt: string;
    let tenantId: string;
    beforeAll(async () => {
      app = await bootstrapTestApp();
      const signup = await app
        .request()
        .post(`${P}/auth/signup`)
        .send({ email: 'owner@team.com', password: 'passw0rd-strong', teamName: 'Team' })
        .expect(201);
      ownerJwt = tokenOf(signup.body);
      const me = await app
        .request()
        .get(`${P}/auth/me`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(200);
      tenantId = me.body.data.tenantId;
    });
    afterAll(async () => {
      await app?.close();
    });

    it('GET /teams/mine returns the caller team, members and usage', async () => {
      const res = await app
        .request()
        .get(`${P}/teams/mine`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(200);
      const data = res.body.data;
      expect(data.team).toMatchObject({ id: tenantId, name: 'Team' });
      expect(data.members.map((m: { email: string }) => m.email)).toContain(
        'owner@team.com',
      );
      expect(data.usage).toMatchObject({ tenantId, quotas: { maxApps: 2 } });
    });

    it('an owner can invite a member (pending user created + attached)', async () => {
      const res = await app
        .request()
        .post(`${P}/teams/mine/members`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .send({ email: 'newbie@team.com', role: 'editor' })
        .expect(201);
      expect(res.body.data).toMatchObject({
        email: 'newbie@team.com',
        role: 'editor',
        status: 'pending',
      });
    });

    it('a viewer cannot invite members (403, enforced regardless of the flag)', async () => {
      // Sign up a separate viewer-less user, then demote… simplest: a brand-new
      // owner of another team is still owner, so instead invite a viewer into
      // THIS team and act as them.
      await app
        .request()
        .post(`${P}/teams/mine/members`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .send({ email: 'viewer@team.com', role: 'viewer' })
        .expect(201);
      // viewer completes signup (same email) → gets a JWT; but signup makes them
      // an owner of a NEW team only if they had no membership. They DO have one
      // (viewer), so they stay a viewer of this team.
      const vsignup = await app
        .request()
        .post(`${P}/auth/signup`)
        .send({ email: 'viewer@team.com', password: 'passw0rd-strong' })
        .expect(201);
      const viewerJwt = tokenOf(vsignup.body);
      await app
        .request()
        .post(`${P}/teams/mine/members`)
        .set('Authorization', `Bearer ${viewerJwt}`)
        .send({ email: 'someone@else.com', role: 'viewer' })
        .expect(403);
    });

    it('GET /tenants/:id/usage — a user may read only its OWN tenant (403 cross-tenant)', async () => {
      await app
        .request()
        .get(`${P}/tenants/${tenantId}/usage`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(200);
      await app
        .request()
        .get(`${P}/tenants/tnt_someone_else/usage`)
        .set('Authorization', `Bearer ${ownerJwt}`)
        .expect(403);
    });
  });

  // ===========================================================================
  // CRITICAL INVARIANT — never lock out the platform owner (enforce=on)
  // ===========================================================================
  describe('INVARIANT: sk_ token and admin JWT are never blocked (AUTHZ=on)', () => {
    let app: TestApp;
    let sk: string;
    let adminJwt: string;
    const prevEnforce = process.env.STREAMHUB_AUTHZ_ENFORCE;
    const prevUser = process.env.ADMIN_USER;
    const prevPass = process.env.ADMIN_PASS;

    beforeAll(async () => {
      app = await bootstrapTestApp({
        env: {
          STREAMHUB_AUTHZ_ENFORCE: 'on',
          ADMIN_USER: 'root@corp.com',
          ADMIN_PASS: 'break-glass',
        },
      });
      sk = (
        await app.app.get(AuthService).createToken({ name: 'ci', scope: 'global' })
      ).token;
      const login = await app
        .request()
        .post(`${P}/auth/login`)
        .send({ user: 'root@corp.com', password: 'break-glass' })
        .expect(200);
      adminJwt = tokenOf(login.body);
    });
    afterAll(async () => {
      await app?.close();
      // restore env for other suites in this worker
      const restore = (k: string, v: string | undefined): void => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore('STREAMHUB_AUTHZ_ENFORCE', prevEnforce);
      restore('ADMIN_USER', prevUser);
      restore('ADMIN_PASS', prevPass);
    });

    it('the admin JWT resolves to a superadmin context', async () => {
      const me = await app
        .request()
        .get(`${P}/auth/me`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
      expect(me.body.data).toMatchObject({
        via: 'admin_jwt',
        isSuperadmin: true,
        role: 'superadmin',
      });
    });

    it('sk_ token reaches a @RequirePermission route (usage:read) — NOT 403', async () => {
      // Any tenant id: the global token bypasses both RBAC and tenant scope.
      await app
        .request()
        .get(`${P}/tenants/any_tenant/usage`)
        .set('Authorization', `Bearer ${sk}`)
        .expect(200);
    });

    it('admin JWT reaches a @RequirePermission route (usage:read) — NOT 403', async () => {
      await app
        .request()
        .get(`${P}/tenants/any_tenant/usage`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('admin JWT can read /teams/mine on the platform tenant', async () => {
      await app
        .request()
        .get(`${P}/teams/mine`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });
  });
});
