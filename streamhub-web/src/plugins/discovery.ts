/**
 * Vite-only auto-discovery of plugin modules.
 *
 * A plugin plugs in with ZERO edits to any central file: it just lives at
 *   src/plugins/<id>/index.ts   (or .tsx)
 * and default-exports a `PluginModule` (ideally via `definePlugin`). The glob
 * below picks it up eagerly at build time.
 *
 * The glob is scoped to `./​*​/index.{ts,tsx}` — i.e. ONE level of sub-folder —
 * so the framework's own flat files (registry.ts, host.tsx, …) are never
 * mistaken for plugins.
 *
 * Kept separate from registry.ts because `import.meta.glob` is a Vite transform
 * that node:test can't evaluate; the pure registry logic stays unit-testable.
 */
import { buildRegistry } from './registry.ts'
import type { RegisteredPlugin } from './types.ts'

const modules = import.meta.glob('./*/index.{ts,tsx}', { eager: true })

const { registry, warnings } = buildRegistry(modules)

if (import.meta.env?.DEV && warnings.length) {
  for (const w of warnings) console.warn(w)
}

/** All discovered + validated plugins, in deterministic order. */
export function getRegisteredPlugins(): RegisteredPlugin[] {
  return [...registry.values()]
}

/** Look up a single discovered plugin by id. */
export function getRegisteredPlugin(id: string): RegisteredPlugin | undefined {
  return registry.get(id)
}
