/**
 * Pure helpers for the G4 config-preset UI (Config tab).
 *
 * The backend returns a unified-style diff (lines prefixed `+ ` / `- ` / `  `)
 * after applying a preset; these helpers summarise it for the UI without any
 * React / network dependency so they stay unit-testable under node:test.
 */

export interface PresetDiffStat {
  added: number
  removed: number
  /** True when the preset actually changed the config. */
  changed: boolean
}

/**
 * Count the added/removed lines of a unified-style preset diff. A line is an
 * addition when it starts with `+ ` and a removal when it starts with `- `
 * (context lines start with two spaces and are ignored). Empty/undefined diffs
 * mean "no change".
 */
export function parsePresetDiff(diff: string | undefined | null): PresetDiffStat {
  if (!diff) return { added: 0, removed: 0, changed: false }
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+ ')) added++
    else if (line.startsWith('- ')) removed++
  }
  return { added, removed, changed: added > 0 || removed > 0 }
}

/**
 * A stable i18n key describing the outcome of applying a preset, so the UI can
 * show the right message without branching logic inline.
 *   - `noChange`   — the config already matched the preset,
 *   - `appliedReloaded` — applied + hot-reloaded in place,
 *   - `appliedWritten`  — applied but the hot-reload reported issues.
 */
export function presetResultKey(res: {
  changed?: boolean
  reloaded?: boolean
}): 'noChange' | 'appliedReloaded' | 'appliedWritten' {
  if (res.changed === false) return 'noChange'
  return res.reloaded ? 'appliedReloaded' : 'appliedWritten'
}
