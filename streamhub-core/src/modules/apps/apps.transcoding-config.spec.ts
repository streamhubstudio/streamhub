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

    it('clears the rendition ladder when webrtc.layers is an explicit empty array', async () => {
      await apps.create({ name: 'noladder' });
      // fresh app seeds high/med/low
      expect((await apps.getConfig('noladder')).webrtc!.layers!.length).toBe(3);

      await apps.updateConfig('noladder', { webrtc: { layers: [] } });

      // persisted as an empty ladder (no MinSize rejection, not silently kept)
      const disk = yaml.load(
        fs.readFileSync(configPath('noladder'), 'utf8'),
      ) as Record<string, any>;
      expect(disk.webrtc.layers).toEqual([]);
      // clearing the ladder disables adaptive (no renditions to switch between)
      expect(disk.webrtc.adaptive).toBe(false);
      expect((await apps.getConfig('noladder')).webrtc!.layers).toEqual([]);
      expect((await apps.getConfig('noladder')).webrtc!.adaptive).toBe(false);

      // omitting layers on a later patch leaves the (now empty) ladder untouched
      await apps.updateConfig('noladder', { webrtc: { adaptive: false } });
      expect((await apps.getConfig('noladder')).webrtc!.layers).toEqual([]);
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

  // ===========================================================================
  // webrtc.transcode_max_height — the efficient-transcode resolution cap
  // ===========================================================================
  describe('webrtc.transcode_max_height (ingress resolution cap)', () => {
    it('a new app defaults the cap to 720 (resolved + persisted snake_case)', async () => {
      await apps.create({ name: 'capdef' });
      expect((await apps.getConfig('capdef')).webrtc.transcodeMaxHeight).toBe(720);
      const disk = yaml.load(
        fs.readFileSync(configPath('capdef'), 'utf8'),
      ) as Record<string, any>;
      expect(disk.webrtc.transcode_max_height).toBe(720);
    });

    it('updateConfig persists a new cap (round-trips through config.yaml)', async () => {
      await apps.create({ name: 'cap480' });
      const merged = await apps.updateConfig('cap480', {
        webrtc: { transcodeMaxHeight: 480 } as never,
      });
      expect(merged.webrtc.transcodeMaxHeight).toBe(480);

      const disk = yaml.load(
        fs.readFileSync(configPath('cap480'), 'utf8'),
      ) as Record<string, any>;
      expect(disk.webrtc.transcode_max_height).toBe(480);
      // untouched ladder survives a cap-only patch
      expect(disk.webrtc.layers.length).toBe(3);
      expect((await apps.getConfig('cap480')).webrtc.transcodeMaxHeight).toBe(480);
    });

    it('sanitizes an out-of-set / garbage cap in a hand-edited yaml', async () => {
      await apps.create({ name: 'capdirty' });
      const disk = yaml.load(
        fs.readFileSync(configPath('capdirty'), 'utf8'),
      ) as Record<string, any>;

      disk.webrtc.transcode_max_height = 1440; // snaps to the nearest tier → 1080
      fs.writeFileSync(configPath('capdirty'), yaml.dump(disk), 'utf8');
      expect((await apps.getConfig('capdirty')).webrtc.transcodeMaxHeight).toBe(1080);

      disk.webrtc.transcode_max_height = 240; // → 360
      fs.writeFileSync(configPath('capdirty'), yaml.dump(disk), 'utf8');
      expect((await apps.getConfig('capdirty')).webrtc.transcodeMaxHeight).toBe(360);

      disk.webrtc.transcode_max_height = 'nope'; // garbage → 720 default
      fs.writeFileSync(configPath('capdirty'), yaml.dump(disk), 'utf8');
      expect((await apps.getConfig('capdirty')).webrtc.transcodeMaxHeight).toBe(720);
    });

    it('a legacy yaml WITHOUT the cap resolves to the 720 default', async () => {
      await apps.create({ name: 'caplegacy' });
      const disk = yaml.load(
        fs.readFileSync(configPath('caplegacy'), 'utf8'),
      ) as Record<string, any>;
      delete disk.webrtc.transcode_max_height;
      fs.writeFileSync(configPath('caplegacy'), yaml.dump(disk), 'utf8');
      expect((await apps.getConfig('caplegacy')).webrtc.transcodeMaxHeight).toBe(720);
    });
  });
});
