#!/usr/bin/env node
/**
 * apps-pack.mjs <id> — build a distributable Studio App package tar.gz FROM the
 * current in-tree app (internal design notes §4/§5). This is BOTH the
 * F0 pilot tool (pack `lpr`, vendor it, prove the composed build) AND the F1
 * population tool (each app's first release is packed straight from the monorepo
 * before its repo exists).
 *
 * It reads the app's authored declarative manifest
 * `streamhub-core/src/plugins/<id>/streamhub.app.json` — whose `build` block
 * points at the scattered in-tree sources — assembles the canonical package
 * layout, and writes:
 *
 *   dist/packages/streamhub-app-<id>-<version>.tar.gz
 *     streamhub.app.json   the published manifest (with the `build` block stripped)
 *     worker/**            the Python worker package
 *     frontend/**          the web plugin source (tests dropped)
 *     migrations/**        NNN_*.sql, when the app ships any
 *
 * Then it prints the app's sha256 + a ready-to-paste apps.lock.json entry.
 *
 * NO executable JavaScript for the CORE ships in the package — the backend is
 * the declarative manifest only; the interpreter runs it (see spawn-template.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  REPO_ROOT,
  collectDir,
  isFrontendFileExcluded,
  isWorkerFileExcluded,
  sha256,
} from './lib/appcompose.mjs'
import { packTarGz } from './lib/tar.mjs'

function die(msg) {
  console.error(`apps-pack: ${msg}`)
  process.exit(1)
}

const id = process.argv[2]
if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  die('usage: node scripts/apps-pack.mjs <app-id>')
}

const authoredPath = path.join(REPO_ROOT, 'streamhub-core', 'src', 'plugins', id, 'streamhub.app.json')
if (!fs.existsSync(authoredPath)) {
  die(`no authored manifest at ${path.relative(REPO_ROOT, authoredPath)} — author streamhub.app.json (with a build block) first`)
}

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(authoredPath, 'utf8'))
} catch (e) {
  die(`manifest is not valid JSON: ${e.message}`)
}
if (manifest.id !== id) die(`manifest id '${manifest.id}' does not match folder '${id}'`)
if (typeof manifest.version !== 'string') die('manifest is missing a version')

const build = manifest.build ?? {}

// Resolve the in-tree sources named by the build block.
const resolveSrc = (rel, kind) => {
  if (!rel) return null
  const abs = path.resolve(REPO_ROOT, rel)
  if (!fs.existsSync(abs)) die(`${kind} source '${rel}' not found (build.${kind}Src)`)
  return abs
}
const workerSrc = resolveSrc(build.workerSrc, 'worker')
const frontendSrc = resolveSrc(build.frontendSrc, 'frontend')
const migrationsSrc = build.migrationsSrc ? resolveSrc(build.migrationsSrc, 'migrations') : null
// Optional: vendor the shared Python SDK package INTO the worker so the packaged
// worker is self-contained (imports `streamhub_sdk` off its own PYTHONPATH,
// co-located OR standalone). Packed as worker/<sdk-package-name>/**.
const workerSdkSrc = build.workerSdk ? resolveSrc(build.workerSdk, 'workerSdk') : null

// The PUBLISHED manifest drops the build block (monorepo-only glue).
const published = { ...manifest }
delete published.build

/** @type {{name:string, body:Buffer}[]} */
const entries = [
  { name: 'streamhub.app.json', body: Buffer.from(JSON.stringify(published, null, 2) + '\n', 'utf8') },
]
if (workerSrc) entries.push(...collectDir(workerSrc, 'worker', isWorkerFileExcluded))
if (workerSdkSrc) {
  entries.push(...collectDir(workerSdkSrc, `worker/${path.basename(workerSdkSrc)}`, isWorkerFileExcluded))
}
if (frontendSrc) entries.push(...collectDir(frontendSrc, 'frontend', isFrontendFileExcluded))
if (migrationsSrc) entries.push(...collectDir(migrationsSrc, 'migrations'))

// Deterministic order: manifest first, then the collected trees already sorted.
const gz = packTarGz(entries)
// The lock pins the CONTENT hash (uncompressed tar) — stable across gzip re-runs
// (zlib version drift). apps-pull verifies the same way (PACKAGE-FORMAT.md, #50).
const contentDigest = sha256(zlib.gunzipSync(gz))
const gzDigest = sha256(gz)

const outDir = path.join(REPO_ROOT, 'dist', 'packages')
fs.mkdirSync(outDir, { recursive: true })
const outName = `streamhub-app-${id}-${manifest.version}.tar.gz`
const outPath = path.join(outDir, outName)
fs.writeFileSync(outPath, gz)

const rel = path.relative(REPO_ROOT, outPath)
console.log(`packed ${id}@${manifest.version}`)
console.log(`  file:        ${rel}`)
console.log(`  entries:     ${entries.length}`)
console.log(`  bytes:       ${gz.length}`)
console.log(`  sha256:      ${contentDigest}  (content — goes in the lock)`)
console.log(`  gzip sha256: ${gzDigest}  (transport only)`)
console.log('')
console.log('apps.lock.json entry (file: source, for local testing):')
console.log(
  JSON.stringify(
    { id, repo: `local:${id}`, version: manifest.version, sha256: contentDigest, source: `file:./${rel}` },
    null,
    2,
  ),
)
