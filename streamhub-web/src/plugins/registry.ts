/**
 * Plugin registry — PURE normalization + collision handling.
 *
 * The Vite-specific auto-discovery (import.meta.glob) lives in discovery.ts so
 * this module stays runnable under node:test. `buildRegistry` takes an already
 * materialized map of `<globPath> -> module` (each module's default export is a
 * `PluginModule`) and returns a validated `Map<id, RegisteredPlugin>`.
 */
import type { PluginModule, PluginPlacement, RegisteredPlugin } from './types.ts'

const PLACEMENTS: PluginPlacement[] = ['app-tab', 'panel', 'player-overlay']

/** Derive a fallback id from a discovery path like `./chat/index.ts` → `chat`. */
export function idFromSource(source: string): string {
  const m = source.match(/\/?([^/]+)\/index\.[tj]sx?$/)
  return m ? m[1] : source
}

/** Accepts either the raw module (`{ default }`) or a bare PluginModule. */
function extractModule(raw: unknown): PluginModule | null {
  if (!raw || typeof raw !== 'object') return null
  const maybe = raw as { default?: unknown }
  const mod = (maybe.default ?? raw) as Partial<PluginModule>
  if (!mod || typeof mod !== 'object') return null
  return mod as PluginModule
}

/**
 * Validate + normalize a single discovered module. Returns null (and the reason)
 * when the module is not a usable plugin, so `buildRegistry` can warn without
 * throwing during app boot.
 */
export function normalizeModule(
  raw: unknown,
  source: string,
): { plugin: RegisteredPlugin | null; reason?: string } {
  const mod = extractModule(raw)
  if (!mod) return { plugin: null, reason: 'no default export' }

  const id = typeof mod.id === 'string' && mod.id ? mod.id : idFromSource(source)
  if (!id) return { plugin: null, reason: 'missing id' }

  if (typeof mod.name !== 'string' || !mod.name) {
    return { plugin: null, reason: `plugin "${id}" missing name` }
  }
  if (!PLACEMENTS.includes(mod.ui)) {
    return { plugin: null, reason: `plugin "${id}" has invalid ui "${String(mod.ui)}"` }
  }

  // Warn (but don't reject) when the declared placement has no component: the
  // plugin can still be listed/installed, it just renders nothing.
  const plugin: RegisteredPlugin = {
    ...mod,
    id,
    category: mod.category?.trim() || 'general',
    description: mod.description ?? '',
    source,
  }
  return { plugin }
}

export interface BuildRegistryResult {
  registry: Map<string, RegisteredPlugin>
  warnings: string[]
}

/**
 * Build the id→plugin registry from a discovery map. First writer wins on id
 * collisions; later duplicates are reported as warnings (never silently
 * clobbered), which keeps two agents dropping the same id from masking a bug.
 */
export function buildRegistry(
  modules: Record<string, unknown>,
): BuildRegistryResult {
  const registry = new Map<string, RegisteredPlugin>()
  const warnings: string[] = []

  // Deterministic order regardless of glob enumeration order.
  const paths = Object.keys(modules).sort()

  for (const path of paths) {
    const { plugin, reason } = normalizeModule(modules[path], path)
    if (!plugin) {
      if (reason) warnings.push(`[plugins] skipped ${path}: ${reason}`)
      continue
    }
    if (registry.has(plugin.id)) {
      warnings.push(
        `[plugins] duplicate id "${plugin.id}" at ${path} — keeping ${
          registry.get(plugin.id)?.source
        }`,
      )
      continue
    }
    registry.set(plugin.id, plugin)
  }

  return { registry, warnings }
}
