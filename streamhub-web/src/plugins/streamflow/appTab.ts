/**
 * Streamflow in-app tab — the PURE visibility predicate (no React/DOM), so it is
 * node:test-able and can be reused by the AppDetail host.
 *
 * Streamflow is given its OWN first-class tab inside an app (not just the Studio
 * deep link) — but only when it is actually installed + active for that app and
 * ships its frontend `app-tab` surface. Other Studio Apps keep the studio route;
 * this is intentionally scoped to streamflow (its "entity").
 */
import type { PluginView } from '../types.ts'

export const STREAMFLOW_ID = 'streamflow'

/** The streamflow view to render as an in-app tab, or undefined when it should not appear. */
export function streamflowTabView(views: PluginView[]): PluginView | undefined {
  return views.find(
    (v) => v.id === STREAMFLOW_ID && v.active && v.hasFrontend && v.ui === 'app-tab',
  )
}

/** Whether the streamflow in-app tab should be shown for this catalog. */
export function hasStreamflowTab(views: PluginView[]): boolean {
  return streamflowTabView(views) !== undefined
}
