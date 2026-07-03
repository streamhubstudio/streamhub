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
    version: reg?.version ?? rec?.version,
    ui: reg?.ui,
    configSchema: reg?.configSchema,
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
