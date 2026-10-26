#!/usr/bin/env node
/**
 * apps-bump.mjs — the "use latest versions" command (internal design notes
 * -PLAN.md §4). CI NEVER resolves "latest" on its own: a human runs this, reads
 * the current→new diff, and only `--write` mutates `apps.lock.json`. Even then
 * the new sha256 is computed by DOWNLOADING the asset, so the lock stays a
 * verifiable pin.
 *
 *   node scripts/apps-bump.mjs           # dry-run: print available bumps
 *   node scripts/apps-bump.mjs --write   # apply them to apps.lock.json
 *
 * Only `gitlab:` entries can be bumped (a remote release to query). `file:` /
 * `local:` entries are reported as "local — skipped".
 */
import zlib from 'node:zlib'
import {
  REPO_ROOT,
  readLock,
  sha256,
  writeLock,
} from './lib/appcompose.mjs'

const write = process.argv.includes('--write')

function log(msg) {
  console.log(msg)
}
function die(msg) {
  console.error(`apps-bump: ${msg}`)
  process.exit(1)
}

/** Naive semver ordering (major.minor.patch, release > prerelease). */
function semverGt(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?/.exec(v)
    if (!m) return [0, 0, 0, 1]
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1]
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i]
  return false
}

/** Latest release tag + its .tar.gz asset for a gitlab project. */
async function latestGitlabRelease(repoPath, id, token) {
  const host = process.env.STREAMHUB_APPS_GITLAB_HOST ?? 'https://gitlab.com'
  const proj = encodeURIComponent(repoPath)
  const res = await fetch(`${host}/api/v4/projects/${proj}/releases?per_page=1`, {
    headers: { 'PRIVATE-TOKEN': token },
  })
  if (!res.ok) die(`${id}: gitlab releases query failed (${res.status})`)
  const releases = await res.json()
  if (!Array.isArray(releases) || releases.length === 0) return null
  const rel = releases[0]
  const version = String(rel.tag_name ?? '').replace(/^v/, '')
  const wantAsset = `streamhub-app-${id}-${version}.tar.gz`
  const links = rel?.assets?.links ?? []
  const link = links.find((l) => l.name === wantAsset) ?? links.find((l) => l.url?.endsWith('.tar.gz'))
  return { version, assetUrl: link?.url ?? null }
}

async function main() {
  const lock = readLock()
  if (lock.length === 0) {
    log('apps-bump: apps.lock.json is empty — nothing to bump')
    return
  }
  const token = process.env.STREAMHUB_APPS_TOKEN
  let changed = 0

  for (const entry of lock) {
    const repo = entry.repo ?? ''
    if (!repo.startsWith('gitlab:')) {
      log(`  ${entry.id}: ${entry.version} — local/non-gitlab source, skipped`)
      continue
    }
    if (!token) die('STREAMHUB_APPS_TOKEN unset — required to query gitlab releases')
    const info = await latestGitlabRelease(repo.slice('gitlab:'.length), entry.id, token)
    if (!info || !info.version) {
      log(`  ${entry.id}: ${entry.version} — no releases found`)
      continue
    }
    if (!semverGt(info.version, entry.version)) {
      log(`  ${entry.id}: ${entry.version} — up to date`)
      continue
    }
    log(`  ${entry.id}: ${entry.version} → ${info.version}  ${write ? '(updating)' : '(available)'}`)
    if (write) {
      if (!info.assetUrl) die(`${entry.id}: release ${info.version} has no tar.gz asset`)
      const res = await fetch(info.assetUrl, { headers: { 'PRIVATE-TOKEN': token } })
      if (!res.ok) die(`${entry.id}: asset download failed (${res.status})`)
      const gz = Buffer.from(await res.arrayBuffer())
      entry.version = info.version
      // content hash (uncompressed tar) — stable across gzip re-runs (PACKAGE-FORMAT.md)
      entry.sha256 = sha256(zlib.gunzipSync(gz))
      delete entry.source // a remote bump drops any stale file: override
      changed += 1
    }
  }

  if (write && changed > 0) {
    writeLock(lock)
    log(`apps-bump: updated ${changed} entr${changed === 1 ? 'y' : 'ies'} in apps.lock.json`)
  } else if (!write) {
    log('apps-bump: dry-run (pass --write to apply)')
  }
  void REPO_ROOT
}

main().catch((e) => die(e.stack || e.message))
