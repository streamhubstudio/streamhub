/**
 * Shared helpers for the app composition scripts (apps-pack / apps-pull /
 * apps-bump). Pure Node builtins — no dependencies.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root = two levels up from scripts/lib/. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Hex SHA-256 of a buffer. */
export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Directories that are build/cache/VCS noise, never source. */
const EXCLUDED_DIRS = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.git',
  '.venv', 'venv', 'env', 'node_modules', '.idea', '.vscode', 'build', 'dist',
])

/** Anything bigger than this is a model/weights binary — skip it (source-only). */
const MAX_FILE_BYTES = 5 * 1024 * 1024

function isJunkFile(name) {
  if (name === '.DS_Store') return true
  if (/\.py[cod]$/.test(name)) return true
  if (/\.db(-journal|-wal|-shm)?$/.test(name)) return true
  return false
}

/** Worker source: skip caches, compiled python, dbs, and model binaries. */
export function isWorkerFileExcluded(name) {
  return isJunkFile(name)
}

/** Frontend source: additionally drop tests (they run in the app's own repo). */
export function isFrontendFileExcluded(name) {
  if (isJunkFile(name)) return true
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(name)) return true
  return false
}

/**
 * Recursively collect a directory into TarEntry[] under `prefix`, sorted for
 * determinism. `excludeFile(name)` drops individual files; EXCLUDED_DIRS +
 * `.egg-info` dirs are always skipped; files over 5 MiB are skipped.
 */
export function collectDir(absDir, prefix, excludeFile = () => false) {
  /** @type {{name:string, body:Buffer}[]} */
  const out = []
  const walk = (abs, rel) => {
    const dirents = fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (EXCLUDED_DIRS.has(d.name) || d.name.endsWith('.egg-info')) continue
        walk(path.join(abs, d.name), rel ? `${rel}/${d.name}` : d.name)
      } else if (d.isFile()) {
        if (excludeFile(d.name)) continue
        const full = path.join(abs, d.name)
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue
        const name = `${prefix}/${rel ? `${rel}/` : ''}${d.name}`
        out.push({ name, body: fs.readFileSync(full) })
      }
    }
  }
  walk(absDir, '')
  return out
}

/**
 * Rewrite a vendored frontend file's imports so its ONE-level-up references
 * into the shared framework dir (`src/plugins/`) still resolve from
 * `src/plugins-vendor/<id>/`. Both dirs sit directly under `src/`, so only
 * single-`../` specifiers (which point INTO the sibling `plugins/` dir) need
 * `../../plugins/`; anything `../../…` (src/lib, …) already resolves the same
 * from either location and is left untouched.
 */
export function rewriteVendorImports(source) {
  return source.replace(
    /(\bfrom\s+['"]|\bimport\s*\(\s*['"]|\bimport\s+['"])\.\.\/(?!\.\.)/g,
    '$1../../plugins/',
  )
}

/** Read + parse apps.lock.json (defaults to []). */
export function readLock(lockPath = path.join(REPO_ROOT, 'apps.lock.json')) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('apps.lock.json must be a JSON array')
    return parsed
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

/** Write apps.lock.json (stable 2-space JSON). */
export function writeLock(entries, lockPath = path.join(REPO_ROOT, 'apps.lock.json')) {
  fs.writeFileSync(lockPath, JSON.stringify(entries, null, 2) + '\n')
}

/** rm -rf then mkdir -p. */
export function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}
