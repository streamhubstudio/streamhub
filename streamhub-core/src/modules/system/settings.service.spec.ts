/**
 * Unit — system/SettingsService (#16, read-only server settings).
 *
 * Locks down the two invariants that matter for a config-reporting endpoint:
 *
 *  1. SHAPE — every group (core/auth/livekit/cluster/metrics/storage/versions/
 *     runtime/ports) and its keys are present, and `guidance` carries a hint
 *     array per group.
 *  2. REDACTION — NO secret ever leaves the service. We pin distinctive secret
 *     env values (…_NEVER_EXPOSE) and assert none appear anywhere in the
 *     serialized payload; secrets surface only as `…Set` booleans / masks, and
 *     the Redis password is stripped to a bare host:port.
 *
 * Built against a real (temp) DB via the unit harness; DbSizesService is the
 * genuine service so `storage` reflects the migrated schema.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { DbSizesService } from '../../shared/db/db-sizes.service';
import { SettingsService } from './settings.service';

/** Secret env values: distinctive so we can assert they never leak. */
const SECRETS = {
  STREAMHUB_JWT_SECRET: 'JWTSECRET_NEVER_EXPOSE',
  LIVEKIT_API_SECRET: 'LKSECRET_NEVER_EXPOSE',
  ADMIN_PASS: 'ADMINPASS_NEVER_EXPOSE',
  STREAMHUB_CLUSTER_TOKEN: 'CLUSTERTOKEN_NEVER_EXPOSE',
  STREAMHUB_SMTP_PASS: 'SMTPPASS_NEVER_EXPOSE',
  METRICS_TOKEN: 'METRICSTOKEN_NEVER_EXPOSE',
  REDIS_PASSWORD: 'REDISPASS_NEVER_EXPOSE',
};

const ENV: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '3020',
  HOST: '127.0.0.1',
  PUBLIC_BASE_URL: 'https://media.example.com',
  PUBLIC_WS_URL: 'wss://public.example.com',
  RTMP_PUBLIC_HOST: 'rtmp.example.com',
  LOG_LEVEL: 'info',
  LOG_RETENTION_DAYS: '30',
  STREAMHUB_AUTHZ_ENFORCE: 'on',
  REDIS_URL: `redis://:${SECRETS.REDIS_PASSWORD}@redis-host:6390`,
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'APIkey1234567',
  ADMIN_USER: 'root',
  STREAMHUB_SMTP_HOST: 'smtp.example.com',
  STREAMHUB_SUPERADMIN_EMAIL: 'Owner@Example.com',
  STREAMHUB_CLUSTER_REDIS_URL: 'redis://cluster:6379',
  ...SECRETS,
};

// Call-time envs (config.env()) must be restored so they don't bleed into
// sibling suites (ConfigService snapshots the rest in its ctor).
const TOUCHED = Object.keys(ENV);

describe('system/SettingsService', () => {
  let ctx: UnitContext;
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of TOUCHED) original[k] = process.env[k];
  });
  afterEach(() => {
    ctx?.cleanup();
    for (const k of TOUCHED) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  function build(over: Record<string, string> = {}): SettingsService {
    ctx = makeUnitContext({ ...ENV, ...over });
    const sizes = ctx.newService(DbSizesService, ctx.db);
    return ctx.newService(SettingsService, ctx.config, ctx.db, sizes);
  }

  describe('shape', () => {
    it('returns every group with its keys + a guidance block', () => {
      const s = build().getSettings();

      expect(Object.keys(s).sort()).toEqual(
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

      expect(Object.keys(s.core).sort()).toEqual(
        [
          'authzEnforce',
          'dataDir',
          'host',
          'logLevel',
          'logRetentionDays',
          'nodeEnv',
          'port',
          'publicBaseUrl',
          'publicWsUrl',
          'redisUrl',
          'rtmpPublicHost',
        ].sort(),
      );
      expect(Object.keys(s.auth).sort()).toEqual(
        ['adminPassSet', 'adminUser', 'jwtSecretSet', 'smtpConfigured', 'superadminEmail'].sort(),
      );
      expect(Object.keys(s.livekit).sort()).toEqual(
        ['apiKeyMasked', 'apiKeySet', 'url'].sort(),
      );
      expect(Object.keys(s.cluster).sort()).toEqual(
        ['enabled', 'nodesCount', 'redisConfigured'].sort(),
      );
      expect(Object.keys(s.metrics)).toEqual(['tokenSet']);
      expect(Object.keys(s.storage).sort()).toEqual(
        ['appsCount', 'dataDir', 'dbSizeBytes'].sort(),
      );
      expect(Object.keys(s.versions).sort()).toEqual(['core', 'node'].sort());
      expect(Object.keys(s.runtime).sort()).toEqual(
        ['memoryRssBytes', 'pid', 'platform', 'uptimeSeconds'].sort(),
      );
      expect(s.ports).toEqual({
        core: 3020,
        livekitSignaling: 7880,
        livekitTcp: 7881,
        livekitUdp: 7882,
        rtmp: 1935,
        whip: 8080,
      });

      for (const group of ['core', 'auth', 'livekit', 'cluster', 'metrics', 'storage']) {
        expect(Array.isArray(s.guidance[group])).toBe(true);
        expect(s.guidance[group].length).toBeGreaterThan(0);
        for (const g of s.guidance[group]) {
          expect(g).toEqual(
            expect.objectContaining({
              setting: expect.any(String),
              envVar: expect.any(String),
              howToChange: expect.any(String),
            }),
          );
        }
      }
    });

    it('reflects the effective (non-secret) config verbatim', () => {
      const s = build().getSettings();

      expect(s.core.nodeEnv).toBe('production');
      expect(s.core.port).toBe(3020);
      expect(s.core.publicBaseUrl).toBe('https://media.example.com');
      expect(s.core.logRetentionDays).toBe(30);
      // authzEnforce is a MODE (not a secret): shown as-is.
      expect(s.core.authzEnforce).toBe('on');
      // Redis is reduced to host:port — the password is dropped.
      expect(s.core.redisUrl).toBe('redis-host:6390');
      expect(s.livekit.url).toBe('ws://127.0.0.1:7880');
      expect(s.livekit.apiKeyMasked).toBe('APIkey…');
      expect(s.auth.adminUser).toBe('root');
      expect(s.auth.superadminEmail).toBe('owner@example.com');
      expect(s.versions.node).toBe(process.version);
      expect(typeof s.storage.dbSizeBytes).toBe('number');
      expect(s.storage.appsCount).toBeGreaterThanOrEqual(0);
    });

    it('reports every secret only as a "…Set" / "configured" boolean', () => {
      const s = build().getSettings();
      expect(s.auth.jwtSecretSet).toBe(true);
      expect(s.auth.adminPassSet).toBe(true);
      expect(s.auth.smtpConfigured).toBe(true);
      expect(s.livekit.apiKeySet).toBe(true);
      expect(s.cluster.enabled).toBe(true);
      expect(s.cluster.redisConfigured).toBe(true);
      expect(s.metrics.tokenSet).toBe(true);
    });

    it('flags unset secrets as false and masks empty', () => {
      const s = build({
        STREAMHUB_JWT_SECRET: '',
        ADMIN_PASS: '',
        LIVEKIT_API_KEY: '',
        LIVEKIT_API_SECRET: '',
        STREAMHUB_CLUSTER_TOKEN: '',
        STREAMHUB_CLUSTER_REDIS_URL: '',
        STREAMHUB_SMTP_PASS: '',
        METRICS_TOKEN: '',
        STREAMHUB_AUTHZ_ENFORCE: 'log',
      }).getSettings();
      expect(s.auth.jwtSecretSet).toBe(false);
      expect(s.auth.adminPassSet).toBe(false);
      expect(s.auth.smtpConfigured).toBe(false);
      expect(s.livekit.apiKeySet).toBe(false);
      expect(s.livekit.apiKeyMasked).toBe('');
      expect(s.cluster.enabled).toBe(false);
      expect(s.cluster.redisConfigured).toBe(false);
      expect(s.metrics.tokenSet).toBe(false);
      expect(s.core.authzEnforce).toBe('log');
    });
  });

  describe('redaction (NO secret leaks anywhere in the payload)', () => {
    it('never serializes any secret value', () => {
      const json = JSON.stringify(build().getSettings());
      for (const secret of Object.values(SECRETS)) {
        expect(json).not.toContain(secret);
      }
    });

    it('never exposes the raw secret KEYS (jwtSecret/apiSecret/adminPass/…)', () => {
      const s = build().getSettings();
      const json = JSON.stringify(s);
      for (const key of [
        'jwtSecret',
        'apiSecret',
        'livekitApiSecret',
        'adminPass',
        'clusterToken',
        'smtpPass',
        'metricsToken',
        'password',
      ]) {
        expect(json).not.toContain(`"${key}"`);
      }
      // The specific asks: these must NOT be present on the tree.
      expect((s.auth as Record<string, unknown>).jwtSecret).toBeUndefined();
      expect((s.livekit as Record<string, unknown>).apiSecret).toBeUndefined();
      expect((s.auth as Record<string, unknown>).adminPass).toBeUndefined();
    });

    it('strips the password even from an odd Redis URL', () => {
      const s = build({ REDIS_URL: 'redis://user:PWLEAK_NEVER@host:6379/0' }).getSettings();
      expect(s.core.redisUrl).toBe('host:6379');
      expect(JSON.stringify(s)).not.toContain('PWLEAK_NEVER');
    });
  });
});
