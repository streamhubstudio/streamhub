/**
 * E2E — Fase-0 security (M2 tenant isolation + the golden rule) over the FULL
 * AppModule with the REAL Bearer + permission guards wired (no AUTH_VALIDATOR
 * bypass), and STREAMHUB_AUTHZ_ENFORCE=on so isolation actually blocks.
 *
 * THE GOLDEN RULE under test (must NEVER regress):
 *   - a GLOBAL `sk_` token (scope:'global', isSuperadmin) reaches EVERY app;
 *   - the break-glass admin JWT (via:'admin_jwt', superadmin) reaches EVERY app.
 *
 * M2 isolation under test:
 *   - an APP-scoped `sk_` token for app A gets 403 on app B's dangerous routes
 *     (mint token, db/purge, config, s3) but 200 on its OWN app.
 *
 * Owned by: Fase-0 security agent. Touches only this *.e2e-spec.ts.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';
import { DbService } from '../src/shared/db/db.service';

const P = '/api/v1';

function tokenOf(body: { data?: { token?: string } }): string {
  const t = body?.data?.token;
  if (!t) throw new Error(`no token: ${JSON.stringify(body)}`);
  return t;
}

describe('fase0-security (e2e, AUTHZ=on)', () => {
  let app: TestApp;
  let sk: string; // global sk_ token (superadmin)
  let adminJwt: string; // break-glass admin JWT (superadmin)
  let appATokenId: string; // app-scoped sk_ token pinned to app A
  const bearer = (t: string): [string, string] => ['Authorization', `Bearer ${t}`];

  beforeAll(async () => {
    app = await bootstrapTestApp({
      env: {
        STREAMHUB_AUTHZ_ENFORCE: 'on',
        ADMIN_USER: 'root@corp.com',
        ADMIN_PASS: 'break-glass',
      },
    });

    const auth = app.app.get(AuthService);
    sk = (await auth.createToken({ name: 'global-ci', scope: 'global' })).token;

    // Two real apps (created by the superadmin sk_ token → DBs + config exist).
    for (const name of ['appa', 'appb']) {
      await app.request().post(`${P}/apps`).set(...bearer(sk)).send({ name }).expect(201);
    }
    const idOf = (name: string): number =>
      (
        app.app
          .get(DbService)
          .global()
          .prepare('SELECT id FROM apps WHERE name = ?')
          .get(name) as { id: number }
      ).id;

    // App-scoped token pinned to app A.
    appATokenId = (
      await auth.createToken({ name: 'appa-key', scope: 'app', appId: idOf('appa') })
    ).token;

    // Break-glass admin JWT.
    const login = await app
      .request()
      .post(`${P}/auth/login`)
      .send({ user: 'root@corp.com', password: 'break-glass' })
      .expect(200);
    adminJwt = tokenOf(login.body);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ===========================================================================
  // GOLDEN RULE — superadmin/global + break-glass reach EVERY app (AUTHZ=on)
  // ===========================================================================
  describe('GOLDEN RULE: superadmin/global never blocked', () => {
    it('global sk_ reads BOTH apps config (A and B) — 200', async () => {
      await app.request().get(`${P}/apps/appa/config/raw`).set(...bearer(sk)).expect(200);
      await app.request().get(`${P}/apps/appb/config/raw`).set(...bearer(sk)).expect(200);
    });

    it('global sk_ hits app B dangerous surfaces (s3 read, db health) — never 403', async () => {
      await app.request().get(`${P}/apps/appb/s3`).set(...bearer(sk)).expect(200);
      await app.request().get(`${P}/apps/appb/db/health`).set(...bearer(sk)).expect(200);
    });

    it('break-glass admin JWT reads BOTH apps config — 200', async () => {
      await app.request().get(`${P}/apps/appa/config/raw`).set(...bearer(adminJwt)).expect(200);
      await app.request().get(`${P}/apps/appb/config/raw`).set(...bearer(adminJwt)).expect(200);
    });

    it('break-glass admin JWT resolves to a superadmin context', async () => {
      const me = await app.request().get(`${P}/auth/me`).set(...bearer(adminJwt)).expect(200);
      expect(me.body.data).toMatchObject({ via: 'admin_jwt', isSuperadmin: true, role: 'superadmin' });
    });

    it('global sk_ resolves to a superadmin/global context', async () => {
      const me = await app.request().get(`${P}/auth/me`).set(...bearer(sk)).expect(200);
      expect(me.body.data).toMatchObject({ via: 'api_token', isSuperadmin: true, scope: 'global' });
    });
  });

  // ===========================================================================
  // M2 — an app-A token is confined to app A (403 on app B)
  // ===========================================================================
  describe('M2: app-scoped token confined to its own app', () => {
    it('OK on its OWN app: GET /apps/appa/config/raw — 200', async () => {
      await app.request().get(`${P}/apps/appa/config/raw`).set(...bearer(appATokenId)).expect(200);
    });

    it('403 reading ANOTHER app config: GET /apps/appb/config/raw', async () => {
      await app.request().get(`${P}/apps/appb/config/raw`).set(...bearer(appATokenId)).expect(403);
    });

    it('403 reading ANOTHER app s3: GET /apps/appb/s3', async () => {
      await app.request().get(`${P}/apps/appb/s3`).set(...bearer(appATokenId)).expect(403);
    });

    it('403 minting a token on ANOTHER app: POST /apps/appb/tokens', async () => {
      await app
        .request()
        .post(`${P}/apps/appb/tokens`)
        .set(...bearer(appATokenId))
        .send({ room: 'r1' })
        .expect(403);
    });

    it('403 purging ANOTHER app: POST /apps/appb/db/purge', async () => {
      await app
        .request()
        .post(`${P}/apps/appb/db/purge`)
        .set(...bearer(appATokenId))
        .send({ scope: 'logs', confirm: true })
        .expect(403);
    });

    it('the app-A token still authenticates (not globally locked out): GET /auth/me', async () => {
      const me = await app.request().get(`${P}/auth/me`).set(...bearer(appATokenId)).expect(200);
      expect(me.body.data).toMatchObject({ via: 'api_token', isSuperadmin: false, scope: 'app' });
    });
  });
});
