/**
 * Dependency-free deterministic USTAR + gzip writer/reader for the app
 * composition scripts (apps-pack / apps-pull). A faithful JS port of the core's
 * TypeScript implementation (streamhub-core/.../plugin-export.service.ts
 * `packTarGz` + appstore/tar.util.ts `unpackTarGz`/`extractTarGz`) so a package
 * packed here extracts identically on the core and vice-versa.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** @typedef {{ name: string, body: Buffer, mode?: number }} TarEntry */

function writeOctal(buf, offset, len, value) {
  const s = value.toString(8).padStart(len - 1, '0')
  buf.write(s, offset, len - 1, 'ascii')
  buf.write('\0', offset + len - 1, 1, 'ascii')
}

function splitName(full) {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' }
  const parts = full.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i + 1).join('/')
    const name = parts.slice(i + 1).join('/')
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix }
    }
  }
  throw new Error(`path too long for tar: ${full}`)
}

function tarHeader(entry) {
  const h = Buffer.alloc(512, 0)
  const { name, prefix } = splitName(entry.name)
  h.write(name, 0, 100, 'utf8')
  writeOctal(h, 100, 8, entry.mode ?? 0o644)
  writeOctal(h, 108, 8, 0) // uid
  writeOctal(h, 116, 8, 0) // gid
  writeOctal(h, 124, 12, entry.body.length)
  writeOctal(h, 136, 12, 0) // mtime — fixed for determinism
  h.fill(' ', 148, 156) // checksum placeholder
  h.write('0', 156, 1, 'ascii') // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  if (prefix) h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  const cs = sum.toString(8).padStart(6, '0')
  h.write(cs, 148, 6, 'ascii')
  h.write('\0', 154, 1, 'ascii')
  h.write(' ', 155, 1, 'ascii')
  return h
}

/** Pack entries into a gzipped USTAR archive. Deterministic (mtime/uid/gid=0). */
export function packTarGz(entries) {
  const blocks = []
  for (const e of entries) {
    blocks.push(tarHeader(e))
    blocks.push(e.body)
    const rem = e.body.length % 512
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0))
  }
  blocks.push(Buffer.alloc(1024, 0)) // two zero blocks terminate the archive
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 })
}

function readField(block, offset, len) {
  const slice = block.subarray(offset, offset + len)
  const nul = slice.indexOf(0)
  return slice.toString('utf8', 0, nul === -1 ? len : nul).trim()
}

/** Parse a gzipped USTAR archive into its regular-file entries. */
export function unpackTarGz(gz) {
  let tar
  try {
    tar = zlib.gunzipSync(gz)
  } catch {
    return []
  }
  const out = []
  let off = 0
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = readField(header, 0, 100)
    const prefix = readField(header, 345, 155)
    const sizeStr = readField(header, 124, 12)
    const size = parseInt(sizeStr || '0', 8)
    const typeflag = String.fromCharCode(header[156] || 0)
    off += 512
    if (!Number.isFinite(size) || size < 0 || off + size > tar.length) break
    const full = prefix ? `${prefix}/${name}` : name
    if ((typeflag === '0' || typeflag === '\0') && name) {
      out.push({ name: full, body: Buffer.from(tar.subarray(off, off + size)) })
    }
    off += Math.ceil(size / 512) * 512
  }
  return out
}

/** Extract a gzipped USTAR archive under destDir, refusing traversal paths. */
export function extractTarGz(gz, destDir) {
  const root = path.resolve(destDir)
  fs.mkdirSync(root, { recursive: true })
  let written = 0
  for (const entry of unpackTarGz(gz)) {
    const target = path.resolve(root, entry.name)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`unsafe path in bundle: ${entry.name}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.body)
    written += 1
  }
  return written
}
