/**
 * Unit spec — ExamplesService + ExamplesController (downloadable bundles).
 *
 * Real per-app wiring via `makeUnitContext` with a genuine AppsService +
 * SamplesService collaborator (same harness as the sibling samples suites).
 * Nothing dials LiveKit/Redis/S3/network. Locks down:
 *   - list(): the 9-example catalogue with per-app download URLs + config keys,
 *   - zipOne()/zipAll()/zipByName(): valid zips pre-configured for the app,
 *   - id validation (traversal → 400, unknown → 404, missing app → 404),
 *   - the controller enforces `sample:read` (RBAC metadata).
 */
import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ExamplesService } from './examples.service';
import { ExamplesController } from './examples.controller';
import { SamplesService } from './samples.service';
import { SAMPLE_FILES } from './sample-templates';
import { AppsService } from '../apps/apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { REQUIRE_PERMISSION_KEY } from '../authz/permission.decorator';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

const SIG_LOCAL = 0x04034b50;
const SIG_EOCD = 0x06054b50;

function isZip(buf: Buffer): boolean {
  return (
    buf.length >= 22 &&
    buf.readUInt32LE(0) === SIG_LOCAL &&
    buf.readUInt32LE(buf.length - 22) === SIG_EOCD
  );
}

describe('ExamplesService', () => {
  let ctx: UnitContext;
  let apps: AppsService;
  let samples: SamplesService;
  let examples: ExamplesService;

  beforeEach(async () => {
    ctx = makeUnitContext();
    const s3 = new S3Service();
    const secrets = new SecretsStore(ctx.config);
    const moduleRef = {
      get: () => ({ generate: async () => [] }),
    } as unknown as never;
    apps = ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
    samples = ctx.newService(SamplesService, ctx.config, apps);
    examples = ctx.newService(ExamplesService, samples);

    await apps.create({ name: 'shop', displayName: 'Shop' });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe('list', () => {
    it('returns one catalogue entry per shipped sample with download URLs', async () => {
      const items = await examples.list('shop');
      expect(items).toHaveLength(SAMPLE_FILES.length);
      const files = items.map((i) => i.file).sort();
      expect(files).toEqual([...SAMPLE_FILES].sort());
      for (const it of items) {
        expect(it.downloadUrl).toContain(
          `/api/v1/apps/shop/examples/${it.id}.zip`,
        );
        for (const k of ['baseUrl', 'wsUrl', 'app', 'room']) {
          expect(it.requiredConfig).toContain(k);
        }
      }
    });

    it('throws NotFound for a missing app', async () => {
      await expect(examples.list('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('zipOne', () => {
    it('builds a valid zip pre-configured for the app', async () => {
      const { filename, buffer } = await examples.zipOne('shop', 'webrtc-play');
      expect(filename).toBe('webrtc-play.zip');
      expect(isZip(buffer)).toBe(true);
      // Store method → config.js bytes appear verbatim; proves per-app wiring.
      expect(buffer.includes(Buffer.from('config.js'))).toBe(true);
      expect(buffer.includes(Buffer.from('index.html'))).toBe(true);
      expect(buffer.includes(Buffer.from('app: "shop"'))).toBe(true);
    });

    it('rejects a traversal / unsafe id with 400', async () => {
      await expect(examples.zipOne('shop', '../etc')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFound for an unknown example id', async () => {
      await expect(
        examples.zipOne('shop', 'does-not-exist'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound for a missing app', async () => {
      await expect(
        examples.zipOne('ghost', 'webrtc-play'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('zipAll / zipByName', () => {
    it('zipAll bundles every example under its own folder', async () => {
      const { filename, buffer } = await examples.zipAll('shop');
      expect(filename).toBe('streamhub-examples.zip');
      expect(isZip(buffer)).toBe(true);
      expect(buffer.includes(Buffer.from('webrtc-play/index.html'))).toBe(true);
      expect(buffer.includes(Buffer.from('conference/config.js'))).toBe(true);
    });

    it('zipByName routes all.zip → combined, <id>.zip → single', async () => {
      const all = await examples.zipByName('shop', 'all.zip');
      expect(all.filename).toBe('streamhub-examples.zip');
      const one = await examples.zipByName('shop', 'hls-player.zip');
      expect(one.filename).toBe('hls-player.zip');
    });
  });
});

describe('ExamplesController — RBAC', () => {
  it('gates every route on sample:read', () => {
    const perm = { resource: 'sample', action: 'read' };
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, ExamplesController.prototype.list),
    ).toEqual(perm);
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSION_KEY,
        ExamplesController.prototype.download,
      ),
    ).toEqual(perm);
  });
});
