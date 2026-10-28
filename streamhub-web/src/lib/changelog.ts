/**
 * Changelog model for the About / Build panel.
 *
 * Input is the repo-root CHANGELOG.md as served by GET /system/changelog
 * (embedded into the core binary at build time). Each `## <version>` heading
 * starts a release; anything before the first one is the preamble. Releases
 * are returned newest first by semantic version — whatever order the file
 * happens to be in — with headings that aren't versions (e.g. `## Unreleased`)
 * kept on top in file order.
 */

export interface ChangelogRelease {
  /** Normalised version without a leading "v", or the raw heading text. */
  version: string
  /** Full heading text after `## `, e.g. "3.1.0 — 2026-10-27". */
  title: string
  /** Markdown body under the heading (excluding the heading line). */
  body: string
  /** True when `version` parsed as X.Y.Z[-pre]. */
  semver: boolean
}

export interface Changelog {
  preamble: string
  releases: ChangelogRelease[]
}

const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/

/** "v3.1.0" / "3.1.0 — date" / "[3.1.0](…)" → "3.1.0"; null when not a version. */
export function versionOf(heading: string): string | null {
  const h = heading.trim().replace(/^\[([^\]]+)\](\([^)]*\))?/, '$1')
  const m = h.match(VERSION_RE)
  return m ? m[1] : null
}

/** Semver-ish compare (pre-releases sort before their release). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa = ''] = a.split('-', 2)
  const [mb, pb = ''] = b.split('-', 2)
  const na = ma.split('.').map(Number)
  const nb = mb.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (na[i] || 0) - (nb[i] || 0)
    if (d) return d
  }
  if (pa === pb) return 0
  if (!pa) return 1
  if (!pb) return -1
  return pa < pb ? -1 : 1
}

export function parseChangelog(md: string): Changelog {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const pre: string[] = []
  const rel: ChangelogRelease[] = []
  let cur: { title: string; body: string[] } | null = null
  let inFence = false
  const push = () => {
    if (!cur) return
    const v = versionOf(cur.title)
    rel.push({ version: v ?? cur.title, title: cur.title, body: cur.body.join('\n').trim(), semver: v !== null })
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence && line.match(/^##\s+(.+?)\s*$/)
    if (m) {
      push()
      cur = { title: m[1], body: [] }
      continue
    }
    if (cur) cur.body.push(line)
    else pre.push(line)
  }
  push()
  const named = rel.filter((r) => !r.semver)
  const versions = rel.filter((r) => r.semver).sort((a, b) => compareVersions(b.version, a.version))
  return { preamble: pre.join('\n').replace(/^#\s+.*\n?/, '').trim(), releases: [...named, ...versions] }
}

/** Normalise a running version ("v3.1.0", " 3.1.0\n") for comparisons. */
export function normalizeVersion(v: string | null | undefined): string {
  return (v ?? '').trim().replace(/^v/, '')
}

/** The release matching the running version, if the changelog has it. */
export function findRelease(log: Changelog, running: string | null | undefined): ChangelogRelease | undefined {
  const v = normalizeVersion(running)
  return v ? log.releases.find((r) => r.version === v) : undefined
}
