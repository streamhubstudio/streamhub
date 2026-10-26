/**
 * Unit spec — AppsService save-time callback-URL SSRF guard (fix P0-1).
 *
 * The fire-time guard in CallbacksService is the backstop; this locks the
 * SAVE-time half: a tenant must not be able to PERSIST a private/metadata
 * callback target in the first place, on ANY config write path:
 *   - updateConfig (PATCH /apps/:app/config) → 400, nothing written,
 *   - putRawConfig (raw YAML editor) → 400, file untouched,
 *   - dryRunRawConfig reports it as invalid instead of throwing,
 *   - clearing the URL ('' = callbacks off) always passes,
 *   - STREAMHUB_CALLBACK_ALLOW_HOSTS admits a named internal host.
 *
 * DNS is an injected fake resolver — nothing dials the network.
 */
import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AppsService } from './apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { CALLBACK_ALLOW_HOSTS_ENV } from '../security/egress-url.guard';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

function buildApps(ctx: UnitContext): AppsService {
  const s3 = new S3Service();
  const secrets = new SecretsStore(ctx.config);
  const samplesFake = { generate: jest.fn(async () => []) };
  const moduleRef = { get: jest.fn(() => samplesFake) } as unknown as never;
  const apps = ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
  apps.hostResolver = async (hostname: string) => {
    if (hostname === 'intranet.evil.tld') return ['10.20.30.40'];
    if (hostname === 'hooks.internal.lan') return ['192.168.7.7'];
    if (hostname === 'hook.example.com') return ['93.184.216.34'];
    throw new Error(`ENOTFOUND ${hostname}`);
  };
  return apps;
}

describe('AppsService — save-time callback URL SSRF guard', () => {
  let ctx: UnitContext;
  let apps: AppsService;
  const prevAllow = process.env[CALLBACK_ALLOW_HOSTS_ENV];

  const diskConfig = (name: string): Record<string, any> =>
    yaml.load(
      fs.readFileSync(path.join(apps.appDir(name), 'config.yaml'), 'utf8'),
    ) as Record<string, any>;

  beforeEach(async () => {
    ctx = makeUnitContext();
    apps = buildApps(ctx);
    await apps.create({ name: 'live', displayName: 'Live' });
    delete process.env[CALLBACK_ALLOW_HOSTS_ENV];
  });

  afterEach(() => {
    ctx.cleanup();
    if (prevAllow === undefined) delete process.env[CALLBACK_ALLOW_HOSTS_ENV];
    else process.env[CALLBACK_ALLOW_HOSTS_ENV] = prevAllow;
  });

  describe('updateConfig (PATCH path)', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://127.0.0.1:3020/api/v1/health', // loopback
      'https://intranet.evil.tld/hook', // hostname → RFC1918 (DNS fake)
      'file:///etc/passwd', // forbidden scheme
    ])('rejects %s with 400 and persists NOTHING', async (url) => {
      await expect(
        apps.updateConfig('live', { callbacks: { url, secret: '' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(diskConfig('live').callbacks.url).toBe('');
    });

    it('accepts a public URL and an empty URL (callbacks off)', async () => {
      await apps.updateConfig('live', {
        callbacks: { url: 'https://hook.example.com/cb', secret: '' },
      });
      expect(diskConfig('live').callbacks.url).toBe('https://hook.example.com/cb');
      await apps.updateConfig('live', { callbacks: { url: '', secret: '' } });
      expect(diskConfig('live').callbacks.url).toBe('');
    });

    it('the env allowlist admits a named internal host', async () => {
      process.env[CALLBACK_ALLOW_HOSTS_ENV] = 'hooks.internal.lan';
      await apps.updateConfig('live', {
        callbacks: { url: 'https://hooks.internal.lan/cb', secret: '' },
      });
      expect(diskConfig('live').callbacks.url).toBe('https://hooks.internal.lan/cb');
    });
  });

  describe('raw YAML editor paths', () => {
    const rawWith = (url: string): string =>
      [
        'name: live',
        'room_prefix: live',
        'callbacks:',
        `  url: "${url}"`,
      ].join('\n');

    it('putRawConfig rejects a private callback URL and leaves the file untouched', async () => {
      const before = await apps.getRawConfig('live');
      await expect(
        apps.putRawConfig('live', rawWith('http://192.168.1.10/hook')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await apps.getRawConfig('live')).toBe(before);
    });

    it('putRawConfig accepts a public callback URL', async () => {
      const res = await apps.putRawConfig(
        'live',
        rawWith('https://hook.example.com/cb'),
      );
      expect(res.reloaded).toBe(true);
      expect(diskConfig('live').callbacks.url).toBe('https://hook.example.com/cb');
    });

    it('dryRunRawConfig reports the rejection inline (valid:false, no throw)', async () => {
      const dry = await apps.dryRunRawConfig(
        'live',
        rawWith('http://169.254.169.254/x'),
      );
      expect(dry.valid).toBe(false);
      expect(dry.error).toContain('callback URL');
    });
  });
});
