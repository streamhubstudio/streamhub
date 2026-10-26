/**
 * Unit — product version resolution (modules/health/app-version.ts).
 *
 * The dashboard footer / `/health` / `/auth/config.appVersion` must show the
 * REAL product version (repo-root `VERSION` file, e.g. 2.7.0), never the
 * streamhub-core package.json `0.1.0`. Locks down:
 *  - versionFromFile(): first line trimmed; null on missing/empty/oversized;
 *  - resolveAppVersion(): first readable candidate wins, then
 *    npm_package_version, then 'dev';
 *  - the default candidates actually find the repo-root VERSION file when run
 *    from streamhub-core (this jest run) and the value looks like a semver;
 *  - getAppVersion() caches (same instance across calls).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getAppVersion,
  resolveAppVersion,
  versionFromFile,
} from './app-version';

const REPO_VERSION_FILE = path.resolve(process.cwd(), '..', 'VERSION');

describe('app-version', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-version-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeVersion(content: string, name = 'VERSION'): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, content);
    return file;
  }

  describe('versionFromFile', () => {
    it('returns the first line, trimmed', () => {
      expect(versionFromFile(writeVersion('2.7.0\n'))).toBe('2.7.0');
      expect(versionFromFile(writeVersion('  3.0.0-rc.1  \nnotes\n'))).toBe(
        '3.0.0-rc.1',
      );
    });

    it('null for a missing, empty or implausibly long file', () => {
      expect(versionFromFile(path.join(tmp, 'nope'))).toBeNull();
      expect(versionFromFile(writeVersion(''))).toBeNull();
      expect(versionFromFile(writeVersion('   \n'))).toBeNull();
      expect(versionFromFile(writeVersion('x'.repeat(64)))).toBeNull();
    });
  });

  describe('resolveAppVersion', () => {
    it('first readable candidate wins', () => {
      const missing = path.join(tmp, 'missing');
      const real = writeVersion('9.9.9\n');
      expect(resolveAppVersion([missing, real])).toBe('9.9.9');
    });

    it('falls back to npm_package_version, then dev', () => {
      const missing = path.join(tmp, 'missing');
      const prev = process.env.npm_package_version;
      try {
        process.env.npm_package_version = '0.1.0';
        expect(resolveAppVersion([missing])).toBe('0.1.0');
        delete process.env.npm_package_version;
        expect(resolveAppVersion([missing])).toBe('dev');
      } finally {
        if (prev === undefined) delete process.env.npm_package_version;
        else process.env.npm_package_version = prev;
      }
    });

    it('default candidates find the repo-root VERSION file (real product version)', () => {
      // jest runs from streamhub-core/ → ../VERSION is the repo root file.
      const expected = fs.readFileSync(REPO_VERSION_FILE, 'utf8').trim();
      const resolved = resolveAppVersion();
      expect(resolved).toBe(expected);
      // The whole point of the feature: NOT the core package.json 0.1.0.
      expect(resolved).not.toBe('0.1.0');
      expect(resolved).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getAppVersion', () => {
    it('returns the resolved version and is stable across calls', () => {
      const first = getAppVersion();
      expect(first).toBe(resolveAppVersion());
      expect(getAppVersion()).toBe(first);
    });
  });
});
