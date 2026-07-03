/**
 * Unit spec — AppsService `transcoding:` config block (feature
 * transcoding-adaptive-vod).
 *
 * Locks down the per-app transcoding defaults + persistence:
 *  - INVARIANT: a NEW app is created with server-side transcoding DISABLED
 *    (`transcoding.enabled: false` = passthrough) — opt-in only.
 *  - encoding default `h264`; `h264+vp8` round-trips through config.yaml.
 *  - back-compat: a legacy config.yaml WITHOUT the `transcoding:` block keeps
 *    its historical behaviour (enabled mirrors `rtmp.transcode`).
 *  - sanitization: bogus encodings fall back to h264; invalid renditions are
 *    dropped, deduped and sorted.
 *
 * Same harness as apps.service.spec.ts (real temp DB + real S3Service /
 * SecretsStore + stub ModuleRef); kept in its own file so the transcoding
 * feature suite is self-contained.
 */
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

describe('AppsService — transcoding config block', () => {
  let ctx: UnitContext;
  let apps: AppsService;

  const configPath = (name: string): string =>
    path.join(apps.appDir(name), 'config.yaml');

  beforeEach(() => {
    ctx = makeUnitContext();
    apps = buildApps(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe('defaults on app creation', () => {
    it('INVARIANT: a new app has transcoding DISABLED (passthrough) by default', async () => {
      await apps.create({ name: 'fresh' });
      const cfg = await apps.getConfig('fresh');
      expect(cfg.transcoding).toEqual({
        enabled: false,
        encoding: 'h264',
        vodAdaptive: false,
        vodRenditions: [],
      });
    });

    it('persists the transcoding block (snake_case, enabled: false) in config.yaml', async () => {
      await apps.create({ name: 'freshdisk' });
      const disk = yaml.load(
        fs.readFileSync(configPath('freshdisk'), 'utf8'),
      ) as Record<string, any>;
      expect(disk.transcoding).toEqual({
        enabled: false,
        encoding: 'h264',
        vod_adaptive: false,
        vod_renditions: [],
      });
    });
  });

  describe('updateConfig round-trip', () => {
    it('enables transcoding + h264+vp8 + adaptive VOD ladder via a resolved patch', async () => {
      await apps.create({ name: 'optin' });
      const merged = await apps.updateConfig('optin', {
        transcoding: {
          enabled: true,
          encoding: 'h264+vp8',
          vodAdaptive: true,
          vodRenditions: [
            { height: 480, bitrateKbps: 1400 },
            { height: 720, bitrateKbps: 2800 },
          ],
        },
      });
      expect(merged.transcoding).toEqual({
        enabled: true,
        encoding: 'h264+vp8',
        vodAdaptive: true,
        // sanitizer sorts the ladder highest-first
        vodRenditions: [
          { height: 720, bitrateKbps: 2800 },
          { height: 480, bitrateKbps: 1400 },
        ],
      });

      // on disk: snake_case, bitrate_kbps
      const disk = yaml.load(
        fs.readFileSync(configPath('optin'), 'utf8'),
      ) as Record<string, any>;
      expect(disk.transcoding.enabled).toBe(true);
      expect(disk.transcoding.encoding).toBe('h264+vp8');
      expect(disk.transcoding.vod_adaptive).toBe(true);
      expect(disk.transcoding.vod_renditions).toEqual([
        { height: 480, bitrate_kbps: 1400 },
        { height: 720, bitrate_kbps: 2800 },
      ]);

      // and it round-trips through a fresh read
      const cfg = await apps.getConfig('optin');
      expect(cfg.transcoding!.enabled).toBe(true);
      expect(cfg.transcoding!.encoding).toBe('h264+vp8');
    });
  });

  describe('back-compat + sanitization', () => {
    it('legacy yaml without a transcoding block: enabled mirrors rtmp.transcode=true', async () => {
      await apps.create({ name: 'legacyon' });
      // Simulate a pre-feature config.yaml: strip the transcoding block.
      const disk = yaml.load(
        fs.readFileSync(configPath('legacyon'), 'utf8'),
      ) as Record<string, any>;
      delete disk.transcoding;
      disk.rtmp = { enabled: true, transcode: true };
      fs.writeFileSync(configPath('legacyon'), yaml.dump(disk), 'utf8');

      const cfg = await apps.getConfig('legacyon');
      expect(cfg.transcoding!.enabled).toBe(true); // historical behaviour kept
      expect(cfg.transcoding!.encoding).toBe('h264');
    });

    it('legacy yaml with rtmp.transcode=false resolves transcoding disabled', async () => {
      await apps.create({ name: 'legacyoff' });
      const disk = yaml.load(
        fs.readFileSync(configPath('legacyoff'), 'utf8'),
      ) as Record<string, any>;
      delete disk.transcoding;
      disk.rtmp = { enabled: true, transcode: false };
      fs.writeFileSync(configPath('legacyoff'), yaml.dump(disk), 'utf8');

      const cfg = await apps.getConfig('legacyoff');
      expect(cfg.transcoding!.enabled).toBe(false);
    });

    it('sanitizes bogus encoding + invalid/duplicate renditions', async () => {
      await apps.create({ name: 'dirty' });
      const disk = yaml.load(
        fs.readFileSync(configPath('dirty'), 'utf8'),
      ) as Record<string, any>;
      disk.transcoding = {
        enabled: true,
        encoding: 'av1', // unknown → h264
        vod_adaptive: true,
        vod_renditions: [
          { height: 720, bitrate_kbps: 2800 },
          { height: 720, bitrate_kbps: 9999 }, // dup height → dropped
          { height: 0, bitrate_kbps: 500 }, // invalid height → dropped
          { height: 480, bitrate_kbps: -5 }, // invalid bitrate → dropped
          { height: 480, bitrate_kbps: 1400 },
        ],
      };
      fs.writeFileSync(configPath('dirty'), yaml.dump(disk), 'utf8');

      const cfg = await apps.getConfig('dirty');
      expect(cfg.transcoding!.encoding).toBe('h264');
      expect(cfg.transcoding!.vodRenditions).toEqual([
        { height: 720, bitrateKbps: 2800 },
        { height: 480, bitrateKbps: 1400 },
      ]);
    });
  });
});
