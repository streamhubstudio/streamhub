/**
 * Unit spec — AppsService G4 config presets (apply + list).
 *
 * Same harness as apps.transcoding-config.spec.ts (real temp DB + real
 * S3Service / SecretsStore + stub ModuleRef). Locks down:
 *   - GET presets → the three profiles,
 *   - applying each preset writes the expected values into config.yaml and
 *     hot-reloads (getConfig reflects them),
 *   - INVARIANT: applying a preset NEVER overwrites S3 credentials/refs or the
 *     callbacks secret,
 *   - a timestamped backup is taken, the diff is returned, and unknown
 *     app/preset → 404.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AppsService } from './apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

function buildApps(ctx: UnitContext): AppsService {
  const s3 = new S3Service();
  const secrets = new SecretsStore(ctx.config);
  const samplesFake = { generate: jest.fn(async () => []) };
  const moduleRef = { get: jest.fn(() => samplesFake) } as unknown as never;
  return ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
}

describe('AppsService — config presets (G4)', () => {
  let ctx: UnitContext;
  let apps: AppsService;

  const diskConfig = (name: string): Record<string, any> =>
    yaml.load(
      fs.readFileSync(path.join(apps.appDir(name), 'config.yaml'), 'utf8'),
    ) as Record<string, any>;

  beforeEach(async () => {
    ctx = makeUnitContext();
    apps = buildApps(ctx);
    await apps.create({ name: 'live', displayName: 'Live' });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe('listConfigPresets', () => {
    it('returns the three profiles with a description of what each sets', async () => {
      const presets = await apps.listConfigPresets('live');
      expect(presets.map((p) => p.name)).toEqual([
        'low-latency',
        'high-quality-recording',
        'mass-audience-HLS',
      ]);
      for (const p of presets) {
        expect(p.sets.length).toBeGreaterThan(0);
        expect(p.useCase.length).toBeGreaterThan(0);
      }
    });

    it('404s for a missing app', async () => {
      await expect(apps.listConfigPresets('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('applyConfigPreset — low-latency', () => {
    it('sets passthrough + simulcast and hot-reloads', async () => {
      const res = await apps.applyConfigPreset('live', 'low-latency');
      expect(res.applied).toBe(true);
      expect(res.reloaded).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.diff.length).toBeGreaterThan(0);

      const cfg = await apps.getConfig('live');
      expect(cfg.transcoding!.enabled).toBe(false);
      expect(cfg.webrtc.adaptive).toBe(true);
      expect(cfg.rtmp.transcode).toBe(false);
      expect(cfg.features.adaptivePlayer).toBe(true);

      // Forward-looking distribution/hls blocks persist in the raw yaml.
      const disk = diskConfig('live');
      expect(disk.distribution.mode).toBe('edge');
      expect(disk.hls.segment_seconds).toBe(2);
    });
  });

  describe('applyConfigPreset — high-quality-recording', () => {
    it('enables transcoding + adaptive VOD ladder (sorted highest-first)', async () => {
      await apps.applyConfigPreset('live', 'high-quality-recording');
      const cfg = await apps.getConfig('live');
      expect(cfg.transcoding!.enabled).toBe(true);
      expect(cfg.transcoding!.encoding).toBe('h264');
      expect(cfg.transcoding!.vodAdaptive).toBe(true);
      expect(cfg.transcoding!.vodRenditions).toEqual([
        { height: 1080, bitrateKbps: 5000 },
        { height: 720, bitrateKbps: 2800 },
        { height: 480, bitrateKbps: 1400 },
      ]);
      expect(cfg.recording.enabled).toBe(true);
      expect(cfg.rtmp.transcode).toBe(true);
    });
  });

  describe('applyConfigPreset — mass-audience-HLS', () => {
    it('sets an HLS ladder behind a CDN', async () => {
      await apps.applyConfigPreset('live', 'mass-audience-HLS');
      const cfg = await apps.getConfig('live');
      expect(cfg.transcoding!.enabled).toBe(true);
      expect(cfg.transcoding!.vodAdaptive).toBe(true);

      const disk = diskConfig('live');
      expect(disk.distribution.mode).toBe('cdn');
      expect(disk.hls.segment_seconds).toBe(4);
      expect(disk.hls.list_size).toBe(10);
    });
  });

  describe('INVARIANT — never overwrites credentials/secrets', () => {
    it('keeps the S3 block + credentials and the callbacks secret intact', async () => {
      // Seed real S3 credentials + a webhook secret first.
      await apps.setS3('live', {
        bucket: 'my-private-bucket',
        region: 'us-east-1',
        key: 'AKIA-REAL-KEY',
        secret: 'super-secret-value',
      });
      await apps.updateConfig('live', {
        callbacks: { url: 'https://hook.example', secret: 'hmac-secret' },
      });

      const before = diskConfig('live');
      const beforeSecrets = fs.readFileSync(
        path.join(ctx.config.dataDir, 'data', 'secrets.json'),
        'utf8',
      );

      await apps.applyConfigPreset('live', 'high-quality-recording');

      // S3 block unchanged (bucket + secret REFS), secret vault untouched.
      const s3 = await apps.getS3('live');
      expect(s3.bucket).toBe('my-private-bucket');
      expect(s3.configured).toBe(true);
      expect(s3.hasKey && s3.hasSecret).toBe(true);
      const after = diskConfig('live');
      expect(after.s3).toEqual(before.s3);
      expect(
        fs.readFileSync(
          path.join(ctx.config.dataDir, 'data', 'secrets.json'),
          'utf8',
        ),
      ).toBe(beforeSecrets);

      // Callbacks secret survives the preset.
      const cfg = await apps.getConfig('live');
      expect(cfg.callbacks.secret).toBe('hmac-secret');
      expect(cfg.callbacks.url).toBe('https://hook.example');

      // …but the delivery keys the preset owns DID change.
      expect(cfg.transcoding!.enabled).toBe(true);
    });

    it('takes a timestamped backup before applying', async () => {
      const before = (await apps.listConfigBackups('live')).length;
      await apps.applyConfigPreset('live', 'low-latency');
      const after = (await apps.listConfigBackups('live')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('errors', () => {
    it('404s for an unknown preset', async () => {
      await expect(
        apps.applyConfigPreset('live', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s for a missing app', async () => {
      await expect(
        apps.applyConfigPreset('ghost', 'low-latency'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when the current config.yaml is not parseable', async () => {
      fs.writeFileSync(
        path.join(apps.appDir('live'), 'config.yaml'),
        '::: not yaml :::\n\tbad',
        'utf8',
      );
      await expect(
        apps.applyConfigPreset('live', 'low-latency'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
