/**
 * STREAMHUB PLUGIN CONTRACT — the ONE file a plugin author imports.
 *
 * A built-in plugin is nothing but a `PluginMeta` object exported from
 *   src/plugins/<id>/plugin.meta.ts
 * The framework AUTO-DISCOVERS it (filesystem glob → dynamic import, see
 * PluginRegistryService) — there is NO central registry file to edit, so plugin
 * agents never collide on a shared file. Declare, drop the file in, done.
 *
 * MINIMAL EXAMPLE (src/plugins/hello/plugin.meta.ts):
 *
 *   import { definePlugin } from '../../modules/plugins/plugin.contract';
 *   export default definePlugin({
 *     id: 'hello',
 *     name: 'Hello Panel',
 *     description: 'A tiny demo panel.',
 *     category: 'panel',
 *     ui: 'app-tab',
 *     configSchema: [
 *       { key: 'greeting', type: 'string', label: 'Greeting', default: 'hi' },
 *     ],
 *   });
 *
 * STABLE CONTRACT — field meanings do not change. New optional fields may be
 * added over time; keep additions optional so existing plugins keep validating.
 */

/** What the plugin fundamentally does (drives grouping in the marketplace UI). */
export type PluginCategory = 'tool' | 'processor' | 'panel';

/**
 * Where the plugin's UI renders in the dashboard (frontend reads this).
 *
 *  - `app-tab`        a tab/section inside an app.
 *  - `panel`          a standalone card/panel in a plugin surface.
 *  - `player-overlay` an overlay layered ON TOP of the media player.
 *  - `player`         the plugin PROVIDES the media player itself. When an app
 *    has an installed + enabled `player`-slot plugin, the HLS + VOD/MP4 player
 *    uses IT (e.g. the Vidstack provider) instead of the built-in video.js
 *    player. Sub-second WebRTC live keeps using LiveKit — this only swaps the
 *    HLS + VOD player. See https://streamhub.studio/docs/features/players.
 */
export type PluginUiSlot = 'app-tab' | 'panel' | 'player-overlay' | 'player';

/** Supported config field primitive types. */
export type PluginFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'secret';

/**
 * Where a plugin's worker process runs (NEXTGEN-ADDONS / StreamHub Grid).
 *
 *  - `local` (default) — spawned on the origin node, exactly as today.
 *  - `grid`  — the worker WANTS a remote BYO-GPU edge node from the cluster
 *    `nodes` registry. Until the remote scheduler ships (TODO GRID-1, see
 *    https://streamhub.studio/docs/features/NEXTGEN-ADDONS) a grid worker transparently
 *    FALLS BACK to a local spawn, so declaring `grid` is always safe.
 */
export type PluginWorkerPlacement = 'local' | 'grid';

/**
 * Requirements a `grid`-placed worker declares so the framework can pick an
 * eligible edge node from the cluster registry. All optional — an empty object
 * means "any grid node". A node advertises its capabilities via the `grid`
 * block of its heartbeat stats (see PluginGridService).
 */
export interface PluginGridRequirements {
  /** Node must have a GPU. */
  gpu?: boolean;
  /** Minimum GPU VRAM in GiB (implies a GPU node). */
  minVramGb?: number;
  /** Capability tags the node must advertise, e.g. ['cuda','whisper','clip']. */
  capabilities?: string[];
  /** Preferred node regions (soft preference, not a hard filter). */
  regions?: string[];
}

/**
 * Identity of the node a worker is (to be) placed on — a projection of one
 * cluster `nodes` registry row (no secrets, no stats).
 */
export interface PluginNodeInfo {
  id: string;
  name: string;
  url: string | null;
  region: string | null;
}

/** One typed, defaulted config field a plugin exposes. */
export interface PluginConfigField {
  /** Stable key used in config_json (e.g. `confidence`). */
  key: string;
  /** Field primitive type. */
  type: PluginFieldType;
  /** Human label (frontend renders; i18n happens client-side by key/label). */
  label: string;
  /**
   * Default value. REQUIRED — every field must have a sensible default so an
   * install with no config is immediately valid. `secret` defaults should be ''.
   */
  default: string | number | boolean | null;
  /** If true, an install cannot be enabled until this field is non-empty. */
  required?: boolean;
  /** Options for `type: 'select'` — value is what's stored, label is shown. */
  options?: { value: string; label: string }[];
  /** Numeric bounds (inclusive) for `type: 'number'`. */
  min?: number;
  max?: number;
  /** Placeholder / helper hint for the UI. */
  placeholder?: string;
  help?: string;
}

/**
 * Read-only context handed to a plugin's worker spec builder. Everything a
 * worker needs to locate its app's data + its resolved config, WITHOUT the
 * plugin importing any core service.
 */
export interface PluginWorkerContext {
  /** App (slug) the worker runs for. */
  app: string;
  /** Validated, normalized config for this install (defaults filled). */
  config: Record<string, unknown>;
  /** Absolute path to apps/<app>/ on disk. */
  appDir: string;
  /** Absolute root DATA_DIR. */
  dataDir: string;
  /** LiveKit ws/api hints so a worker can subscribe to the room if it needs to. */
  livekitUrl: string;
  /**
   * Node the worker is being placed on. `undefined` = the origin (local spawn,
   * today's only real path) — existing plugins never see this field. Populated
   * only when a grid worker is actually dispatched remotely (TODO GRID-1).
   */
  node?: PluginNodeInfo;
  /**
   * Absolute public base URL of the ORIGIN core, for a REMOTE (grid) worker to
   * reach the ingest/live-data endpoints — a remote node cannot use the
   * loopback STREAMHUB_INGEST_URL a local worker gets. `undefined` for local
   * workers. Populated on remote dispatch only (TODO GRID-1/GRID-3).
   */
  originUrl?: string;
  /**
   * The app's configured IANA timezone (owner item 11's `config.yaml
   * timezone:` key), e.g. `America/Argentina/Buenos_Aires`. `undefined`/empty
   * when the app has no timezone configured (server/host local time).
   *
   * This is the app-level DEFAULT for any plugin that has its own
   * timezone-flavoured config (e.g. an arm/disarm schedule) — an explicit
   * plugin-level timezone should always win; a plugin only falls back to
   * `appTimezone` when ITS OWN timezone field is empty. A plugin that has no
   * timezone concept of its own can simply ignore this field — additive,
   * nothing today's built-ins or existing worker plugins need to read.
   */
  appTimezone?: string;
}

/**
 * A fully-resolved spawn spec: exactly what core will `child_process.spawn`.
 * Keeping the plugin → { command, args, env } means the core NEVER knows what a
 * plugin's worker actually is (a python YOLO script, a node process, …).
 */
export interface PluginWorkerSpec {
  /** Executable (e.g. 'python3', or an absolute path to a binary). */
  command: string;
  /** Arguments. */
  args?: string[];
  /** Extra env merged over the parent process env. */
  env?: Record<string, string>;
  /** Working directory (defaults to the app dir). */
  cwd?: string;
}

/**
 * Worker descriptor for `needsWorker` plugins. `spawn` is a PURE function of the
 * context — no side effects — returning the process to run. The core owns the
 * lifecycle (start/stop/logs/status); the plugin only says WHAT to run.
 */
export interface PluginWorkerDescriptor {
  spawn(ctx: PluginWorkerContext): PluginWorkerSpec;
  /**
   * Where the worker should run. OPTIONAL, defaults to `'local'` — every
   * pre-existing plugin keeps its exact behavior without touching its meta.
   * `'grid'` requests a remote BYO-GPU edge node; until the remote scheduler
   * ships (TODO GRID-1) it logs the node selection and falls back to local.
   */
  placement?: PluginWorkerPlacement;
  /**
   * Node requirements, only meaningful (and only valid) with
   * `placement: 'grid'`.
   */
  grid?: PluginGridRequirements;
  /**
   * EDGE-CAPABLE — this worker can run DISTRIBUTED per-stream on registered
   * edge nodes (the cluster's `modules/edge` WS channel + `edge_assignments`),
   * not only co-located on the origin. OPTIONAL, defaults to falsy = local-only.
   *
   * Distinct from `placement`: `placement:'grid'` is the LOCAL worker-hook's
   * request to be dispatched to a BYO-GPU node for its ONE app-wide run; `edge`
   * declares the worker safe to fan OUT — one assignment per (app × stream) —
   * across edge nodes via the app-scoped edge assignments API + reconcile. The
   * REST manifest surfaces it so the web can badge "Edge-capable" apps and the
   * `POST /apps/:app/edge/assignments` endpoint accepts only `edge:true` plugins.
   * The spawn stays the same pure function — the generic edge spawn resolver
   * calls it with a REMOTE ctx (originUrl set) exactly like the grid path.
   */
  edge?: boolean;
}

/**
 * TAXONOMY — a `plugin` is a simple in-process extension (overlay, player,
 * panel); an `app` is a full application: it owns persistent state and/or a
 * worker and/or an app-sized primary UI, opens as a full page and has a
 * standalone export story. Default `'plugin'`. "App" here is the marketplace
 * kind (Studio App) — distinct from a TENANT app (`apps/<app>/`). See
 * https://streamhub.studio/docs/features/STUDIO-APPS.
 */
export type PluginKind = 'plugin' | 'app';

/**
 * Persistent state an extension owns. Informational metadata that drives the
 * export bundle + docs — it does NOT relocate anything. `db` is the SQLite
 * filename the extension writes (e.g. 'lpr.db'); it MUST be a bare filename
 * (no path separators / '..') — the registry rejects anything else.
 */
export interface PluginStorageDescriptor {
  /** SQLite filename the extension owns under its app's data dir (e.g. 'lpr.db'). */
  db?: string;
}

/**
 * Export-to-standalone descriptor. Its PRESENCE (a `workerDir`) marks an app
 * `exportable`: the exporter bundles that repo-root worker package into a
 * self-contained tarball (Dockerfile + compose + .env.example + README) that
 * runs on the operator's own infra and talks back over REST/webhooks. Only
 * valid on `kind: 'app'`; `workerDir` MUST be a bare directory name.
 */
export interface PluginExportDescriptor {
  /** Repo-root worker package dir the exporter bundles (e.g. 'lpr-worker'). */
  workerDir?: string;
}

/** The plugin manifest object. This IS the plugin (built-in). */
export interface PluginMeta {
  /** Stable unique id (slug). Also the folder name under src/plugins/. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description for the marketplace card. */
  description: string;
  /** Grouping category. */
  category: PluginCategory;
  /** Typed config fields with defaults. May be empty. */
  configSchema: PluginConfigField[];
  /** Where the plugin renders its UI. */
  ui: PluginUiSlot;
  /** True if the plugin runs an external worker process per app. */
  needsWorker?: boolean;
  /** Required when needsWorker=true: how to spawn the worker. */
  worker?: PluginWorkerDescriptor;
  /**
   * DOMAIN EVENT names this plugin's worker may emit through the framework
   * event channel (POST /apps/:app/plugins/:id/events, ingest-token auth —
   * the worker-hook injects STREAMHUB_EVENTS_URL/STREAMHUB_INGEST_TOKEN).
   * Each accepted event is dispatched through the app's SIGNED callbacks
   * funnel (webhook + MQTT tap) under exactly this name — e.g. the `lpr`
   * plugin declares ['plate.detected','plate.allowed','plate.denied'].
   * OPTIONAL; omitted/empty = the plugin emits no domain events and the
   * event channel rejects every push for it. Undeclared names are rejected,
   * so a worker can never spoof core events (vod_ready, …).
   */
  events?: string[];
  /**
   * REQUIRED semver (e.g. '1.0.0'). Surfaced on the manifest (`toManifest`) and
   * returned by the plugins API so the dashboard can badge a plugin's version.
   * Built-ins MUST declare it (the type enforces it via `definePlugin`); a
   * third-party manifest loaded off disk WITHOUT one is not rejected — it just
   * resolves to '0.0.0' on the manifest (see `toManifest`) so discovery never
   * breaks over a missing version. A malformed (non-semver) value IS rejected by
   * the registry, exactly like any other malformed field.
   */
  version: string;
  /**
   * 'app' = a full Studio App (own page, own storage, export story); 'plugin'
   * (DEFAULT when omitted) = a simple in-process extension. Additive: existing
   * metas and third-party manifests keep validating unchanged.
   */
  kind?: PluginKind;
  /**
   * Persistent state the extension owns (apps declare it; drives the export
   * bundle + docs). Informational — it does not move any data.
   */
  storage?: PluginStorageDescriptor;
  /**
   * Export-to-standalone descriptor. Present (with a `workerDir`) ⇒ the app is
   * `exportable`. Only valid on `kind: 'app'` (the registry rejects it on a
   * plugin).
   */
  export?: PluginExportDescriptor;
  /** Optional icon key/name the frontend maps to an SVG. */
  icon?: string;
}

/**
 * SERIALIZABLE marketplace view of a plugin (no functions). This is what the
 * REST API returns — the `worker.spawn` closure is stripped; only the boolean
 * `needsWorker` flag survives.
 */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  category: PluginCategory;
  configSchema: PluginConfigField[];
  ui: PluginUiSlot;
  needsWorker: boolean;
  /**
   * Requested worker placement (`'local'` for worker-less plugins and for
   * workers that don't declare one) — lets the marketplace badge "runs on
   * GRID" plugins. NOTE: this is the plugin's REQUEST; the effective placement
   * of a run is on WorkerState (always 'local' until GRID-1 ships).
   */
  workerPlacement: PluginWorkerPlacement;
  /**
   * True when this plugin's worker declares `worker.edge` — it can be
   * distributed per-stream onto edge nodes (drives the marketplace
   * "Edge-capable" badge and gates the app-scoped edge assignments API).
   * Always false for worker-less plugins.
   */
  edge: boolean;
  /** Domain event names the worker may emit (empty = none). */
  events: string[];
  version: string;
  /** Taxonomy: 'plugin' (default) or 'app' (a full Studio App). */
  kind: PluginKind;
  /** Declared persistent state, or null when the extension owns none. */
  storage: { db?: string } | null;
  /** True when the app ships an export-to-standalone descriptor. */
  exportable: boolean;
  icon?: string;
}

/**
 * Identity helper so a plugin.meta.ts gets full type-checking on its literal.
 * Returns the object unchanged; exists purely for inference + a stable import
 * the framework can key discovery hints off. Use as the default export.
 */
export function definePlugin(meta: PluginMeta): PluginMeta {
  return meta;
}

/** Project a full PluginMeta down to its serializable manifest form. */
export function toManifest(meta: PluginMeta): PluginManifest {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    category: meta.category,
    configSchema: meta.configSchema,
    ui: meta.ui,
    needsWorker: meta.needsWorker === true,
    workerPlacement: meta.worker?.placement ?? 'local',
    // Edge-capable ⇔ the worker opts in via `worker.edge` (worker-less → false).
    edge: meta.worker?.edge === true,
    events: meta.events ?? [],
    // Back-compat: a manifest loaded off disk without a version resolves to
    // '0.0.0' rather than breaking discovery (built-ins always declare one).
    version: meta.version ?? '0.0.0',
    // Taxonomy: default to a plain 'plugin' so every pre-existing meta (and any
    // third-party manifest) keeps its exact shape.
    kind: meta.kind ?? 'plugin',
    storage: meta.storage ? { db: meta.storage.db } : null,
    // Exportable ⇔ an export descriptor names a worker dir to bundle.
    exportable: !!meta.export?.workerDir,
    icon: meta.icon,
  };
}

/**
 * FEED-BACK CONVENTION — LiveKit data-message topic for a plugin's results.
 *
 * When a plugin's worker (local or grid) feeds results back into the MAIN FEED
 * as LiveKit data messages (the push path; the polled live-data channel
 * `POST/GET :id/live` is the fallback), it publishes on topic
 * `plugin:<pluginId>` so player overlays can subscribe by plugin id without
 * any registry. Example: Babel captions arrive on topic `plugin:babel`.
 * See https://streamhub.studio/docs/features/NEXTGEN-ADDONS ("Feed-back mechanism").
 */
export function pluginDataTopic(pluginId: string): string {
  return `plugin:${pluginId}`;
}
