/**
 * Unit spec — dependency-free STORE-method ZIP writer (zip.ts).
 *
 * Verifies the produced archive is a structurally valid PKZIP file (local
 * headers + central directory + EOCD) and round-trips content back out via a
 * tiny in-test reader (STORE = uncompressed, so parsing is trivial). Guards the
 * example-download endpoint, which relies on this instead of a zip binary.
 */
import { createZip, type ZipEntry } from './zip';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Minimal STORE-only reader: walk local headers back into { name: data }. */
function readZip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === SIG_LOCAL) {
    const compSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const dataStart = p + 30 + nameLen + extraLen;
    out[name] = buf.subarray(dataStart, dataStart + compSize);
    p = dataStart + compSize;
  }
  return out;
}

describe('createZip', () => {
  const entries: ZipEntry[] = [
    { name: 'index.html', data: '<!doctype html><h1>hi</h1>' },
    { name: 'config.js', data: 'window.STREAMHUB_CONFIG = { app: "acme" };' },
    { name: 'sub/README.md', data: Buffer.from('# readme\n', 'utf8') },
  ];

  it('produces a structurally valid archive (local sig + EOCD + count)', () => {
    const zip = createZip(entries);
    expect(zip.readUInt32LE(0)).toBe(SIG_LOCAL);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(SIG_EOCD);
    expect(zip.readUInt16LE(eocd + 10)).toBe(entries.length); // total entries
    // A central directory record exists for each entry.
    let central = 0;
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (zip.readUInt32LE(i) === SIG_CENTRAL) central++;
    }
    expect(central).toBe(entries.length);
  });

  it('round-trips every entry (name + exact bytes)', () => {
    const back = readZip(createZip(entries));
    expect(Object.keys(back).sort()).toEqual(
      entries.map((e) => e.name).sort(),
    );
    for (const e of entries) {
      const expected = Buffer.isBuffer(e.data)
        ? e.data
        : Buffer.from(e.data, 'utf8');
      expect(back[e.name].equals(expected)).toBe(true);
    }
  });

  it('preserves nested paths (folder members)', () => {
    const back = readZip(createZip(entries));
    expect(back['sub/README.md'].toString('utf8')).toBe('# readme\n');
  });

  it('handles an empty archive', () => {
    const zip = createZip([]);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(SIG_EOCD);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(0); // zero entries
  });
});
