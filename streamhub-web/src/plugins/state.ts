/**
 * Pure catalog merge: reconcile the frontend registry (discovered plugin
 * modules) with the backend install state (GET /plugins) into a single list of
 * `PluginView` rows the Marketplace + host render from.
 *
 * No React/DOM — unit-tested with node:test (see state.spec.ts).
 */
import { buildInitialValues } from './schema.ts'
import type {
  InstalledPlugin,
  PluginSectionMeta,
  PluginView,
  RegisteredPlugin,
} from './types.ts'

/** A backend record counts as installed unless it explicitly says otherwise. */
function isInstalled(rec?: InstalledPlugin): boolean {
  if (!rec) return false
  return rec.installed !== false
}

/** `active` with `enabled` treated as an alias. */
function isActive(rec?: InstalledPlugin): boolean {
  if (!rec) return false
  return Boolean(rec.active ?? rec.enabled)
}

function toView(
  reg: RegisteredPlugin | undefined,
  rec: InstalledPlugin | undefined,
): PluginView {
  const id = reg?.id ?? rec?.id ?? ''
  const installed = isInstalled(rec)
  const config = buildInitialValues(reg?.configSchema, rec?.config)

  return {
    id,
    name: reg?.name ?? rec?.name ?? id,
    description: reg?.description ?? rec?.description ?? '',
    category: reg?.category ?? rec?.category ?? 'general',
    icon: reg?.icon,
    version: rec?.version ?? reg?.version,
    ui: reg?.ui,
    configSchema: reg?.configSchema,
    // Taxonomy: the backend manifest WINS over the frontend module (same
    // precedence as `version`), defaulting to 'plugin' when neither declares it.
    kind: rec?.kind ?? reg?.kind ?? 'plugin',
    // Edge-capable: backend manifest wins; the frontend module carries it so the
    // registry-only Marketplace catalog badges it too.
    edge: Boolean(rec?.edge ?? reg?.edge),
    // Export + storage are backend-only signals (a frontend module can't know
    // whether the server can bundle a worker).
    storage: rec?.storage ?? null,
    exportable: Boolean(rec?.exportable),
    needsWorker: rec?.needsWorker,
    hasFrontend: Boolean(reg),
    hasBackend: Boolean(rec),
    installed,
    active: installed && isActive(rec),
    // Preserve raw stored config too, but expose the schema-merged bag.
    config,
    registered: reg,
  }
}

/**
 * Merge registered (frontend) + installed (backend) plugins into one catalog,
 * de-duplicated by id and sorted by category then name for a stable grid.
 */
export function mergeCatalog(
  registered: RegisteredPlugin[],
  installed: InstalledPlugin[],
): PluginView[] {
  const byId = new Map<string, { reg?: RegisteredPlugin; rec?: InstalledPlugin }>()

  for (const reg of registered) {
    if (!reg.id) continue
    byId.set(reg.id, { reg })
  }
  for (const rec of installed) {
    if (!rec.id) continue
    const entry = byId.get(rec.id) ?? {}
    entry.rec = rec
    byId.set(rec.id, entry)
  }

  const views: PluginView[] = []
  for (const { reg, rec } of byId.values()) {
    views.push(toView(reg, rec))
  }

  views.sort((a, b) => {
    const c = a.category.localeCompare(b.category)
    return c !== 0 ? c : a.name.localeCompare(b.name)
  })
  return views
}

/** The distinct, sorted category list present in a catalog (for filter chips). */
export function catalogCategories(views: PluginView[]): string[] {
  const set = new Set<string>()
  for (const v of views) set.add(v.category)
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** Find a single view by id (host lookup). */
export function findView(
  views: PluginView[],
  id: string,
): PluginView | undefined {
  return views.find((v) => v.id === id)
}

/** A catalog split into the two shelves the Studio surfaces render. */
export interface KindShelves {
  /** `kind: 'app'` rows — full Studio applications (shown first). */
  apps: PluginView[]
  /** Everything else — simple plugins. */
  plugins: PluginView[]
}

/**
 * Partition a catalog into the Apps / Plugins shelves. Order within each shelf
 * is preserved from the input (already sorted by category then name), so the
 * shelf grids stay stable. Pure → unit-tested.
 */
export function partitionByKind(views: PluginView[]): KindShelves {
  const apps: PluginView[] = []
  const plugins: PluginView[] = []
  for (const v of views) {
    if (v.kind === 'app') apps.push(v)
    else plugins.push(v)
  }
  return { apps, plugins }
}

/**
 * Where the "Open" action for a view leads: a full Studio App opens as its own
 * PAGE (`apps/:app/studio/:id`); a plain plugin opens in the in-place MODAL.
 * Pure decision so the routing stays testable without a router.
 */
export function openTargetFor(view: PluginView): 'page' | 'modal' {
  return view.kind === 'app' ? 'page' : 'modal'
}

/**
 * Convenience: the full-page Studio route for an app's Studio App, optionally
 * deep-linked to one of its declared sections (`…/studio/:id/:section`). Passing
 * no section yields the canonical section-less URL (back-compat), whose section
 * defaults to the app's first declared section.
 */
export function studioAppPath(app: string, pluginId: string, section?: string): string {
  const base = `/apps/${encodeURIComponent(app)}/studio/${encodeURIComponent(pluginId)}`
  return section ? `${base}/${encodeURIComponent(section)}` : base
}

/** The primary-surface sections a view's frontend module declares (empty when none). */
export function sectionsOf(view: PluginView): PluginSectionMeta[] {
  return view.registered?.sections ?? []
}

/** Outcome of matching a URL `:section` segment against a view's sections. */
export interface SectionResolution {
  /** The section to render — the default when the segment is absent/unknown; null when the view declares none. */
  section: string | null
  /** True when the segment was present but not a declared section (caller should redirect to the default). */
  redirect: boolean
}

/**
 * Resolve the studio route's `:section` segment against a plugin's declared
 * sections. Absent segment → the default (first) section, no redirect. Unknown
 * segment → the default section AND `redirect: true` so the page can replace the
 * URL rather than render a blank/crashing surface. A view with no declared
 * sections yields `{ section: null }` (the `:section` param is meaningless).
 * Pure → node:test-able without a router.
 */
export function resolveSection(
  sections: PluginSectionMeta[],
  param: string | undefined,
): SectionResolution {
  if (sections.length === 0) return { section: null, redirect: false }
  const def = sections[0].id
  if (!param) return { section: def, redirect: false }
  const found = sections.some((s) => s.id === param)
  return found ? { section: param, redirect: false } : { section: def, redirect: true }
}

/**
 * Select the active media-player PROVIDER for a catalog, or null.
 *
 * A `player`-slot plugin only wins the player if it is ACTIVE (installed +
 * enabled for the app), present in the frontend registry, AND actually ships a
 * `PlayerComponent` — so a backend-only or component-less install never blanks
 * out the built-in video.js fallback. First match wins (the catalog is sorted by
 * category then name, so selection is deterministic). Returning null is the
 * signal for HlsPlayer/VodPlayer to render their video.js path.
 */
export function pickPlayerProvider(views: PluginView[]): PluginView | null {
  return (
    views.find(
      (v) =>
        v.active &&
        v.hasFrontend &&
        v.ui === 'player' &&
        Boolean(v.registered?.PlayerComponent),
    ) ?? null
  )
}
