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
 *  - `player`         → the plugin PROVIDES the media player itself. When an app
 *    has an active `player`-slot plugin the HLS + VOD/MP4 player renders its
 *    `PlayerComponent` instead of the built-in video.js player; otherwise it
 *    falls back to video.js. Resolved by `usePlayerProvider` + `<ProviderPlayer>`
 *    (NOT `<PluginSlot>`, which is for tab/panel/overlay surfaces). Sub-second
 *    WebRTC live keeps using LiveKit. See https://streamhub.studio/docs/features/players.
 */
export type PluginPlacement = 'app-tab' | 'panel' | 'player-overlay' | 'player'

/**
 * Extension taxonomy (mirrors the backend contract's `PluginKind`):
 *  - `plugin` (default) → a simple, in-process extension (overlay, panel,
 *    player) opened from a modal.
 *  - `app` → a full Studio application: own page, own storage/worker, an export
 *    story. Opened full-page (`apps/:app/studio/:id`).
 */
export type PluginKind = 'plugin' | 'app'

/** Persistent state an app owns (informational; drives export + docs). */
export interface PluginStorageDescriptor {
  /** SQLite filename the app owns under apps/<app>/ (e.g. 'lpr.db'). */
  db?: string
}

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
  /**
   * Active primary-surface section id, when the HOST drives sections from the
   * URL (StudioAppPage binds it to the `:section` route param so a view is
   * deep-linkable). Undefined ⇒ the plugin owns its section state internally
   * (e.g. mounted as a plain app-tab with no router section). See `useSection`.
   */
  section?: string
  /** Ask the host to switch the active section (navigates + updates the URL). */
  onSectionChange?: (sectionId: string) => void
}

/**
 * One primary-surface section a multi-section plugin declares, so the Studio
 * deep-link route + launcher can enumerate its views without hardcoding them.
 * `id` is the `:section` URL segment (and the plugin's internal switch key).
 */
export interface PluginSectionMeta {
  id: string
  /** i18n key (resolved in the plugin's own namespace) or a plain label. */
  labelKey: string
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
  /**
   * App slug the plugin is being configured in. Optional for back-compat (older
   * editors never needed it); passed by ConfigForm so an editor that manages
   * app-scoped state (e.g. the scheduled-live agenda) can call its own API.
   */
  app?: string
}

export type PluginComponent = ComponentType<PluginComponentProps>
export type PluginConfigComponent = ComponentType<PluginConfigProps>

// ---------------------------------------------------------------------------
// Player provider (ui: 'player') — a plugin that PROVIDES the media player
// ---------------------------------------------------------------------------

/**
 * The STABLE media contract a `player`-slot plugin's `PlayerComponent` receives.
 * These five fields are the whole interface the HLS/VOD resolver relies on, so a
 * provider (Vidstack today, others later) is a drop-in swap:
 *  - `src`      the media URL (an `.m3u8` playlist, or an MP4).
 *  - `type`     `'hls'` for a playlist, `'mp4'` for a progressive file.
 *  - `autoplay` start on mount (a provider MUST mute to satisfy browser policy).
 *  - `poster`   optional poster image URL.
 *  - `live`     true for live HLS (enables live-edge UI); false/omitted for VOD.
 */
export interface PlayerSource {
  src: string
  type: 'hls' | 'mp4'
  autoplay?: boolean
  poster?: string
  live?: boolean
}

/**
 * Props for a `player`-slot plugin's `PlayerComponent`. The five `PlayerSource`
 * fields are the stable contract; `config`/`pluginId`/`className` are optional
 * extras so the provider can read its persisted settings (e.g. theme) and take a
 * wrapper class — mirroring how TabComponent/PanelComponent get their ctx.
 */
export interface PlayerComponentProps extends PlayerSource {
  /** The plugin's merged config (schema defaults + persisted values). */
  config?: ConfigValues
  /** The plugin's own id (handy for scoping storage/log queries). */
  pluginId?: string
  /** Extra classes on the player wrapper. */
  className?: string
}

/** A plugin-provided media player (rendered when `ui === 'player'`). */
export type PlayerComponent = ComponentType<PlayerComponentProps>

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
  /**
   * Extension taxonomy. `'app'` = full Studio application (own page, storage,
   * export story); `'plugin'` (default) = a simple in-process extension. A
   * frontend module may declare this so standalone dev-mode is coherent when no
   * backend record exists; the backend manifest wins when both are present.
   */
  kind?: PluginKind
  /**
   * Edge-capable: this app's worker can be distributed per-stream onto edge
   * nodes (drives the "Edge" marketplace badge). The backend manifest wins when
   * both declare it; a frontend module sets it so the badge shows in the
   * registry-only Marketplace catalog too.
   */
  edge?: boolean
  /** Primary placement of the plugin's surface. */
  ui: PluginPlacement
  /**
   * Primary-surface sections this plugin's TabComponent renders (Studio deep
   * links + launcher). When present, the studio route `:section` addresses one
   * of these ids and the Studio launcher enumerates them; the plugin drives its
   * active section from `ctx.section` when the host controls it (`useSection`).
   */
  sections?: PluginSectionMeta[]
  /** Declarative config schema → generic form (skip if you ship ConfigComponent). */
  configSchema?: ConfigSchema

  /** Rendered when `ui === 'app-tab'`. */
  TabComponent?: PluginComponent
  /** Rendered when `ui === 'panel'`. */
  PanelComponent?: PluginComponent
  /** Rendered when `ui === 'player-overlay'`. */
  OverlayComponent?: PluginComponent
  /** Rendered when `ui === 'player'` — the swappable media player itself. */
  PlayerComponent?: PlayerComponent
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
  /** Extension taxonomy from the backend manifest (wins over the frontend). */
  kind?: PluginKind
  /** Edge-capable — the worker declares `worker.edge` (drives the badge). */
  edge?: boolean
  /** Storage the app owns (informational). */
  storage?: PluginStorageDescriptor | null
  /** True when the backend can produce a standalone export bundle. */
  exportable?: boolean
  /** True when the extension spawns a framework-managed worker process. */
  needsWorker?: boolean
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

  /**
   * Extension taxonomy — always resolved (defaults to `'plugin'`). Drives the
   * Apps/Plugins shelf split and the open-as-page vs open-as-modal decision.
   */
  kind: PluginKind
  /** Edge-capable — the worker can be distributed onto edge nodes (badge). */
  edge: boolean
  /** Storage the app owns (informational; backend-supplied). */
  storage?: PluginStorageDescriptor | null
  /** True when a standalone export bundle can be produced (backend-supplied). */
  exportable: boolean
  /** True when the extension spawns a framework-managed worker process. */
  needsWorker?: boolean

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
