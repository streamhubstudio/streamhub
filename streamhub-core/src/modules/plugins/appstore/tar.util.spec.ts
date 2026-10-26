/**
 * Unit specs for the dependency-free USTAR reader/extractor — it round-trips the
 * exporter's writer (`packTarGz`) and refuses path-traversal on extract.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { packTarGz, type TarEntry } from '../plugin-export.service';
import { extractTarGz, listTarGzPaths, unpackTarGz } from './tar.util';

describe('tar.util', () => {
  const entries: TarEntry[] = [
    { name: 'lpr/worker/lpr_worker/__init__.py', body: Buffer.from('# init\n') },
    { name: 'lpr/worker/requirements.txt', body: Buffer.from('fast-alpr\n') },
    { name: 'lpr/Dockerfile', body: Buffer.from('FROM python:3.11-slim\n') },
  ];

  it('round-trips pack → unpack (names + bodies preserved)', () => {
    const gz = packTarGz(entries);
    const got = unpackTarGz(gz).sort((a, b) => a.name.localeCompare(b.name));
    expect(got.map((e) => e.name)).toEqual([
      'lpr/Dockerfile',
      'lpr/worker/lpr_worker/__init__.py',
      'lpr/worker/requirements.txt',
    ]);
    const init = got.find((e) => e.name.endsWith('__init__.py'))!;
    expect(init.body.toString('utf8')).toBe('# init\n');
  });

  it('listTarGzPaths returns just the paths', () => {
    const paths = listTarGzPaths(packTarGz(entries));
    expect(paths).toContain('lpr/worker/lpr_worker/__init__.py');
  });

  it('returns [] for non-gzip / garbage input', () => {
    expect(unpackTarGz(Buffer.from('not a gzip'))).toEqual([]);
  });

  it('extracts to disk under the destination dir', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'untar-'));
    try {
      const n = extractTarGz(packTarGz(entries), dest);
      expect(n).toBe(3);
      expect(
        fs.readFileSync(
          path.join(dest, 'lpr', 'worker', 'lpr_worker', '__init__.py'),
          'utf8',
        ),
      ).toBe('# init\n');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('refuses a path-traversal entry on extract', () => {
    const evil = packTarGz([
      { name: '../escape.txt', body: Buffer.from('pwned') },
    ]);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'untar-evil-'));
    try {
      expect(() => extractTarGz(evil, dest)).toThrow(/unsafe path/);
      expect(fs.existsSync(path.join(dest, '..', 'escape.txt'))).toBe(false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
