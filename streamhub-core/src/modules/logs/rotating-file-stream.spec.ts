/**
 * Unit specs for RotatingFileStream retention (module logs).
 *
 * Exercises the archive sweep over a real temp dir: age-based cleanup (matching
 * BOTH the current `streamhub-*` and any configured legacy prefix) and the
 * count cap. The active `streamhub.log` is never a sweep target.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RotatingFileStream } from './rotating-file-stream';

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-rfs-'));
}

/** Create a file and stamp its mtime `ageDays` in the past. */
function makeFile(dir: string, name: string, ageDays: number): void {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(p, when, when);
}

describe('RotatingFileStream retention', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sweeps archives older than maxAgeDays across both prefixes, keeps the rest', () => {
    makeFile(dir, 'streamhub-2020-01-01T00-00-00-000Z.log', 40); // aged, current
    makeFile(dir, 'legacy-2020-02-01T00-00-00-000Z.log', 40); // aged, legacy
    makeFile(dir, 'streamhub-2026-06-30T00-00-00-000Z.log', 1); // recent
    makeFile(dir, 'streamhub.log', 0); // active — never swept

    const rfs = new RotatingFileStream({
      dir,
      baseName: 'streamhub',
      legacyBaseNames: ['legacy'],
      maxFiles: 100, // count cap out of the way
      maxAgeDays: 30,
    });
    rfs.sweep();

    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual(
      ['streamhub-2026-06-30T00-00-00-000Z.log', 'streamhub.log'].sort(),
    );
  });

  it('honors the count cap (keeps the newest maxFiles archives)', () => {
    makeFile(dir, 'streamhub-a.log', 4);
    makeFile(dir, 'streamhub-b.log', 3);
    makeFile(dir, 'streamhub-c.log', 2);
    makeFile(dir, 'streamhub-d.log', 1); // newest

    const rfs = new RotatingFileStream({
      dir,
      baseName: 'streamhub',
      maxFiles: 2,
      maxAgeDays: 0, // age cap disabled
    });
    rfs.sweep();

    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual(['streamhub-c.log', 'streamhub-d.log']);
  });

  it('does not delete anything when both caps are satisfied', () => {
    makeFile(dir, 'streamhub-x.log', 1);
    makeFile(dir, 'streamhub.log', 0);

    const rfs = new RotatingFileStream({
      dir,
      baseName: 'streamhub',
      maxFiles: 10,
      maxAgeDays: 30,
    });
    rfs.sweep();

    expect(fs.readdirSync(dir).sort()).toEqual(
      ['streamhub-x.log', 'streamhub.log'].sort(),
    );
  });
});
