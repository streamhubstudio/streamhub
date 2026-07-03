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

/** Where the plugin's UI renders in the dashboard (frontend reads this). */
export type PluginUiSlot = 'app-tab' | 'panel' | 'player-overlay';

/** Supported config field primitive types. */
export type PluginFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'secret';

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
  /** Optional semver; defaults to '1.0.0'. */
  version?: string;
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
  version: string;
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
    version: meta.version ?? '1.0.0',
    icon: meta.icon,
  };
}
