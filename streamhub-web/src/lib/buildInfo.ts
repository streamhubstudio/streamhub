/**
 * Build/version helpers for the About / Build panel.
 *
 * `__SH_WEB_BUILD__` is injected by vite.config.ts (`define`) at build time;
 * under the test runners it doesn't exist, so `webBuild()` degrades to empty
 * fields instead of throwing.
 */
import type { CoreBuildInfo } from '@/api'

export interface WebBuildInfo {
  version: string
  commit: string
  builtAt: string
  node: string
  vite: string
  react: string
}

declare const __SH_WEB_BUILD__: WebBuildInfo | undefined

const EMPTY: WebBuildInfo = { version: '', commit: '', builtAt: '', node: '', vite: '', react: '' }

export function webBuild(): WebBuildInfo {
  try {
    return typeof __SH_WEB_BUILD__ === 'object' && __SH_WEB_BUILD__ ? { ...EMPTY, ...__SH_WEB_BUILD__ } : EMPTY
  } catch {
    return EMPTY
  }
}

/** First 7 chars of a git sha ("" stays ""; "dev" stays "dev"). */
export function shortCommit(sha: string | null | undefined): string {
  const s = (sha ?? '').trim()
  return /^[0-9a-f]{8,}$/i.test(s) ? s.slice(0, 7) : s
}

/**
 * Do the SPA and the core come from different builds? True only when both
 * report a commit and they differ — a stale SPA in front of a newer core (or
 * the reverse) is the classic "the button doesn't exist" support ticket.
 */
export function buildsDiverge(core: Pick<CoreBuildInfo, 'commit'> | undefined, web: Pick<WebBuildInfo, 'commit'>): boolean {
  const a = (core?.commit ?? '').trim()
  const b = web.commit.trim()
  if (!a || !b || b === 'dev') return false
  return !(a.startsWith(b) || b.startsWith(a))
}

/** "go1.26.8" → "1.26.8"; "v26.8.1" → "26.8.1". */
export function bareVersion(v: string | null | undefined): string {
  return (v ?? '').trim().replace(/^(go|v)/, '')
}
