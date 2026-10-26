/**
 * Unit spec — AppsService SMTP config block (owner item 29: per-app SMTP).
 *
 * Exercises the `smtp:` config machinery against a REAL migrated temp SQLite
 * DB + real SecretsStore (harness makeUnitContext — no network anywhere).
 * Locks down the credential invariants:
 *   - the SMTP password NEVER lands in config.yaml (secrets.json only),
 *   - masked-on-read (getSmtp view) but resolved for internal consumers
 *     (getConfig → EmailService precedence resolver),
 *   - defaults (disabled, port 587, empty host/user/from),
 *   - raw-yaml editor warns on an inline smtp.pass.
 */
import * as fs from 'fs';
import * as path from 'path';

import { AppsService } from './apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

const APP = 'smtpapp';

describe('AppsService — smtp config (owner item 29)', () => {
  let ctx: UnitContext;
  let apps: AppsService;

  beforeEach(async () => {
    ctx = makeUnitContext();
    apps = ctx.newService(
      AppsService,
      ctx.config,
      ctx.db,
      new S3Service(),
      new SecretsStore(ctx.config),
    );
    await apps.create({ name: APP });
  });

  afterEach(() => ctx.cleanup());

  function yamlText(): string {
    return fs.readFileSync(
      path.join(apps.appDir(APP), 'config.yaml'),
      'utf8',
    );
  }

  function secretsJson(): Record<string, string> {
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(ctx.config.dataDir, 'data', 'secrets.json'),
          'utf8',
        ),
      );
    } catch {
      return {};
    }
  }

  it('resolves safe defaults: disabled, port 587, empty host/user/from', async () => {
    const cfg = await apps.getConfig(APP);
    expect(cfg.smtp).toEqual({
      enabled: false,
      host: '',
      port: 587,
      user: '',
      from: '',
      pass: '',
    });
  });

  it('setSmtp writes the block to the yaml but the password ONLY to secrets.json', async () => {
    const view = await apps.setSmtp(APP, {
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      user: 'no-reply@example.com',
      from: 'My App <no-reply@example.com>',
      pass: 'super-secret-password',
    });

    // yaml carries the ref, never the value.
    const yaml = yamlText();
    expect(yaml).not.toContain('super-secret-password');
    expect(yaml).toContain('pass_env: APP_SMTPAPP_SMTP_PASS');
    expect(secretsJson().APP_SMTPAPP_SMTP_PASS).toBe('super-secret-password');

    // Masked view (never the clear password), config persisted.
    expect(view.pass).toBe('su***rd');
    expect(view.hasPass).toBe(true);
    expect(view.configured).toBe(true);
    expect(view.host).toBe('smtp.example.com');
    expect(view.port).toBe(465);
    expect(view.from).toBe('My App <no-reply@example.com>');
  });

  it('getSmtp masks and getConfig resolves the same password', async () => {
    await apps.setSmtp(APP, { host: 'smtp.example.com', pass: 'abcd1234efgh' });

    const masked = await apps.getSmtp(APP);
    expect(masked.pass).toBe('ab***gh');
    expect(masked.pass).not.toContain('cd1234');

    const resolved = await apps.getConfig(APP);
    expect(resolved.smtp?.pass).toBe('abcd1234efgh');
  });

  it('setSmtp without a pass keeps the stored one', async () => {
    await apps.setSmtp(APP, { pass: 'keep-me-around' });
    await apps.setSmtp(APP, { host: 'other.example.com' });
    expect(secretsJson().APP_SMTPAPP_SMTP_PASS).toBe('keep-me-around');
    expect((await apps.getSmtp(APP)).hasPass).toBe(true);
  });

  it('updateConfig does NOT accept an smtp block (dedicated PUT /apps/:app/smtp owns it)', async () => {
    // Mirrors the S3 pattern: secrets never flow through the generic PATCH.
    const cfg = await apps.updateConfig(APP, { displayName: 'X' });
    expect(cfg.smtp?.enabled).toBe(false);
  });

  it('sanitizes junk: invalid port falls back to 587', async () => {
    await apps.setSmtp(APP, { port: 999999 as never });
    const cfg = await apps.getConfig(APP);
    expect(cfg.smtp?.port).toBe(587);
  });

  it('raw config editor warns on an inline smtp.pass (and ignores it)', async () => {
    const raw = [
      `name: ${APP}`,
      'smtp:',
      '  enabled: true',
      '  host: smtp.example.com',
      '  pass: should-not-be-here',
    ].join('\n');
    const res = await apps.putRawConfig(APP, raw);
    expect(res.warnings.join(' ')).toContain('smtp.pass');
    // The resolver never reads an inline password — only the *_env ref.
    const cfg = await apps.getConfig(APP);
    expect(cfg.smtp?.pass).toBe('');
  });

  it('404s on unknown apps', async () => {
    await expect(apps.getSmtp('nope')).rejects.toThrow('not found');
    await expect(apps.setSmtp('nope', {})).rejects.toThrow('not found');
  });
});
