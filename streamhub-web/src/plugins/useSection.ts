/**
 * Section state for a multi-section plugin surface (Studio deep links).
 *
 * A Studio App's TabComponent renders several primary-surface sections (vision:
 * overview/streams/events; streamflow: workflows/editor/runs). When the HOST
 * drives the section from the URL (StudioAppPage passes `ctx.section` +
 * `ctx.onSectionChange`, bound to the `:section` route param), the plugin is
 * CONTROLLED — the active section and navigation come from the route, so the
 * view is deep-linkable and the Back button works. Otherwise (mounted as a plain
 * app-tab with no router section) it falls back to internal `useState`.
 *
 * `valid` is the plugin's declared section ids; an out-of-range `ctx.section`
 * (or none) resolves to `fallback`, so an unknown URL segment can never blank
 * the surface. Pure of the router — StudioAppPage owns the URL binding.
 */
import { useState } from 'react'
import type { PluginContext } from './types.ts'

export function useSection<S extends string>(
  ctx: PluginContext,
  valid: readonly S[],
  fallback: S,
): [S, (section: S) => void] {
  const [local, setLocal] = useState<S>(fallback)
  const controlled = typeof ctx.onSectionChange === 'function'
  if (controlled) {
    const current = valid.includes(ctx.section as S) ? (ctx.section as S) : fallback
    return [current, (section: S) => ctx.onSectionChange!(section)]
  }
  return [local, setLocal]
}
