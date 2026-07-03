/**
 * Unit spec — AppsService (config-samples-apps module, apps + config halves).
 *
 * Exercises the app registry + filesystem/config lifecycle against a REAL
 * migrated temp SQLite DB (harness `makeUnitContext`), with real S3Service /
 * SecretsStore collaborators and a stub ModuleRef for the samples hand-off (so
 * nothing dials LiveKit/Redis/S3 and no real network is touched).
 *
 * Coverage:
 *   - apps: create (slug validation, tenant_id invariant, dup/case, defaults),
 *     get/list, delete (± deleteVods), getConfig/updateConfig.
 *   - config: raw GET/PUT (yaml validate, atomic no-write-on-error), dry-run
 *     (validate + diff, never writes), timestamped backups (+ 20-prune), revert
 *     (reversible), hot-reload (registry re-sync + secrets/s3 re-init).
 *   - s3: masked getter + setter (secrets never land in the yaml; fold-3
 *     public_url confirmation gate).
 *
 * Owned by the config-samples-apps test agent. Touches only this *.spec.ts.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AppsService } from './apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import type { AuthContext } from '../../shared/auth-context';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

/** A normal (non-superadmin) dashboard user acting inside their own tenant. */
const userCtx = (tenantId: string): AuthContext => ({
  userId: `u_${tenantId}`,
  tenantId,
  role: 'owner',
  isSuperadmin: false,
  scope: 'user',
  via: 'user_jwt',
});
/** Platform superadmin / global credential — sees every tenant's apps. */
const superCtx: AuthContext = {
  userId: 'admin',
  tenantId: 'platform',
  role: 'superadmin',
  isSuperadmin: true,
  scope: 'global',
  via: 'admin_jwt',
};

interface AppsHarness {
  apps: AppsService;
  s3: S3Service;
  secrets: SecretsStore;
  samplesFake: { generate: jest.Mock };
}

function buildApps(ctx: UnitContext): AppsHarness {
  const s3 = new S3Service();
  const secrets = new SecretsStore(ctx.config);
  const samplesFake = { generate: jest.fn(async () => ['webrtc-publish.html']) };
  const moduleRef = { get: jest.fn(() => samplesFake) } as unknown as never;
  const apps = ctx.newService(
    AppsService,
    ctx.config,
    ctx.db,
    s3,
    secrets,
    moduleRef,
  );
  return { apps, s3, secrets, samplesFake };
}

describe('AppsService', () => {
  let ctx: UnitContext;
  let apps: AppsService;
  let s3: S3Service;
  let secrets: SecretsStore;

  const rawPath = (name: string): string =>
    path.join(apps.appDir(name), 'config.yaml');
  const readRaw = (name: string): string => fs.readFileSync(rawPath(name), 'utf8');

  beforeEach(() => {
    ctx = makeUnitContext();
    ({ apps, s3, secrets } = buildApps(ctx));
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ===========================================================================
  // apps — create
  // ===========================================================================
  describe('create', () => {
    it('creates the row, scaffolds dirs + config.yaml, returns the record', async () => {
      const rec = await apps.create({ name: 'myapp', displayName: 'My App' });

      expect(rec).toMatchObject({
        name: 'myapp',
        displayName: 'My App',
        livekitRoomPrefix: 'myapp',
      });
      expect(typeof rec.id).toBe('number');

      const dir = apps.appDir('myapp');
      expect(fs.existsSync(path.join(dir, 'recordings'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'snapshots'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'samples'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'config.yaml'))).toBe(true);
    });

    it('INVARIANT: a freshly created app is homed to the platform tenant', async () => {
      await apps.create({ name: 'tenapp' });
      const row = ctx.db
        .global()
        .prepare('SELECT tenant_id FROM apps WHERE name = ?')
        .get('tenapp') as { tenant_id: string };
      expect(row.tenant_id).toBe('platform');
    });

    it('stamps the OWNING tenant when created with a tenantId (per-user scoping)', async () => {
      await apps.create({ name: 'ownedapp', tenantId: 'tnt_alice' });
      const row = ctx.db
        .global()
        .prepare('SELECT tenant_id FROM apps WHERE name = ?')
        .get('ownedapp') as { tenant_id: string };
      expect(row.tenant_id).toBe('tnt_alice');
    });

    it('defaults displayName + roomPrefix to the app name when omitted', async () => {
      const rec = await apps.create({ name: 'plainapp' });
      expect(rec.displayName).toBe('plainapp');
      expect(rec.livekitRoomPrefix).toBe('plainapp');
    });

    it('lowercases the roomPrefix', async () => {
      const rec = await apps.create({ name: 'caseapp', roomPrefix: 'MyRoom' });
      expect(rec.livekitRoomPrefix).toBe('myroom');
      const disk = yaml.load(readRaw('caseapp')) as { room_prefix: string };
      expect(disk.room_prefix).toBe('myroom');
    });

    it('writes config.yaml as a valid mapping with the app name + secret refs (never raw creds)', async () => {
      await apps.create({ name: 'cfgapp' });
      const disk = yaml.load(readRaw('cfgapp')) as Record<string, any>;
      expect(disk.name).toBe('cfgapp');
      expect(disk.s3.access_key_env).toBe('APP_CFGAPP_S3_KEY');
      expect(disk.s3.secret_key_env).toBe('APP_CFGAPP_S3_SECRET');
      // No inline credentials on disk.
      expect(disk.s3.key).toBeUndefined();
      expect(disk.s3.secret).toBeUndefined();
    });

    it.each([
      ['ab', 'too short (< 3)'],
      ['a b', 'contains a space'],
      ['-abc', 'leading hyphen'],
      ['abc-', 'trailing hyphen'],
      ['my_app', 'underscore not allowed'],
      ['', 'empty'],
      ['a'.repeat(33), 'too long (> 32)'],
    ])('rejects invalid slug %p (%s) with ConflictException', async (name) => {
      await expect(apps.create({ name })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects a duplicate name (409)', async () => {
      await apps.create({ name: 'dup' });
      await expect(apps.create({ name: 'dup' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('treats names case-insensitively for duplicate detection', async () => {
      await apps.create({ name: 'dupcase' });
      // "DupCase" normalises to "dupcase" → duplicate.
      await expect(apps.create({ name: 'DupCase' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // ===========================================================================
  // apps — get / list
  // ===========================================================================
  describe('get / list', () => {
    it('get returns null for a missing app', async () => {
      expect(await apps.get('ghost')).toBeNull();
    });

    it('get returns the record for an existing app', async () => {
      await apps.create({ name: 'exists' });
      const rec = await apps.get('exists');
      expect(rec?.name).toBe('exists');
    });

    it('list returns apps sorted by name ascending', async () => {
      await apps.create({ name: 'zebra' });
      await apps.create({ name: 'alpha' });
      await apps.create({ name: 'mango' });
      const names = (await apps.list()).map((a) => a.name);
      expect(names).toEqual(['alpha', 'mango', 'zebra']);
    });

    it('ISOLATION: a normal user only sees their own tenant apps (no cross-tenant leak)', async () => {
      await apps.create({ name: 'alice-a', tenantId: 'tnt_alice' });
      await apps.create({ name: 'alice-b', tenantId: 'tnt_alice' });
      await apps.create({ name: 'bob-a', tenantId: 'tnt_bob' });

      expect((await apps.list(userCtx('tnt_alice'))).map((a) => a.name)).toEqual([
        'alice-a',
        'alice-b',
      ]);
      expect((await apps.list(userCtx('tnt_bob'))).map((a) => a.name)).toEqual([
        'bob-a',
      ]);
      // A brand-new tenant with no apps sees an EMPTY list (drives onboarding).
      expect(await apps.list(userCtx('tnt_carol'))).toEqual([]);
    });

    it('ADMIN VIEW: superadmin/global (and internal no-ctx callers) see every app', async () => {
      await apps.create({ name: 'alice-a', tenantId: 'tnt_alice' });
      await apps.create({ name: 'bob-a', tenantId: 'tnt_bob' });
      await apps.create({ name: 'plat', tenantId: 'platform' });

      const all = ['alice-a', 'bob-a', 'plat'];
      expect((await apps.list(superCtx)).map((a) => a.name)).toEqual(all);
      expect((await apps.list()).map((a) => a.name)).toEqual(all); // internal caller
    });
  });

  // ===========================================================================
  // apps — delete
  // ===========================================================================
  describe('delete', () => {
    it('removes the registry row but PRESERVES local files by default', async () => {
      await apps.create({ name: 'keepvods' });
      const dir = apps.appDir('keepvods');
      await apps.delete('keepvods');
      expect(await apps.get('keepvods')).toBeNull();
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('purges the app directory when deleteVods is true', async () => {
      await apps.create({ name: 'purge' });
      const dir = apps.appDir('purge');
      await apps.delete('purge', { deleteVods: true });
      expect(await apps.get('purge')).toBeNull();
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('throws NotFound deleting a missing app', async () => {
      await expect(apps.delete('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ===========================================================================
  // config — resolved getConfig / updateConfig
  // ===========================================================================
  describe('getConfig / updateConfig', () => {
    it('getConfig returns the resolved AppConfig with feature defaults', async () => {
      await apps.create({ name: 'resolved' });
      const cfg = await apps.getConfig('resolved');
      expect(cfg.name).toBe('resolved');
      expect(cfg.recording.enabled).toBe(true);
      expect(cfg.features.viewerCounter).toBe(true);
      expect(cfg.features.chat).toBe(false);
      // Credentials resolve to empty (none configured yet).
      expect(cfg.s3.accessKey).toBe('');
    });

    it('getConfig throws NotFound for a missing app', async () => {
      await expect(apps.getConfig('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('updateConfig persists a patch + syncs the registry row', async () => {
      await apps.create({ name: 'upd' });
      const cfg = await apps.updateConfig('upd', {
        displayName: 'Renamed',
        recording: { enabled: false } as never,
      });
      expect(cfg.displayName).toBe('Renamed');
      expect(cfg.recording.enabled).toBe(false);
      // Registry row reflects the new display name.
      expect((await apps.get('upd'))?.displayName).toBe('Renamed');
    });
  });

  // ===========================================================================
  // config — raw GET / PUT (validate + atomic write)
  // ===========================================================================
  describe('raw config GET/PUT', () => {
    beforeEach(async () => {
      await apps.create({ name: 'live' });
    });

    it('getRawConfig returns the on-disk YAML text', async () => {
      const raw = await apps.getRawConfig('live');
      expect(raw).toContain('name: live');
      expect(raw).toBe(readRaw('live'));
    });

    it('getRawConfig throws NotFound for a missing app', async () => {
      await expect(apps.getRawConfig('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('getRawConfig throws NotFound when config.yaml is missing', async () => {
      fs.rmSync(rawPath('live'));
      await expect(apps.getRawConfig('live')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('putRawConfig persists valid YAML and hot-reloads', async () => {
      const next =
        'name: live\ndisplay_name: Edited\nroom_prefix: live\nrecording:\n  enabled: false\n';
      const res = await apps.putRawConfig('live', next);
      expect(res.reloaded).toBe(true);
      expect(readRaw('live')).toBe(next);
    });

    it('surfaces a soft warning when room_prefix is omitted', async () => {
      const res = await apps.putRawConfig('live', 'name: live\n');
      expect(res.warnings.join(' ')).toContain('room_prefix missing');
    });

    it('warns about inline s3.key/secret and ignores them when RESOLVING the config', async () => {
      const res = await apps.putRawConfig(
        'live',
        'name: live\nroom_prefix: live\ns3:\n  key: LEAK\n  secret: LEAK\n',
      );
      expect(res.warnings.join(' ')).toContain('s3.key/s3.secret in the yaml');
      // Inline creds are NOT loaded into the resolved config (refs win).
      const cfg = await apps.getConfig('live');
      expect(cfg.s3.accessKey).toBe('');
      expect(cfg.s3.secretKey).toBe('');
    });

    // BUG (reported): the raw editor persists the submitted YAML verbatim, so an
    // inline s3.key/secret is written into config.yaml (and every timestamped
    // backup) in clear text — contradicting the module invariant "S3 credentials
    // are NEVER written to config.yaml". validateRawConfig only WARNS; it does
    // not strip. This `it.failing` documents the gap and keeps the suite green
    // until the code strips inline secrets before writing.
    it.failing(
      'BUG: inline s3.key/secret must not be persisted to config.yaml',
      async () => {
        await apps.putRawConfig(
          'live',
          'name: live\nroom_prefix: live\ns3:\n  key: LEAK\n  secret: LEAK\n',
        );
        expect(readRaw('live')).not.toContain('LEAK');
      },
    );

    it('INVARIANT: a YAML parse error yields 400 and does NOT touch the file', async () => {
      const before = readRaw('live');
      await expect(
        apps.putRawConfig('live', 'foo: [unclosed'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(readRaw('live')).toBe(before);
    });

    it('INVARIANT: a non-mapping top level yields 400 and does NOT touch the file', async () => {
      const before = readRaw('live');
      await expect(
        apps.putRawConfig('live', '- just\n- a\n- list\n'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(readRaw('live')).toBe(before);
    });

    it('rejects a config whose name does not match the app (400, no write)', async () => {
      const before = readRaw('live');
      await expect(
        apps.putRawConfig('live', 'name: other\nroom_prefix: live\n'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(readRaw('live')).toBe(before);
    });

    it('putRawConfig throws NotFound for a missing app', async () => {
      await expect(
        apps.putRawConfig('ghost', 'name: ghost\n'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===========================================================================
  // config — dry-run (validate + diff, never writes)
  // ===========================================================================
  describe('dryRunRawConfig', () => {
    beforeEach(async () => {
      await apps.create({ name: 'live' });
    });

    it('reports valid + no change when the proposed config equals the current one', async () => {
      const current = await apps.getRawConfig('live');
      const res = await apps.dryRunRawConfig('live', current);
      expect(res).toMatchObject({ valid: true, error: null, changed: false });
      expect(res.diff).toBe('');
    });

    it('reports valid + a diff when the config changed', async () => {
      const res = await apps.dryRunRawConfig(
        'live',
        'name: live\ndisplay_name: Different\nroom_prefix: live\n',
      );
      expect(res.valid).toBe(true);
      expect(res.error).toBeNull();
      expect(res.changed).toBe(true);
      expect(res.diff).toMatch(/^[+-] /m);
    });

    it('reports valid=false + error WITHOUT throwing on an invalid config', async () => {
      const res = await apps.dryRunRawConfig('live', 'just a scalar');
      expect(res.valid).toBe(false);
      expect(res.error).toBeTruthy();
    });

    it('INVARIANT: a dry-run never writes the file', async () => {
      const before = readRaw('live');
      await apps.dryRunRawConfig(
        'live',
        'name: live\ndisplay_name: Nope\nroom_prefix: live\n',
      );
      expect(readRaw('live')).toBe(before);
    });

    it('throws NotFound for a missing app', async () => {
      await expect(
        apps.dryRunRawConfig('ghost', 'name: ghost\n'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===========================================================================
  // config — timestamped backups + revert
  // ===========================================================================
  describe('backups + revert', () => {
    beforeEach(async () => {
      await apps.create({ name: 'live' });
    });

    it('a PUT backs up the previous config (listable, newest first)', async () => {
      await apps.putRawConfig('live', 'name: live\nroom_prefix: live\n');
      const backups = await apps.listConfigBackups('live');
      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(backups[0]).toHaveProperty('ts');
      expect(backups[0]).toHaveProperty('sizeBytes');
    });

    it('INVARIANT: never keeps more than 20 backups (prunes oldest)', async () => {
      // Seed 25 synthetic backups with deterministically-ordered ids that all
      // sort BEFORE a real timestamp ("2026…"), so the prune removes the oldest.
      const dir = apps.appDir('live');
      for (let i = 1; i <= 25; i++) {
        const id = String(i).padStart(4, '0'); // 0001..0025
        fs.writeFileSync(path.join(dir, `config.yaml.bak.${id}`), 'x', 'utf8');
      }
      // One real PUT adds a 26th backup then prunes back to 20.
      await apps.putRawConfig('live', 'name: live\nroom_prefix: live\n');
      const backups = await apps.listConfigBackups('live');
      expect(backups.length).toBe(20);
    });

    it('readConfigBackup returns the verbatim backed-up YAML', async () => {
      const original = await apps.getRawConfig('live');
      await apps.putRawConfig('live', 'name: live\ndisplay_name: V1\nroom_prefix: live\n');
      const backups = await apps.listConfigBackups('live');
      const restored = await apps.readConfigBackup('live', backups[0].ts);
      expect(restored).toBe(original);
    });

    it('rejects an invalid backup id (400)', async () => {
      await expect(
        apps.readConfigBackup('live', 'bad id!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFound for an unknown backup id', async () => {
      await expect(
        apps.readConfigBackup('live', '20990101T000000000Z'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('INVARIANT: revert restores a prior config verbatim (and is itself reversible)', async () => {
      const v0 = await apps.getRawConfig('live');
      const v1 = 'name: live\ndisplay_name: V1\nroom_prefix: live\n';
      await apps.putRawConfig('live', v1); // backs up v0
      expect(await apps.getRawConfig('live')).toBe(v1);

      const backups = await apps.listConfigBackups('live');
      const v0Backup = backups.find(
        (b) => b.ts && true, // newest is the v0 snapshot taken during the PUT
      )!;
      const res = await apps.revertConfigBackup('live', v0Backup.ts);
      expect(res.reloaded).toBe(true);
      expect(await apps.getRawConfig('live')).toBe(v0);

      // Revert first backed up v1 → we can roll forward again.
      const after = await apps.listConfigBackups('live');
      const hasV1 = await Promise.all(
        after.map((b) => apps.readConfigBackup('live', b.ts)),
      );
      expect(hasV1).toContain(v1);
    });

    it('revert rejects an invalid backup id (400)', async () => {
      await expect(
        apps.revertConfigBackup('live', 'bad id!'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('revert throws NotFound for an unknown backup id', async () => {
      await expect(
        apps.revertConfigBackup('live', '20990101T000000000Z'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===========================================================================
  // config — hot-reload
  // ===========================================================================
  describe('reload', () => {
    beforeEach(async () => {
      await apps.create({ name: 'live' });
    });

    it('re-syncs the registry row from the edited YAML', async () => {
      fs.writeFileSync(
        rawPath('live'),
        'name: live\ndisplay_name: Synced\nroom_prefix: newprefix\n',
        'utf8',
      );
      const res = await apps.reload('live');
      expect(res.reloaded).toBe(true);
      const rec = await apps.get('live');
      expect(rec?.displayName).toBe('Synced');
      expect(rec?.livekitRoomPrefix).toBe('newprefix');
    });

    it('INVARIANT: hot-reload re-inits secrets + the S3 client cache', async () => {
      const invalidate = jest.spyOn(secrets, 'invalidate');
      const evict = jest.spyOn(s3, 'evict');
      await apps.reload('live');
      expect(invalidate).toHaveBeenCalled();
      expect(evict).toHaveBeenCalled();
    });

    it('returns reloaded=false + a warning when the config can no longer be read', async () => {
      fs.rmSync(rawPath('live'));
      const res = await apps.reload('live');
      expect(res.reloaded).toBe(false);
      expect(res.warnings.join(' ')).toContain('config re-read failed');
    });

    it('throws NotFound reloading a missing app', async () => {
      await expect(apps.reload('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ===========================================================================
  // config — S3 masked getter / setter
  // ===========================================================================
  describe('S3 config (masked)', () => {
    beforeEach(async () => {
      await apps.create({ name: 'live' });
    });

    it('getS3 reports "not configured" before any credentials are set', async () => {
      const m = await apps.getS3('live');
      expect(m).toMatchObject({
        configured: false,
        hasKey: false,
        hasSecret: false,
        publicVods: false,
        publicWarning: null,
      });
    });

    it('setS3 persists the non-secret block to the yaml', async () => {
      const m = await apps.setS3('live', {
        bucket: 'my-bucket',
        region: 'eu-west-1',
      });
      expect(m.bucket).toBe('my-bucket');
      expect(m.region).toBe('eu-west-1');
      const disk = yaml.load(readRaw('live')) as { s3: Record<string, unknown> };
      expect(disk.s3.bucket).toBe('my-bucket');
      expect(disk.s3.region).toBe('eu-west-1');
    });

    it('provider "aws" without explicit endpoint clears the scaffold Wasabi endpoint', async () => {
      // The scaffold defaults s3.endpoint to Wasabi's URL; switching the
      // provider to aws must not silently keep it (uploads would target
      // Wasabi with AWS creds). Empty endpoint = AWS SDK regional default.
      const before = yaml.load(readRaw('live')) as {
        s3: Record<string, unknown>;
      };
      expect(before.s3.endpoint).toContain('wasabisys.com');
      await apps.setS3('live', { provider: 'aws', bucket: 'aws-bucket' });
      const disk = yaml.load(readRaw('live')) as { s3: Record<string, unknown> };
      expect(disk.s3.provider).toBe('aws');
      expect(disk.s3.endpoint).toBe('');
      // An explicit endpoint still wins (custom/compatible providers).
      await apps.setS3('live', {
        provider: 'aws',
        endpoint: 'https://minio.internal:9000',
      });
      const disk2 = yaml.load(readRaw('live')) as {
        s3: Record<string, unknown>;
      };
      expect(disk2.s3.endpoint).toBe('https://minio.internal:9000');
    });

    it('INVARIANT: credentials are masked in the response and NEVER written to the yaml', async () => {
      const m = await apps.setS3('live', {
        key: 'AKIAEXAMPLEKEY',
        secret: 'SUPERSECRETVALUE',
      });
      expect(m.configured).toBe(true);
      expect(m.hasKey).toBe(true);
      expect(m.hasSecret).toBe(true);
      // Masked, not clear.
      expect(m.key).not.toBe('AKIAEXAMPLEKEY');
      expect(m.secret).not.toBe('SUPERSECRETVALUE');
      // Secrets must not leak into the versionable config.yaml.
      const raw = readRaw('live');
      expect(raw).not.toContain('AKIAEXAMPLEKEY');
      expect(raw).not.toContain('SUPERSECRETVALUE');
    });

    it('fold-3: enabling a public_url without confirmPublic is rejected (400)', async () => {
      await expect(
        apps.setS3('live', { public_url: 'https://cdn.example.com' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fold-3: enabling a public_url with confirmPublic=true flags publicVods + a warning', async () => {
      const m = await apps.setS3('live', {
        public_url: 'https://cdn.example.com/',
        confirmPublic: true,
      });
      expect(m.publicVods).toBe(true);
      expect(m.publicWarning).toBeTruthy();
      // Trailing slash trimmed.
      expect(m.public_url).toBe('https://cdn.example.com');
    });

    it('clearing an existing public_url does NOT require confirmPublic', async () => {
      await apps.setS3('live', {
        public_url: 'https://cdn.example.com',
        confirmPublic: true,
      });
      const m = await apps.setS3('live', { public_url: '' });
      expect(m.publicVods).toBe(false);
      expect(m.public_url).toBe('');
    });

    it('getS3 throws NotFound for a missing app', async () => {
      await expect(apps.getS3('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
