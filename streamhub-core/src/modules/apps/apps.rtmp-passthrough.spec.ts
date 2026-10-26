/**
 * Unit spec — AppsService `rtmp.passthrough` config + the passthrough⇄transcode
 * MUTUAL-EXCLUSION invariant (feature rtmp-passthrough). RTMP→HLS passthrough
 * (remux, no re-encode) cannot coexist with any transcode/adaptive path.
 * Locks down BOTH directions on updateConfig + a disk round-trip:
 *  - a NEW app has passthrough OFF;
 *  - enabling passthrough forces rtmp.transcode / transcoding.enabled /
 *    webrtc.adaptive OFF;
 *  - enabling ANY of those forces passthrough OFF.
 *
 * Same harness as apps.transcoding-config.spec.ts (real temp DB + real
 * S3Service/SecretsStore + stub ModuleRef).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { AppsService } from './apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig } from '../../shared/contracts';

function buildApps(ctx: UnitContext): AppsService {
  const s3 = new S3Service();
  const secrets = new SecretsStore(ctx.config);
  const samplesFake = { generate: jest.fn(async () => []) };
  const moduleRef = { get: jest.fn(() => samplesFake) } as unknown as never;
  return ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
}

describe('AppsService — rtmp.passthrough mutual exclusion', () => {
  let ctx: UnitContext;
  let apps: AppsService;

  const configPath = (name: string): string =>
    path.join(apps.appDir(name), 'config.yaml');
  const up = (name: string, p: Record<string, unknown>): Promise<AppConfig> =>
    apps.updateConfig(name, p as unknown as Partial<AppConfig>);

  beforeEach(() => {
    ctx = makeUnitContext();
    apps = buildApps(ctx);
  });
  afterEach(() => ctx.cleanup());

  it('a NEW app has rtmp.passthrough = false (opt-in)', async () => {
    await apps.create({ name: 'fresh' });
    const cfg = await apps.getConfig('fresh');
    expect(cfg.rtmp.passthrough).toBe(false);
  });

  it('enabling passthrough forces transcode / transcoding.enabled / webrtc.adaptive OFF', async () => {
    await apps.create({ name: 'ptapp' });
    // Precondition: a fresh app ships transcode true + adaptive true.
    const before = await apps.getConfig('ptapp');
    expect(before.rtmp.transcode).toBe(true);
    expect(before.webrtc.adaptive).toBe(true);

    const merged = await up('ptapp', { rtmp: { passthrough: true } });

    expect(merged.rtmp.passthrough).toBe(true);
    expect(merged.rtmp.transcode).toBe(false);
    expect(merged.transcoding!.enabled).toBe(false);
    expect(merged.webrtc.adaptive).toBe(false);

    // persisted snake_case on disk + round-trips through a fresh read
    const disk = yaml.load(
      fs.readFileSync(configPath('ptapp'), 'utf8'),
    ) as Record<string, any>;
    expect(disk.rtmp.passthrough).toBe(true);
    expect(disk.rtmp.transcode).toBe(false);
    expect(disk.webrtc.adaptive).toBe(false);
    expect((await apps.getConfig('ptapp')).rtmp.passthrough).toBe(true);
  });

  it('enabling transcoding.enabled forces passthrough OFF', async () => {
    await apps.create({ name: 'flip1' });
    await up('flip1', { rtmp: { passthrough: true } });
    expect((await apps.getConfig('flip1')).rtmp.passthrough).toBe(true);

    const merged = await up('flip1', { transcoding: { enabled: true } });
    expect(merged.rtmp.passthrough).toBe(false);
    expect(merged.transcoding!.enabled).toBe(true);
  });

  it('enabling rtmp.transcode forces passthrough OFF', async () => {
    await apps.create({ name: 'flip2' });
    await up('flip2', { rtmp: { passthrough: true } });
    expect((await apps.getConfig('flip2')).rtmp.passthrough).toBe(true);

    const merged = await up('flip2', { rtmp: { transcode: true } });
    expect(merged.rtmp.passthrough).toBe(false);
    expect(merged.rtmp.transcode).toBe(true);
  });

  it('enabling webrtc.adaptive forces passthrough OFF', async () => {
    await apps.create({ name: 'flip3' });
    await up('flip3', { rtmp: { passthrough: true } });
    expect((await apps.getConfig('flip3')).rtmp.passthrough).toBe(true);

    const merged = await up('flip3', {
      webrtc: { adaptive: true, layers: [{ name: 'high', height: 720 }] },
    });
    expect(merged.rtmp.passthrough).toBe(false);
    expect(merged.webrtc.adaptive).toBe(true);
  });

  it('passthrough wins when the SAME patch contradictorily sets both', async () => {
    await apps.create({ name: 'both' });
    const merged = await up('both', {
      rtmp: { passthrough: true, transcode: true },
      transcoding: { enabled: true },
    });
    expect(merged.rtmp.passthrough).toBe(true);
    expect(merged.rtmp.transcode).toBe(false);
    expect(merged.transcoding!.enabled).toBe(false);
  });
});
