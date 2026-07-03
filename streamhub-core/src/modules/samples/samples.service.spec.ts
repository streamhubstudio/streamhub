/**
 * Unit spec — SamplesService (config-samples-apps module, samples half).
 *
 * Exercises per-app sample generation/listing/read/write against a REAL
 * migrated temp DB (harness `makeUnitContext`) with a real AppsService as the
 * collaborator (so `apps.get` / `apps.appDir` / `apps.getConfig` are genuine).
 * Nothing dials LiveKit/Redis/S3.
 *
 * Coverage:
 *   - generate: returns the standard set, writes them, resolves placeholders.
 *   - list: infos + embed URLs, generated flag, sorted, missing app → 404.
 *   - read/write: happy path + filename validation (path traversal, non-.html,
 *     nested path all rejected).
 *   - INVARIANT: strict per-app isolation — editing/regenerating one app's
 *     samples never touches another app's copies.
 *
 * Owned by the config-samples-apps test agent. Touches only this *.spec.ts.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { SamplesService } from './samples.service';
import { SAMPLE_FILES } from './sample-templates';
import { AppsService } from '../apps/apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

describe('SamplesService', () => {
  let ctx: UnitContext;
  let apps: AppsService;
  let samples: SamplesService;

  const sampleDir = (app: string): string =>
    path.join(apps.appDir(app), 'samples');
  const onDisk = (app: string, file: string): string =>
    fs.readFileSync(path.join(sampleDir(app), file), 'utf8');

  beforeEach(async () => {
    ctx = makeUnitContext();
    const s3 = new S3Service();
    const secrets = new SecretsStore(ctx.config);
    // Stub the samples hand-off during app creation so create() doesn't recurse
    // into a second SamplesService; we drive generation explicitly per test.
    const moduleRef = {
      get: () => ({ generate: async () => [] }),
    } as unknown as never;
    apps = ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
    samples = ctx.newService(SamplesService, ctx.config, apps);

    await apps.create({ name: 'alpha', displayName: 'Alpha' });
    await apps.create({ name: 'beta', displayName: 'Beta' });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // ===========================================================================
  // generate
  // ===========================================================================
  describe('generate', () => {
    it('writes the full standard sample set and returns the filenames', async () => {
      const written = await samples.generate('alpha');
      expect(written).toEqual([...SAMPLE_FILES]);
      for (const f of SAMPLE_FILES) {
        expect(fs.existsSync(path.join(sampleDir('alpha'), f))).toBe(true);
      }
    });

    it('resolves the {{APP}} / {{ROOM}} placeholders to the target app', async () => {
      await samples.generate('alpha');
      const html = onDisk('alpha', 'webrtc-publish.html');
      expect(html).toContain("const APP = 'alpha';");
      // No unresolved template tokens remain for known keys.
      expect(html).not.toContain('{{APP}}');
      expect(html).not.toContain('{{ROOM}}');
    });

    it('throws NotFound generating for a missing app', async () => {
      await expect(samples.generate('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ===========================================================================
  // list
  // ===========================================================================
  describe('list', () => {
    it('lists the generated files (sorted) with embed URLs + generated=true', async () => {
      await samples.generate('alpha');
      const infos = await samples.list('alpha');
      const names = infos.map((i) => i.name);

      // Sorted ascending, and every standard template shows up as generated.
      expect(names).toEqual([...names].sort());
      for (const f of SAMPLE_FILES) {
        const info = infos.find((i) => i.name === f);
        expect(info).toBeDefined();
        expect(info?.generated).toBe(true);
        expect(info?.sizeBytes).toBeGreaterThan(0);
        expect(info?.embedUrl).toContain('/samples/alpha/');
        expect(info?.embedUrl).toContain(f);
      }
    });

    it('flags a non-template file as generated=false', async () => {
      await samples.generate('alpha');
      await samples.write('alpha', 'custom.html', '<html>custom</html>');
      const info = (await samples.list('alpha')).find(
        (i) => i.name === 'custom.html',
      );
      expect(info).toBeDefined();
      expect(info?.generated).toBe(false);
    });

    it('flags the legacy publish/play/embed pages as generated=false', async () => {
      // create() scaffolds the legacy sample pages; they are NOT template files.
      const infos = await samples.list('alpha');
      for (const legacy of ['publish.html', 'play.html', 'embed.html']) {
        const info = infos.find((i) => i.name === legacy);
        expect(info).toBeDefined();
        expect(info?.generated).toBe(false);
      }
    });

    it('throws NotFound listing a missing app', async () => {
      await expect(samples.list('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ===========================================================================
  // read / write + filename validation
  // ===========================================================================
  describe('read / write', () => {
    beforeEach(async () => {
      await samples.generate('alpha');
    });

    it('reads a generated file verbatim', async () => {
      const content = await samples.read('alpha', 'hls-player.html');
      expect(content).toBe(onDisk('alpha', 'hls-player.html'));
    });

    it('write then read round-trips new content', async () => {
      await samples.write('alpha', 'webrtc-publish.html', '<h1>edited</h1>');
      expect(await samples.read('alpha', 'webrtc-publish.html')).toBe(
        '<h1>edited</h1>',
      );
    });

    it('can create a brand-new (non-template) sample file', async () => {
      await samples.write('alpha', 'extra.html', '<p>hi</p>');
      expect(await samples.read('alpha', 'extra.html')).toBe('<p>hi</p>');
    });

    it('read throws NotFound for an unknown file', async () => {
      await expect(
        samples.read('alpha', 'does-not-exist.html'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['../../etc/passwd', 'path traversal'],
      ['sub/nested.html', 'nested path'],
      ['notes.txt', 'non-.html extension'],
      ['..%2f..%2fx.html', 'encoded traversal'],
      ['', 'empty name'],
    ])('read rejects unsafe filename %p (%s) with 400', async (file) => {
      await expect(samples.read('alpha', file)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['../escape.html', 'path traversal'],
      ['sub/nested.html', 'nested path'],
      ['payload.js', 'non-.html extension'],
    ])('write rejects unsafe filename %p (%s) with 400', async (file) => {
      await expect(
        samples.write('alpha', file, 'x'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('write throws NotFound for a missing app', async () => {
      await expect(
        samples.write('ghost', 'webrtc-publish.html', 'x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===========================================================================
  // INVARIANT — per-app isolation
  // ===========================================================================
  describe('per-app isolation', () => {
    beforeEach(async () => {
      await samples.generate('alpha');
      await samples.generate('beta');
    });

    it('editing one app\'s sample never touches another app\'s copy', async () => {
      await samples.write(
        'alpha',
        'webrtc-publish.html',
        '<h1>ALPHA-ONLY</h1>',
      );
      const betaHtml = await samples.read('beta', 'webrtc-publish.html');
      expect(betaHtml).not.toContain('ALPHA-ONLY');
      expect(betaHtml).toContain("const APP = 'beta';");
    });

    it('regenerating one app does not clobber another app\'s edits', async () => {
      await samples.write('alpha', 'hls-player.html', '<h1>ALPHA-EDIT</h1>');
      // Regenerate beta from templates.
      await samples.generate('beta');
      // Alpha's edit survives untouched.
      expect(await samples.read('alpha', 'hls-player.html')).toBe(
        '<h1>ALPHA-EDIT</h1>',
      );
      // Beta was regenerated cleanly.
      expect(await samples.read('beta', 'hls-player.html')).toContain(
        "const APP = 'beta';",
      );
    });

    it('a generated sample is scoped to its own app dir only', async () => {
      await samples.generate('alpha');
      expect(fs.existsSync(path.join(sampleDir('alpha'), 'audio-radio.html'))).toBe(
        true,
      );
      // beta has its own independent copy (different resolved APP constant).
      expect(onDisk('alpha', 'audio-radio.html')).toContain("const APP = 'alpha';");
      expect(onDisk('beta', 'audio-radio.html')).toContain("const APP = 'beta';");
    });
  });
});
