/**
 * Integration spec: the LOCAL worker spawn RESOLVES a pinned version to the
 * extracted bundle dir. child_process is mocked; we assert the spawn spec's
 * cwd/PYTHONPATH point at `…/extracted/<id>/worker` when the install is pinned,
 * and at the built-in source dir when it is not.
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { makeTestConfig, mockLogsService } from '../../../../test/helpers';
import { AppPluginsRepository } from '../app-plugins.repository';
import {
  composePluginBundle,
  packTarGz,
} from '../plugin-export.service';
import { PluginManifest, PluginMeta, toManifest } from '../plugin.contract';
import { PluginRegistryService } from '../plugin-registry.service';
import { PluginWorkerManager } from '../plugin-worker.manager';
import { AppstoreService } from './appstore.service';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp: any = new EventEmitter();
  cp.pid = 4242;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn(() => {
    cp.emit('exit', 0, 'SIGTERM');
    return true;
  });
  return cp;
}

const BUILTIN_DIR = path.join(path.sep, 'repo', 'demo-worker');

const META: PluginMeta = {
  id: 'demo',
  name: 'Demo',
  description: '',
  category: 'processor',
  ui: 'app-tab',
  version: '1.0.0',
  kind: 'app',
  needsWorker: true,
  export: { workerDir: 'demo-worker' },
  configSchema: [],
  worker: {
    spawn: (ctx) => ({
      command: 'python3',
      args: ['-m', 'demo_worker', '--app', ctx.app],
      cwd: BUILTIN_DIR,
      env: { PYTHONPATH: BUILTIN_DIR, DEMO_APP: ctx.app },
    }),
  },
};

const APP = 'live';

function fakeRegistry(): PluginRegistryService {
  return {
    listManifests: (): PluginManifest[] => [toManifest(META)],
    getMeta: () => META,
  } as unknown as PluginRegistryService;
}

/** A repo stub returning a fixed pin (or null). */
function repoStub(version: string | null): AppPluginsRepository {
  return { get: () => ({ workerVersion: version }) } as unknown as AppPluginsRepository;
}

describe('worker spawn — pinned version resolution', () => {
  let appstore: AppstoreService;
  let dataDir: string;
  let srcRoot: string;
  let prevSrcRoot: string | undefined;
  let child: ReturnType<typeof fakeChild>;
  let extractedWorker: string;

  beforeEach(() => {
    const t = makeTestConfig();
    dataDir = t.dataDir;
    srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-src-'));
    const pkg = path.join(srcRoot, 'demo-worker', 'demo_worker');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, '__init__.py'), '# demo\n');
    prevSrcRoot = process.env.STREAMHUB_WORKER_SRC_ROOT;
    process.env.STREAMHUB_WORKER_SRC_ROOT = srcRoot;

    appstore = new AppstoreService(fakeRegistry(), t.config, mockLogsService());
    const gz = packTarGz(
      composePluginBundle(META, 'demo', path.join(srcRoot, 'demo-worker')),
    );
    appstore.saveUploaded('demo', '2.9.0', gz);
    extractedWorker = appstore.resolveExtractedWorkerDir('demo', '2.9.0');

    child = fakeChild();
    (spawn as jest.Mock).mockReturnValue(child);
  });

  afterEach(() => {
    (spawn as jest.Mock).mockReset();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(srcRoot, { recursive: true, force: true });
    if (prevSrcRoot === undefined) delete process.env.STREAMHUB_WORKER_SRC_ROOT;
    else process.env.STREAMHUB_WORKER_SRC_ROOT = prevSrcRoot;
  });

  it('spawns from the extracted pinned dir when the install is pinned', () => {
    const t = makeTestConfig({ DATA_DIR: dataDir });
    const mgr = new PluginWorkerManager(
      t.config,
      mockLogsService(),
      undefined,
      undefined,
      appstore,
      repoStub('2.9.0'),
    );
    mgr.start(META, APP, '/apps/live', {});
    expect(spawn).toHaveBeenCalledWith(
      'python3',
      ['-m', 'demo_worker', '--app', APP],
      expect.objectContaining({
        cwd: extractedWorker,
        env: expect.objectContaining({ PYTHONPATH: extractedWorker }),
      }),
    );
    mgr.onModuleDestroy();
  });

  it('spawns from the built-in source dir when the install is NOT pinned', () => {
    const t = makeTestConfig({ DATA_DIR: dataDir });
    const mgr = new PluginWorkerManager(
      t.config,
      mockLogsService(),
      undefined,
      undefined,
      appstore,
      repoStub(null),
    );
    mgr.start(META, APP, '/apps/live', {});
    expect(spawn).toHaveBeenCalledWith(
      'python3',
      ['-m', 'demo_worker', '--app', APP],
      expect.objectContaining({ cwd: BUILTIN_DIR }),
    );
    mgr.onModuleDestroy();
  });
});
