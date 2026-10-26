/**
 * Unit spec — AppsService G4 config presets (apply + list + deactivate).
 *
 * Same harness as apps.transcoding-config.spec.ts (real temp DB + real
 * S3Service / SecretsStore + stub ModuleRef). Locks down:
 *   - GET presets → the four profiles, each with an `applied` flag,
 *   - applying each preset writes the expected values into config.yaml and
 *     hot-reloads (getConfig reflects them),
 *   - INVARIANT: applying a preset NEVER overwrites S3 credentials/refs or the
 *     callbacks secret,
 *   - a timestamped backup is taken, the diff is returned, and unknown
 *     app/preset → 404,
 *   - G4 fold-2 — toggle with a negative: deactivating an applied preset
 *     reverts its keys to the app's factory defaults (or removes the
 *     forward-looking distribution/hls keys entirely), also never touching
 *     credentials, and `applied` flips false→true→false across the cycle.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AppsService } from './apps.service';
import { PRESET_DEFAULT_CONFIG } from './config-presets';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

function buildApps(ctx: UnitContext): AppsService {
  const s3 = new S3Service();
  const secrets = new SecretsStore(ctx.config);
  const samplesFake = { generate: jest.fn(async () => []) };
  const moduleRef = { get: jest.fn(() => samplesFake) } as unknown as never;
  const apps = ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
  // Egress SSRF guard DNS seam: resolve every host to a public IP (no network).
  apps.hostResolver = async () => ['93.184.216.34'];
  return apps;
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
    it('returns the profiles (incl. rtmp-passthrough) with a description of what each sets', async () => {
      const presets = await apps.listConfigPresets('live');
      expect(presets.map((p) => p.name)).toEqual([
        'low-latency',
        'high-quality-recording',
        'mass-audience-HLS',
        'rtmp-passthrough',
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

    it('G4 fold-2: none is `applied` on a freshly-created app', async () => {
      const presets = await apps.listConfigPresets('live');
      for (const p of presets) expect(p.applied).toBe(false);
    });

    it('G4 fold-2: flags exactly the applied preset (and no other) after an apply', async () => {
      await apps.applyConfigPreset('live', 'high-quality-recording');
      const presets = await apps.listConfigPresets('live');
      const byName = Object.fromEntries(presets.map((p) => [p.name, p.applied]));
      expect(byName['high-quality-recording']).toBe(true);
      // Overlaps with mass-audience-HLS on transcoding.enabled/vod_adaptive
      // but NOT on the ladder/recording/rtmp/distribution keys — must tell apart.
      expect(byName['mass-audience-HLS']).toBe(false);
      expect(byName['low-latency']).toBe(false);
      expect(byName['rtmp-passthrough']).toBe(false);
    });

    it('degrades to applied:false for every preset instead of throwing on an unparseable config.yaml', async () => {
      fs.writeFileSync(
        path.join(apps.appDir('live'), 'config.yaml'),
        '::: not yaml :::\n\tbad',
        'utf8',
      );
      const presets = await apps.listConfigPresets('live');
      expect(presets.length).toBeGreaterThan(0);
      for (const p of presets) expect(p.applied).toBe(false);
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

  describe('deactivateConfigPreset (G4 fold-2 — toggle with a negative)', () => {
    it('low-latency: applied flips true→false and the diff reverts what apply set', async () => {
      await apps.applyConfigPreset('live', 'low-latency');
      expect((await apps.listConfigPresets('live')).find((p) => p.name === 'low-latency')!.applied).toBe(true);

      const res = await apps.deactivateConfigPreset('live', 'low-latency');
      expect(res.applied).toBe(false); // `applied` on the RESULT means "preset is now off"
      expect(res.reloaded).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.diff.length).toBeGreaterThan(0);

      expect((await apps.listConfigPresets('live')).find((p) => p.name === 'low-latency')!.applied).toBe(false);

      const cfg = await apps.getConfig('live');
      expect(cfg.rtmp.transcode).toBe(true); // factory default (preset had set it false)

      // The forward-looking distribution/hls blocks are removed entirely —
      // a fresh app never has them.
      const disk = diskConfig('live');
      expect(disk.distribution).toBeUndefined();
      expect(disk.hls).toBeUndefined();
    });

    it('high-quality-recording: reverts transcoding/recording/rtmp/webrtc/features to factory defaults', async () => {
      await apps.applyConfigPreset('live', 'high-quality-recording');
      await apps.deactivateConfigPreset('live', 'high-quality-recording');

      const cfg = await apps.getConfig('live');
      expect(cfg.transcoding!.enabled).toBe(false);
      expect(cfg.transcoding!.vodAdaptive).toBe(false);
      expect(cfg.recording.enabled).toBe(true); // factory default is true
      expect(cfg.rtmp.transcode).toBe(true);
      expect(cfg.webrtc.adaptive).toBe(true);
    });

    it('is idempotent-safe: deactivating a preset that was never applied still yields the factory defaults', async () => {
      const res = await apps.deactivateConfigPreset('live', 'rtmp-passthrough');
      expect(res.applied).toBe(false);
      const cfg = await apps.getConfig('live');
      expect(cfg.rtmp.passthrough).toBe(false);
    });

    it('reuses the safe-editor path: takes a timestamped backup before writing', async () => {
      await apps.applyConfigPreset('live', 'mass-audience-HLS');
      const before = (await apps.listConfigBackups('live')).length;
      await apps.deactivateConfigPreset('live', 'mass-audience-HLS');
      const after = (await apps.listConfigBackups('live')).length;
      expect(after).toBeGreaterThan(before);
    });

    it('INVARIANT: never touches S3 credentials or the callbacks secret', async () => {
      await apps.setS3('live', {
        bucket: 'my-private-bucket',
        region: 'us-east-1',
        key: 'AKIA-REAL-KEY',
        secret: 'super-secret-value',
      });
      await apps.updateConfig('live', {
        callbacks: { url: 'https://hook.example', secret: 'hmac-secret' },
      });
      await apps.applyConfigPreset('live', 'high-quality-recording');

      const before = diskConfig('live');
      await apps.deactivateConfigPreset('live', 'high-quality-recording');
      const after = diskConfig('live');

      expect(after.s3).toEqual(before.s3);
      const cfg = await apps.getConfig('live');
      expect(cfg.callbacks.secret).toBe('hmac-secret');
      expect(cfg.callbacks.url).toBe('https://hook.example');
    });

    it('404s for an unknown preset / missing app', async () => {
      await expect(
        apps.deactivateConfigPreset('live', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        apps.deactivateConfigPreset('ghost', 'low-latency'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when the current config.yaml is not parseable', async () => {
      fs.writeFileSync(
        path.join(apps.appDir('live'), 'config.yaml'),
        '::: not yaml :::\n\tbad',
        'utf8',
      );
      await expect(
        apps.deactivateConfigPreset('live', 'low-latency'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('PRESET_DEFAULT_CONFIG — stays in sync with a fresh app (regression guard)', () => {
    it('matches the resolved config of a brand-new app for every block a preset can touch', async () => {
      await apps.create({ name: 'fresh', displayName: 'Fresh' });
      const cfg = await apps.getConfig('fresh');

      expect(cfg.recording.enabled).toBe((PRESET_DEFAULT_CONFIG.recording as any).enabled);
      expect(cfg.recording.mode).toBe((PRESET_DEFAULT_CONFIG.recording as any).mode);
      expect(cfg.webrtc.adaptive).toBe((PRESET_DEFAULT_CONFIG.webrtc as any).adaptive);
      expect(cfg.webrtc.layers).toEqual((PRESET_DEFAULT_CONFIG.webrtc as any).layers);
      expect(cfg.rtmp.enabled).toBe((PRESET_DEFAULT_CONFIG.rtmp as any).enabled);
      expect(cfg.rtmp.transcode).toBe((PRESET_DEFAULT_CONFIG.rtmp as any).transcode);
      expect(cfg.rtmp.passthrough).toBe((PRESET_DEFAULT_CONFIG.rtmp as any).passthrough);
      expect(cfg.transcoding!.enabled).toBe((PRESET_DEFAULT_CONFIG.transcoding as any).enabled);
      expect(cfg.transcoding!.encoding).toBe((PRESET_DEFAULT_CONFIG.transcoding as any).encoding);
      expect(cfg.transcoding!.vodAdaptive).toBe((PRESET_DEFAULT_CONFIG.transcoding as any).vod_adaptive);
      expect(cfg.features.adaptivePlayer).toBe((PRESET_DEFAULT_CONFIG.features as any).adaptive_player);

      // Raw disk shape too, for the snake_case fields getConfig doesn't surface.
      const disk = diskConfig('fresh');
      expect(disk.recording.layout).toBe((PRESET_DEFAULT_CONFIG.recording as any).layout);
      expect(disk.features.viewer_counter).toBe((PRESET_DEFAULT_CONFIG.features as any).viewer_counter);
      expect(disk.features.hidden_qc).toBe((PRESET_DEFAULT_CONFIG.features as any).hidden_qc);
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
