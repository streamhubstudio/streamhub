/**
 * StreamHub frontend plugin framework — contract types.
 *
 * These types are the single source of truth shared by:
 *  - plugin authors (each plugin's src/plugins/<id>/index.ts default-exports a
 *    `PluginModule`, ideally wrapped in `definePlugin` for inference);
 *  - the registry (auto-discovery + normalization);
 *  - the plugin-host (renders app-tabs / panels / player-overlays);
 *  - the Marketplace UI + the generic config form.
 *
 * This module is framework-agnostic at RUNTIME (only `import type` from React),
 * so the pure logic in schema.ts / registry.ts / state.ts can be unit-tested
 * with node:test without pulling a DOM.
 */
import type { ComponentType } from 'react'

// ---------------------------------------------------------------------------
// Config schema (drives the generic, typed config form)
// ---------------------------------------------------------------------------

export type ConfigFieldType =
  | 'string'
  | 'textarea'
  | 'url'
  | 'secret'
  | 'number'
  | 'boolean'
  | 'select'

export interface ConfigFieldOption {
  value: string
  label: string
}

/**
 * A single configurable field. One flat shape (rather than a discriminated
 * union) keeps the generic form and the pure validators simple; irrelevant
 * attributes are simply ignored for a given `type`.
 */
export interface ConfigField {
  /** Object key the value is stored under. */
  key: string
  type: ConfigFieldType
  /** Human label (already localized by the plugin, or a plain string). */
  label: string
  description?: string
  required?: boolean
  placeholder?: string
  /** Default applied when no stored value exists. */
  default?: string | number | boolean
  /** `select` only. */
  options?: ConfigFieldOption[]
  /** `number` only. */
  min?: number
  max?: number
  step?: number
}

export interface ConfigSchema {
  fields: ConfigField[]
}

/** Flat bag of config values keyed by `ConfigField.key`. */
export type ConfigValues = Record<string, string | number | boolean | undefined>

/** Validation codes are i18n-agnostic; the form maps them to localized text. */
export type ConfigErrorCode =
  | 'required'
  | 'nan'
  | 'min'
  | 'max'
  | 'notInOptions'

export interface ConfigValidation {
  valid: boolean
  /** field key -> error code */
  errors: Record<string, ConfigErrorCode>
}

// ---------------------------------------------------------------------------
// Placement + component props
// ---------------------------------------------------------------------------

/**
 * Where the host mounts a plugin's primary surface:
 *  - `app-tab`        → a tab/section inside an app (AppDetail), gets `{ app }`.
 *  - `panel`          → a standalone card/panel in a plugin surface.
 *  - `player-overlay` → an overlay layered on top of a live/VOD player.
 */
export type PluginPlacement = 'app-tab' | 'panel' | 'player-overlay'

/**
 * Runtime context handed to every plugin surface. All fields optional so a
 * plugin can be mounted from different hosts (an app tab knows `app`; a player
 * overlay knows `app`+`room`).
 */
export interface PluginContext {
  /** App slug, when mounted inside an app surface. */
  app?: string
  /** Room name, when mounted inside a player/meeting surface. */
  room?: string
  /** The plugin's persisted config (merged with schema defaults). */
  config: ConfigValues
}

/** Props every plugin-provided component receives. */
export interface PluginComponentProps {
  ctx: PluginContext
  /** The plugin's own id (handy for scoping storage/log queries). */
  pluginId: string
}

/** Props for a plugin's optional custom config editor (replaces the generic form). */
export interface PluginConfigProps {
  values: ConfigValues
  onChange: (values: ConfigValues) => void
  pluginId: string
}

export type PluginComponent = ComponentType<PluginComponentProps>
export type PluginConfigComponent = ComponentType<PluginConfigProps>

// ---------------------------------------------------------------------------
// The plugin module (what an author exports)
// ---------------------------------------------------------------------------

/**
 * The default export of `src/plugins/<id>/index.ts(x)`. Everything except
 * `id`, `name` and `ui` is optional. Use `definePlugin({...})` for inference.
 */
export interface PluginModule {
  /** Stable unique id. Also used as the query/route key. */
  id: string
  name: string
  description?: string
  /** Grouping/badge in the Marketplace (e.g. "engagement", "analytics"). */
  category?: string
  /** SVG path string (drawn with stroke=currentColor) or emoji/short glyph. */
  icon?: string
  version?: string
  /** Primary placement of the plugin's surface. */
  ui: PluginPlacement
  /** Declarative config schema → generic form (skip if you ship ConfigComponent). */
  configSchema?: ConfigSchema

  /** Rendered when `ui === 'app-tab'`. */
  TabComponent?: PluginComponent
  /** Rendered when `ui === 'panel'`. */
  PanelComponent?: PluginComponent
  /** Rendered when `ui === 'player-overlay'`. */
  OverlayComponent?: PluginComponent
  /** Optional custom config editor; when omitted the generic form is used. */
  ConfigComponent?: PluginConfigComponent
}

/** A validated + normalized plugin (registry output). */
export interface RegisteredPlugin extends PluginModule {
  category: string
  /** Original discovery key (glob path), for diagnostics. */
  source: string
}

// ---------------------------------------------------------------------------
// Backend install state + merged catalog view
// ---------------------------------------------------------------------------

/** A plugin record as returned by the backend (GET /plugins). */
export interface InstalledPlugin {
  id: string
  installed?: boolean
  active?: boolean
  /** Some backends spell it `enabled`; treated as an alias of `active`. */
  enabled?: boolean
  config?: ConfigValues
  version?: string
  installedAt?: string
  /** Optional metadata so a backend-only plugin still renders a card. */
  name?: string
  description?: string
  category?: string
}

/**
 * Marketplace/host row: the manifest merged with backend install state.
 * `registered` carries the component refs (absent for backend-only plugins).
 */
export interface PluginView {
  id: string
  name: string
  description: string
  category: string
  icon?: string
  version?: string
  ui?: PluginPlacement
  configSchema?: ConfigSchema

  /** Present in the frontend registry (its UI can be rendered). */
  hasFrontend: boolean
  /** Present in the backend list (known server-side). */
  hasBackend: boolean
  installed: boolean
  active: boolean
  config: ConfigValues

  registered?: RegisteredPlugin
}

/** A single plugin log line (GET /plugins/:id/logs). */
export interface PluginLogEntry {
  ts?: string
  level?: string
  message?: string
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Author helper
// ---------------------------------------------------------------------------

/** Identity helper: gives plugin authors full type-checking on their export. */
export function definePlugin(mod: PluginModule): PluginModule {
  return mod
}
