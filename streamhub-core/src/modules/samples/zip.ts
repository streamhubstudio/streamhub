/**
 * Minimal, dependency-free ZIP writer (STORE method — no compression).
 *
 * The example-download endpoint runs inside the core image, which ships no zip
 * library and cannot assume a `zip` binary is present. Example bundles are a
 * handful of small text files, so STORE (uncompressed) is perfectly adequate and
 * keeps this to a well-understood ~90 lines: local file headers + a central
 * directory + the end-of-central-directory record, all little-endian, per the
 * PKZIP APPNOTE. Produces standard `.zip` archives openable by any unzip tool.
 */

/** One archive member. */
export interface ZipEntry {
  /** Path inside the archive (forward slashes; e.g. `webrtc-play/index.html`). */
  name: string;
  /** File contents. */
  data: Buffer | string;
}

// CRC-32 (IEEE 802.3) table, built once.
const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (1980-01-01 00:00:00) for deterministic, reproducible zips.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Build a STORE-method ZIP archive from the given entries. */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8');
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    // Local file header (30 bytes + name).
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression (0 = store)
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, dataBuf);

    // Central directory record (46 bytes + name).
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // compression
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20); // compressed size
    central.writeUInt32LE(size, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localDir = Buffer.concat(localParts);

  // End of central directory record (22 bytes).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(localDir.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localDir, centralDir, eocd]);
}
