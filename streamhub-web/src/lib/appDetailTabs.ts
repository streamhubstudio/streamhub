/**
 * AppDetail's built-in tab catalog + the legacy-tab redirect map — extracted
 * from pages/AppDetail.tsx so the routing rules are node:test-able (the page
 * itself is .tsx, which node's type-stripping test runner can't import).
 */
export type TabId =
  | 'overview'
  | 'config'
  | 'streams'
  | 'vods'
  | 'ingress'
  | 'streamflow'
  | 'samples'
  | 'plugins'
  | 'sistema'

/**
 * Tabs ordered by everyday flow. "Tablero" (overview) leads as the default
 * landing tab; the advanced "Config" tab is kept LAST:
 *  overview → live → recordings → ingest → samples → plugins → ops → config.
 * The old top-level Tokens / Integraciones / Logs tabs were folded INTO the
 * Config tab's new "System" section (`?tab=config&section=system&sub=…`) to trim
 * the vertical column — legacy `?tab=tokens|integraciones|logs` deep links are
 * redirected there (see LEGACY_SUBNAV_REDIRECT below).
 * Labels/hints are resolved via i18n (appDetail:tabs.<id>).
 */
export const TAB_IDS: TabId[] = [
  'overview',
  'streams',
  'vods',
  'ingress',
  'samples',
  'plugins',
  'sistema',
  'config',
]

/**
 * Legacy top-level tabs that were relocated into the Config → System section.
 * An old `?tab=<id>` deep link (still published in docs / bookmarks) resolves to
 * the Config tab and is rewritten to the canonical System sub URL.
 */
export const LEGACY_SUBNAV_REDIRECT: Record<string, string> = {
  tokens: 'tokens',
  integraciones: 'integraciones',
  logs: 'logs',
}

/** A built-in tab (always present) — excludes the conditional streamflow tab. */
export function isBuiltinTab(v: string | null): v is TabId {
  return TAB_IDS.some((id) => id === v)
}
