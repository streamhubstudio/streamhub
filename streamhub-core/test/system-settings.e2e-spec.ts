/**
 * E2E — GET /system/settings over the FULL AppModule (supertest).
 *
 * Covers the pieces that need the real request pipeline:
 *  - 401 anonymous (behind the real Bearer guard),
 *  - 200 for a superadmin JWT with the enveloped, correctly-shaped payload,
 *  - REDACTION end-to-end: distinctive secret env values are pinned and the
 *    response body is asserted to contain NONE of them (no JWT/API/admin/
 *    cluster/SMTP secret, no Redis password) — only `…Set` booleans + masks.
 *
 * A superadmin Bearer JWT (sub='admin') is minted with the test JWT secret so
 * the global auth + authz guards both pass (mirrors cluster.e2e-spec.ts).
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { signJwt } from '../src/shared/auth/jwt.util';

const P = '/api/v1';
const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';

/** Distinctive secrets we assert never appear in the response. */
const SECRETS = {
  STREAMHUB_JWT_SECRET: JWT_SECRET, // also the signing secret
  LIVEKIT_API_SECRET: 'LKSECRET_NEVER_EXPOSE',
  ADMIN_PASS: 'ADMINPASS_NEVER_EXPOSE',
  STREAMHUB_CLUSTER_TOKEN: 'CLUSTERTOKEN_NEVER_EXPOSE',
  STREAMHUB_SMTP_PASS: 'SMTPPASS_NEVER_EXPOSE',
  METRICS_TOKEN: 'METRICSTOKEN_NEVER_EXPOSE',
  REDIS_PASSWORD: 'REDISPASS_NEVER_EXPOSE',
};

function adminBearer(): string {
  return `Bearer ${signJwt({ sub: 'admin' }, JWT_SECRET, 3600)}`;
}

describe('system/settings (e2e)', () => {
  let app: TestApp;
  const auth = adminBearer();

  beforeAll(async () => {
    app = await bootstrapTestApp({
      env: {
        STREAMHUB_JWT_SECRET: JWT_SECRET,
        STREAMHUB_AUTHZ_ENFORCE: 'on',
        REDIS_URL: `redis://:${SECRETS.REDIS_PASSWORD}@redis-host:6390`,
        LIVEKIT_API_KEY: 'APIkey1234567',
        LIVEKIT_API_SECRET: SECRETS.LIVEKIT_API_SECRET,
        ADMIN_USER: 'root',
        ADMIN_PASS: SECRETS.ADMIN_PASS,
        STREAMHUB_CLUSTER_TOKEN: SECRETS.STREAMHUB_CLUSTER_TOKEN,
        STREAMHUB_SMTP_HOST: 'smtp.example.com',
        STREAMHUB_SMTP_PASS: SECRETS.STREAMHUB_SMTP_PASS,
        METRICS_TOKEN: SECRETS.METRICS_TOKEN,
        STREAMHUB_SUPERADMIN_EMAIL: 'owner@example.com',
      },
    });
  });
  afterAll(async () => app?.close());

  it('401 anonymous', async () => {
    await app.request().get(`${P}/system/settings`).expect(401);
  });

  it('200 for a superadmin — enveloped, correctly shaped', async () => {
    const res = await app
      .request()
      .get(`${P}/system/settings`)
      .set('Authorization', auth)
      .expect(200);

    expect(res.body.error).toBeNull();
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual(
      [
        'auth',
        'cluster',
        'core',
        'guidance',
        'livekit',
        'metrics',
        'ports',
        'runtime',
        'storage',
        'versions',
      ].sort(),
    );
    // authzEnforce is a visible security mode (not a secret).
    expect(d.core.authzEnforce).toBe('on');
    // Redis reduced to host:port; password stripped.
    expect(d.core.redisUrl).toBe('redis-host:6390');
    // Secrets surface only as booleans / masks.
    expect(d.auth.jwtSecretSet).toBe(true);
    expect(d.auth.adminPassSet).toBe(true);
    expect(d.auth.smtpConfigured).toBe(true);
    expect(d.livekit.apiKeySet).toBe(true);
    expect(d.livekit.apiKeyMasked).toBe('APIkey…');
    expect(d.cluster.enabled).toBe(true);
    expect(d.metrics.tokenSet).toBe(true);
    expect(d.ports).toEqual({
      core: 3020,
      livekitSignaling: 7880,
      livekitTcp: 7881,
      livekitUdp: 7882,
      rtmp: 1935,
      whip: 8080,
    });
  });

  it('leaks NO secret anywhere in the response body', async () => {
    const res = await app
      .request()
      .get(`${P}/system/settings`)
      .set('Authorization', auth)
      .expect(200);

    const json = JSON.stringify(res.body);
    for (const secret of Object.values(SECRETS)) {
      expect(json).not.toContain(secret);
    }
    // No secret-bearing property names on the tree either.
    for (const key of ['jwtSecret', 'apiSecret', 'adminPass', 'clusterToken']) {
      expect(json).not.toContain(`"${key}"`);
    }
  });
});
