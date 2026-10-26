/**
 * Unit specs for AppLogService — the per-app rotated log sink (Vision-Edge §F).
 *
 * Smoke-tests: writes land in `<dataDir>/apps/<app>/logs/app.log`, a tiny
 * `LOG_MAX_BYTES` forces size rotation (archives appear), a raw string line is
 * written verbatim, and separate apps get separate files. Yields to the event
 * loop between writes so the underlying WriteStream flushes to disk before each
 * rotation's on-disk size guard runs.
 */
import * as fs from 'fs';
import * as path from 'path';

import { AppLogService } from './app-log.service';
import { ConfigService } from '../../shared/config/config.service';
import { createTmpDataDir } from '../../../test/helpers';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

describe('AppLogService', () => {
  let dataDir: string;
  let prevMaxBytes: string | undefined;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = createTmpDataDir();
    prevMaxBytes = process.env.LOG_MAX_BYTES;
    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    process.env.LOG_MAX_BYTES = '200'; // tiny → force rotation quickly
  });

  afterEach(() => {
    restore('LOG_MAX_BYTES', prevMaxBytes);
    restore('DATA_DIR', prevDataDir);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function restore(key: string, prev: string | undefined): void {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }

  it('writes to apps/<app>/logs/app.log and rotates past LOG_MAX_BYTES', async () => {
    const svc = new AppLogService(new ConfigService());
    for (let i = 0; i < 30; i++) {
      svc.appLog('live', { source: 'test', i, msg: 'x'.repeat(60) });
      await flush();
    }
    svc.onModuleDestroy();
    await flush();

    const dir = path.join(dataDir, 'apps', 'live', 'logs');
    const files = fs.readdirSync(dir);
    expect(files).toContain('app.log');
    const archives = files.filter((f) => /^app-.*\.log$/.test(f));
    expect(archives.length).toBeGreaterThan(0);
  });

  it('writes a raw string line verbatim and never throws', async () => {
    const svc = new AppLogService(new ConfigService());
    expect(() => svc.appLog('live', 'a raw line')).not.toThrow();
    await flush();
    svc.onModuleDestroy();
    await flush();
    const active = path.join(dataDir, 'apps', 'live', 'logs', 'app.log');
    expect(fs.readFileSync(active, 'utf8')).toContain('a raw line');
  });

  it('keeps separate files per app', async () => {
    const svc = new AppLogService(new ConfigService());
    svc.appLog('alpha', { m: 1 });
    svc.appLog('beta', { m: 2 });
    await flush();
    svc.onModuleDestroy();
    await flush();
    expect(
      fs.existsSync(path.join(dataDir, 'apps', 'alpha', 'logs', 'app.log')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(dataDir, 'apps', 'beta', 'logs', 'app.log')),
    ).toBe(true);
  });
});
