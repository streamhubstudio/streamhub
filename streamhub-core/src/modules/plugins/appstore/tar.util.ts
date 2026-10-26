/**
 * Minimal, dependency-free USTAR reader + extractor — the counterpart to the
 * deterministic USTAR *writer* in `plugin-export.service` (`packTarGz`). Used by
 * the appstore to VALIDATE an uploaded bundle's shape and to EXTRACT a pinned
 * bundle to disk before a worker spawns from it.
 *
 * Only the subset the writer emits is understood: regular files (typeflag '0'
 * or '\0') and directories ('5'); anything else (symlinks, longlink GNU
 * extensions, …) is skipped rather than trusted — the writer never produces
 * them, so an upload that carries them is simply ignored for those entries.
 *
 * SECURITY: {@link extractTarGz} refuses any entry whose resolved path escapes
 * the destination directory (absolute paths, `..` traversal), so a malicious
 * bundle can never write outside its own `extracted/` dir.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { TarEntry } from '../plugin-export.service';

/** Read a NUL-terminated ASCII/UTF-8 field from a header block. */
function readField(block: Buffer, offset: number, len: number): string {
  const slice = block.subarray(offset, offset + len);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? len : nul).trim();
}

/**
 * Parse a gzipped USTAR archive into its regular-file entries. Never throws on a
 * structurally-odd archive: it stops at the first zero-block terminator or when
 * the buffer runs out. Directory entries are dropped (files carry their own
 * parent paths). Returns `[]` for an empty/garbage buffer.
 */
export function unpackTarGz(gz: Buffer): TarEntry[] {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(gz);
  } catch {
    return [];
  }
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    // Two consecutive zero blocks terminate the archive; one is enough to stop.
    if (header.every((b) => b === 0)) break;
    const name = readField(header, 0, 100);
    const prefix = readField(header, 345, 155);
    const sizeStr = readField(header, 124, 12);
    const size = parseInt(sizeStr || '0', 8);
    const typeflag = String.fromCharCode(header[156] || 0);
    off += 512;
    if (!Number.isFinite(size) || size < 0 || off + size > tar.length) break;
    const full = prefix ? `${prefix}/${name}` : name;
    // Regular file: typeflag '0' (explicit) or '\0' (legacy). Skip dirs ('5')
    // and everything else — we only carry file bytes.
    if ((typeflag === '0' || typeflag === '\0') && name) {
      out.push({ name: full, body: Buffer.from(tar.subarray(off, off + size)) });
    }
    // Advance past the body, padded to the next 512-byte boundary.
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * Extract a gzipped USTAR archive under `destDir` (created if needed). Refuses
 * any entry that would escape `destDir` (absolute path / `..` traversal) — the
 * extraction is a trusted, sha256-verified bundle, but we still fail closed on a
 * traversal path rather than write outside the sandbox. Returns the number of
 * files written.
 */
export function extractTarGz(gz: Buffer, destDir: string): number {
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const entry of unpackTarGz(gz)) {
    const target = path.resolve(root, entry.name);
    // Traversal guard: the resolved path must stay under root.
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`unsafe path in bundle: ${entry.name}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.body);
    written += 1;
  }
  return written;
}

/** Convenience: the set of archive paths in a bundle (for shape validation). */
export function listTarGzPaths(gz: Buffer): string[] {
  return unpackTarGz(gz).map((e) => e.name);
}
