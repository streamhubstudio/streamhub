/**
 * Unit specs for the immutable appstore bundle store:
 *   - builtin materialization is idempotent (skips a warm store),
 *   - uploads validate semver + shape + entrypoint and are immutable (dupe 409),
 *   - the sha256 is computed server-side and VERIFIED before an extract (a
 *     tampered bundle refuses to extract),
 *   - built-ins are undeletable; uploaded versions delete cleanly,
 *   - `latest` tracks the highest uploaded semver.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { makeTestConfig, mockLogsService } from '../../../../test/helpers';
import {
  composePluginBundle,
  packTarGz,
  type TarEntry,
} from '../plugin-export.service';
import {
  PluginManifest,
  PluginMeta,
  toManifest,
} from '../plugin.contract';
import { PluginRegistryService } from '../plugin-registry.service';
import { AppstoreService, sha256 } from './appstore.service';

const META: PluginMeta = {
  id: 'demo',
  name: 'Demo App',
  description: 'versionable demo',
  category: 'processor',
  ui: 'app-tab',
  version: '1.0.0',
  kind: 'app',
  needsWorker: true,
  export: { workerDir: 'demo-worker' },
  configSchema: [{ key: 'room', type: 'string', label: 'Room', default: '' }],
  worker: {
    spawn(ctx) {
      return {
        command: 'python3',
        args: ['-m', 'demo_worker', '--app', ctx.app],
        cwd: '/whatever/demo-worker',
        env: { PYTHONPATH: '/whatever/demo-worker' },
      };
    },
  },
};

/** A registry stub exposing just what the appstore reads. */
function fakeRegistry(metas: PluginMeta[]): PluginRegistryService {
  const byId = new Map(metas.map((m) => [m.id, m]));
  return {
    listManifests: (): PluginManifest[] => metas.map(toManifest),
    getMeta: (id: string): PluginMeta | undefined => byId.get(id),
  } as unknown as PluginRegistryService;
}

describe('AppstoreService', () => {
  let svc: AppstoreService;
  let dataDir: string;
  let srcRoot: string;
  let prevSrcRoot: string | undefined;

  /** A valid uploaded bundle (built the exact way the exporter would). */
  const validBundle = (): Buffer =>
    packTarGz(composePluginBundle(META, 'demo', path.join(srcRoot, 'demo-worker')));

  beforeEach(() => {
    const t = makeTestConfig();
    dataDir = t.dataDir;
    const cfg = t.config;
    // A worker source tree the exporter/materializer can read.
    srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appstore-src-'));
    const pkg = path.join(srcRoot, 'demo-worker', 'demo_worker');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, '__init__.py'), '# demo\n');
    fs.writeFileSync(
      path.join(srcRoot, 'demo-worker', 'requirements.txt'),
      'opencv-python-headless\n',
    );
    prevSrcRoot = process.env.STREAMHUB_WORKER_SRC_ROOT;
    process.env.STREAMHUB_WORKER_SRC_ROOT = srcRoot;

    svc = new AppstoreService(fakeRegistry([META]), cfg, mockLogsService());
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(srcRoot, { recursive: true, force: true });
    if (prevSrcRoot === undefined) delete process.env.STREAMHUB_WORKER_SRC_ROOT;
    else process.env.STREAMHUB_WORKER_SRC_ROOT = prevSrcRoot;
  });

  describe('builtin materialization', () => {
    it('materializes a builtin-<coreVersion> bundle, idempotently', () => {
      const first = svc.materializeBuiltins();
      expect(first).toBe(1);
      const builtin = svc.builtinVersionId();
      expect(svc.hasVersion('demo', builtin)).toBe(true);
      const manifest = svc.readManifest('demo', builtin)!;
      expect(manifest.source).toBe('builtin');
      expect(manifest.sha256).toHaveLength(64);

      // A warm store skips it entirely (no re-pack).
      expect(svc.materializeBuiltins()).toBe(0);
    });

    it('lists the builtin as builtin+latest when nothing is uploaded', () => {
      svc.materializeBuiltins();
      const cat = svc.listVersions('demo');
      expect(cat.builtinVersion).toBe(svc.builtinVersionId());
      expect(cat.latestVersion).toBe(svc.builtinVersionId());
      const only = cat.versions.find((v) => v.builtin)!;
      expect(only.latest).toBe(true);
    });
  });

  describe('upload (immutable)', () => {
    it('stores an uploaded version with a server-computed sha256', () => {
      const gz = validBundle();
      const m = svc.saveUploaded('demo', '2.9.0', gz, 'my custom build');
      expect(m).toMatchObject({
        pluginId: 'demo',
        version: '2.9.0',
        source: 'uploaded',
        notes: 'my custom build',
        sha256: sha256(gz),
      });
      expect(svc.hasVersion('demo', '2.9.0')).toBe(true);
    });

    it('rejects a duplicate version with 409 (immutable)', () => {
      svc.saveUploaded('demo', '2.9.0', validBundle());
      expect(() => svc.saveUploaded('demo', '2.9.0', validBundle())).toThrow(
        ConflictException,
      );
    });

    it('rejects a non-semver version', () => {
      expect(() => svc.saveUploaded('demo', 'v2', validBundle())).toThrow(
        BadRequestException,
      );
    });

    it("rejects a reserved 'builtin-*' version", () => {
      expect(() =>
        svc.saveUploaded('demo', 'builtin-9.9.9', validBundle()),
      ).toThrow(BadRequestException);
    });

    it('rejects a non-gzip upload', () => {
      expect(() =>
        svc.saveUploaded('demo', '2.9.0', Buffer.from('not gzip at all')),
      ).toThrow(/not a gzip/);
    });

    it('rejects a bundle missing the worker entrypoint', () => {
      const noEntry: TarEntry[] = [
        { name: 'demo/worker/readme.txt', body: Buffer.from('hi') },
        { name: 'demo/worker/other.py', body: Buffer.from('x=1\n') },
      ];
      expect(() =>
        svc.saveUploaded('demo', '2.9.0', packTarGz(noEntry)),
      ).toThrow(/entrypoint/);
    });

    it('rejects an unversionable plugin (no exportable worker)', () => {
      const plain: PluginMeta = {
        ...META,
        id: 'plain',
        kind: 'plugin',
        needsWorker: false,
        worker: undefined,
        export: undefined,
      };
      const s = new AppstoreService(
        fakeRegistry([plain]),
        makeTestConfig({ DATA_DIR: dataDir }).config,
        mockLogsService(),
      );
      expect(() => s.saveUploaded('plain', '1.0.0', validBundle())).toThrow(
        BadRequestException,
      );
    });
  });

  describe('extract (sha256-verified)', () => {
    it('extracts a pinned bundle and returns its worker dir', () => {
      svc.saveUploaded('demo', '2.9.0', validBundle());
      const workerDir = svc.resolveExtractedWorkerDir('demo', '2.9.0');
      expect(workerDir.endsWith(path.join('extracted', 'demo', 'worker'))).toBe(
        true,
      );
      expect(
        fs.existsSync(path.join(workerDir, 'demo_worker', '__init__.py')),
      ).toBe(true);
    });

    it('refuses to extract a TAMPERED bundle (sha256 mismatch)', () => {
      svc.saveUploaded('demo', '2.9.0', validBundle());
      // Corrupt the stored bundle after its manifest sha256 was recorded.
      const bundlePath = path.join(
        svc.versionDir('demo', '2.9.0'),
        'bundle.tar.gz',
      );
      fs.appendFileSync(bundlePath, Buffer.from([0xff, 0xff, 0xff]));
      expect(() => svc.resolveExtractedWorkerDir('demo', '2.9.0')).toThrow(
        /sha256 mismatch/,
      );
    });

    it('404s extracting an unknown version', () => {
      expect(() => svc.resolveExtractedWorkerDir('demo', '9.9.9')).toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete + latest', () => {
    it('refuses to delete a built-in', () => {
      svc.materializeBuiltins();
      expect(() =>
        svc.deleteVersion('demo', svc.builtinVersionId()),
      ).toThrow(BadRequestException);
    });

    it('deletes an uploaded version', () => {
      svc.saveUploaded('demo', '2.9.0', validBundle());
      svc.deleteVersion('demo', '2.9.0');
      expect(svc.hasVersion('demo', '2.9.0')).toBe(false);
    });

    it('tracks the highest uploaded semver as latest', () => {
      svc.materializeBuiltins();
      svc.saveUploaded('demo', '2.8.0', validBundle());
      svc.saveUploaded('demo', '2.9.0', validBundle());
      expect(svc.listVersions('demo').latestVersion).toBe('2.9.0');
    });
  });
});
