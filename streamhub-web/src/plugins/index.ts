/**
 * Public surface of the StreamHub frontend plugin framework.
 *
 * ── For plugin authors ──────────────────────────────────────────────────────
 *   Create `src/plugins/<id>/index.ts(x)` and default-export a plugin:
 *
 *     import { definePlugin } from '@/plugins'
 *     export default definePlugin({
 *       id: 'chat',
 *       name: 'Live chat',
 *       category: 'engagement',
 *       ui: 'app-tab',                 // 'app-tab' | 'panel' | 'player-overlay'
 *       icon: 'M4 4h16v12H5.17L4 17.17V4z',
 *       configSchema: { fields: [{ key: 'title', type: 'string', label: 'Title' }] },
 *       TabComponent: ({ ctx }) => <div>chat for {ctx.app}</div>,
 *       // OverlayComponent / PanelComponent / ConfigComponent optional
 *     })
 *
 *   That's it — auto-discovery registers it, the Marketplace lists it, and the
 *   host mounts it wherever a matching <PluginSlot> lives. No central edits.
 *
 * ── For host surfaces ───────────────────────────────────────────────────────
 *   Mount active plugins anywhere:
 *     import { PluginSlot } from '@/plugins'
 *     <PluginSlot placement="app-tab" ctx={{ app }} />
 *     <PluginSlot placement="player-overlay" ctx={{ app, room }} />
 */

// Author contract
export { definePlugin } from './types.ts'
export type {
  PluginModule,
  PluginPlacement,
  PluginContext,
  PluginComponentProps,
  PluginConfigProps,
  ConfigSchema,
  ConfigField,
  ConfigFieldType,
  ConfigFieldOption,
  ConfigValues,
  RegisteredPlugin,
  InstalledPlugin,
  PluginView,
  PluginLogEntry,
} from './types.ts'

// Host runtime
export { PluginSlot, usePluginSlots } from './host.tsx'
export type { PluginSlotProps } from './host.tsx'

// Read model + mutations
export {
  usePluginCatalog,
  usePluginsByPlacement,
  useInstallPlugin,
  useUninstallPlugin,
  useSetPluginActive,
  useUpdatePluginConfig,
  usePluginLogs,
  PLUGINS_KEY,
  pluginsKey,
} from './usePlugins.ts'

// Registry access (rarely needed directly)
export { getRegisteredPlugins, getRegisteredPlugin } from './discovery.ts'

// API client
export { pluginsApi } from './api.ts'
export type { PluginsApi, PluginLogQuery } from './api.ts'

// Config form (exported so a host can render settings inline if desired)
export { ConfigForm } from './ConfigForm.tsx'
