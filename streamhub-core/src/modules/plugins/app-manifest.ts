/**
 * STREAMHUB APP MANIFEST (`streamhub.app.json`) — the DECLARATIVE package
 * descriptor a decoupled Studio App ships instead of a `plugin.meta.ts`
 * (internal design notes §3). One JSON file carries everything the
 * core needs to register + run the app WITHOUT executing any code the package
 * brought with it: identity, the typed config schema, the declared events, and
 * a pure spawn TEMPLATE (see spawn-template.ts) for its worker.
 *
 * This module is the single source of truth for that manifest's SHAPE:
 *   - `AppManifest`          the TypeScript type;
 *   - `validateAppManifest`  a pure, dependency-free validator (no ajv) that
 *                            mirrors PluginRegistryService's built-in checks, so
 *                            a declarative package is held to the SAME bar as a
 *                            code-based meta. Used by the appstore upload path
 *                            and by `scripts/apps-pull.mjs` linking.
 *   - `synthesizeMeta`       projects a validated manifest to the PluginMeta the
 *                            registry already understands, wiring `worker.spawn`
 *                            to the template interpreter (zero eval).
 *
 * The JSON-Schema companion lives at
 * streamhub-docs/development/streamhub.app.schema.json (external tooling / CI).
 */
import * as path from 'path';
import {
  PluginCategory,
  PluginConfigField,
  PluginFieldType,
  PluginKind,
  PluginMeta,
  PluginUiSlot,
  PluginWorkerContext,
} from './plugin.contract';
import {
  AppManifestWorker,
  interpretWorkerTemplate,
} from './spawn-template';

/** MAJOR.MINOR.PATCH(-prerelease)(+build) — the same semver the registry uses. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const CATEGORIES = new Set<PluginCategory>(['tool', 'processor', 'panel']);
const UI_SLOTS = new Set<PluginUiSlot>([
  'app-tab',
  'panel',
  'player-overlay',
  'player',
]);
const KINDS = new Set<PluginKind>(['plugin', 'app']);
const FIELD_TYPES = new Set<PluginFieldType>([
  'string',
  'number',
  'boolean',
  'select',
  'secret',
]);
const WORKER_PLACEMENTS = new Set(['local', 'grid']);

/** The full `streamhub.app.json` object. */
export interface AppManifest {
  /** Manifest schema version (currently always 1). */
  manifestVersion?: number;
  /** Stable slug — MUST equal the vendor folder name. */
  id: string;
  name: string;
  description: string;
  category: PluginCategory;
  ui: PluginUiSlot;
  version: string;
  /** 'app' (Studio App) or 'plugin' (default). */
  kind?: PluginKind;
  icon?: string;
  /** Core version compatibility range, e.g. `{ core: '>=2.19 <3' }`. */
  compat?: { core?: string };
  /** Persistent SQLite the app owns (bare filename). */
  storage?: { db?: string };
  /**
   * Export-to-standalone descriptor (only valid on kind 'app'). Its presence
   * (a bare `workerDir` name) marks the app `exportable` — mirrors the built-in
   * meta's `export` so a vendored app is indistinguishable from a compiled one
   * in the catalog.
   */
  export?: { workerDir?: string };
  /** Declared domain events the worker may emit. */
  events?: string[];
  /** Typed config fields (every field needs a default). */
  configSchema: PluginConfigField[];
  /** Declarative worker (pure spawn template) — omitted for worker-less apps. */
  worker?: AppManifestWorker;
  /** Frontend composition hint (F0: verbatim TS source). */
  frontend?: { dir?: string; dist?: string; mode?: 'composed' | 'iframe' };
  /** SQLite migrations the WORKER applies on boot (streamhub_sdk.migrations). */
  migrations?: { dir?: string; db?: string };
  /** Standalone-deploy capability. */
  standalone?: { supported?: boolean; docs?: string };
  /**
   * F0 build glue (monorepo → package). Present ONLY in an in-tree authored
   * manifest; `apps-pack.mjs` reads it to locate scattered sources and STRIPS
   * it from the published package manifest. The core ignores it entirely.
   */
  build?: {
    workerSrc?: string;
    /** Shared Python SDK dir vendored INTO the worker package (self-contained). */
    workerSdk?: string;
    frontendSrc?: string;
    migrationsSrc?: string;
  };
}

/** A safe single-segment name: non-empty, no '/', '\\' or '..' traversal. */
function isBareFilename(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  return true;
}

function validateField(raw: unknown, seen: Set<string>): string | null {
  if (!raw || typeof raw !== 'object') return 'config field must be an object';
  const f = raw as Record<string, unknown>;
  if (!f.key || typeof f.key !== 'string') return 'config field missing key';
  if (seen.has(f.key)) return `duplicate config key '${f.key}'`;
  seen.add(f.key);
  if (typeof f.type !== 'string' || !FIELD_TYPES.has(f.type as PluginFieldType)) {
    return `field '${f.key}' has invalid type '${String(f.type)}'`;
  }
  if (f.default === undefined) return `field '${f.key}' missing default`;
  if (typeof f.label !== 'string') return `field '${f.key}' missing label`;
  if (f.type === 'select') {
    if (!Array.isArray(f.options) || f.options.length === 0) {
      return `select field '${f.key}' needs options`;
    }
  }
  return null;
}

function validateWorker(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'worker must be an object';
  const w = raw as AppManifestWorker;
  const hasEntry = typeof w.entry === 'string' && w.entry.trim().length > 0;
  const hasCommand = typeof w.command === 'string' && w.command.length > 0;
  if (w.needsWorker && !hasEntry && !hasCommand) {
    return "worker needs an 'entry' string or a 'command'";
  }
  if (w.env !== undefined) {
    if (typeof w.env !== 'object' || w.env === null || Array.isArray(w.env)) {
      return 'worker.env must be an object of string templates';
    }
    for (const [k, v] of Object.entries(w.env)) {
      if (typeof v !== 'string') return `worker.env.${k} must be a string template`;
    }
  }
  if (w.args !== undefined) {
    if (!Array.isArray(w.args) || w.args.some((a) => typeof a !== 'string')) {
      return 'worker.args must be an array of string templates';
    }
  }
  if (
    w.placement !== undefined &&
    !WORKER_PLACEMENTS.has(String(w.placement))
  ) {
    return `invalid worker.placement '${String(w.placement)}' (local|grid)`;
  }
  if (w.edge !== undefined && typeof w.edge !== 'boolean') {
    return 'worker.edge must be a boolean';
  }
  if (w.grid !== undefined) {
    if (w.placement !== 'grid') {
      return "worker.grid requirements need worker.placement 'grid'";
    }
    if (typeof w.grid !== 'object' || Array.isArray(w.grid)) {
      return 'worker.grid must be an object';
    }
  }
  return null;
}

/**
 * Validate a parsed manifest against the same bar as a built-in meta. Returns a
 * list of human-readable errors ([] ⇒ valid). `folder` (optional) enforces the
 * id === folder-name invariant when discovering under a vendor dir.
 */
export function validateAppManifest(
  raw: unknown,
  folder?: string,
): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return ['manifest is not an object'];
  const m = raw as Partial<AppManifest>;

  if (!m.id || typeof m.id !== 'string') errors.push('missing string id');
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id)) {
    errors.push(`id '${m.id}' must be a lowercase slug`);
  } else if (folder !== undefined && m.id !== folder) {
    errors.push(`id '${m.id}' must equal folder name '${folder}'`);
  }
  if (!m.name || typeof m.name !== 'string') errors.push('missing name');
  if (typeof m.description !== 'string') errors.push('missing description');
  if (!m.category || !CATEGORIES.has(m.category)) {
    errors.push(`invalid category '${String(m.category)}'`);
  }
  if (!m.ui || !UI_SLOTS.has(m.ui)) errors.push(`invalid ui slot '${String(m.ui)}'`);
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    errors.push(`invalid version '${String(m.version)}' (expected semver)`);
  }
  if (m.kind !== undefined && !KINDS.has(m.kind)) {
    errors.push(`invalid kind '${String(m.kind)}' (plugin|app)`);
  }
  if (m.storage?.db !== undefined) {
    if (typeof m.storage.db !== 'string' || !isBareFilename(m.storage.db)) {
      errors.push(`storage.db '${String(m.storage.db)}' must be a bare filename`);
    }
  }
  if (m.export !== undefined) {
    if ((m.kind ?? 'app') !== 'app') {
      errors.push("export is only valid on kind 'app'");
    }
    const dir = m.export?.workerDir;
    if (dir !== undefined && (typeof dir !== 'string' || !isBareFilename(dir))) {
      errors.push(`export.workerDir '${String(dir)}' must be a bare directory name`);
    }
  }
  if (m.events !== undefined) {
    if (!Array.isArray(m.events) || m.events.some((e) => typeof e !== 'string')) {
      errors.push('events must be an array of strings');
    }
  }
  if (!Array.isArray(m.configSchema)) {
    errors.push('configSchema must be an array');
  } else {
    const seen = new Set<string>();
    for (const f of m.configSchema) {
      const fe = validateField(f, seen);
      if (fe) errors.push(fe);
    }
  }
  const needsWorker = m.worker?.needsWorker === true;
  if (needsWorker) {
    const we = validateWorker(m.worker);
    if (we) errors.push(we);
  } else if (m.worker !== undefined) {
    const we = validateWorker(m.worker);
    if (we) errors.push(we);
  }
  return errors;
}

/** Options for {@link synthesizeMeta} — how to resolve the worker source dir. */
export interface SynthesizeMetaOptions {
  /**
   * Absolute path of the extracted package dir (holds `worker/`, `frontend/`,
   * …). Used to resolve a package-relative `worker.workerDir`.
   */
  packageDir: string;
  /** Explicit absolute worker dir override (wins over packageDir + workerDir). */
  workerDir?: string;
}

/**
 * Project a VALIDATED manifest to the PluginMeta the registry consumes. The
 * worker's `spawn` is wired to the template interpreter — the ONLY code the
 * core runs for a decoupled package is this core-owned closure, never anything
 * the package shipped.
 */
export function synthesizeMeta(
  manifest: AppManifest,
  options: SynthesizeMetaOptions,
): PluginMeta {
  const needsWorker = manifest.worker?.needsWorker === true;
  const workerDir = resolveWorkerDir(manifest, options);

  const meta: PluginMeta = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    ui: manifest.ui,
    version: manifest.version,
    kind: manifest.kind ?? 'app',
    configSchema: manifest.configSchema,
    events: manifest.events ?? [],
  };
  if (manifest.icon) meta.icon = manifest.icon;
  if (manifest.storage?.db) meta.storage = { db: manifest.storage.db };
  // Propagate the export descriptor so a vendored app stays `exportable` in the
  // catalog exactly like the compiled meta (toManifest reads meta.export).
  if (manifest.export?.workerDir) {
    meta.export = { workerDir: manifest.export.workerDir };
  }

  if (needsWorker && manifest.worker) {
    const worker = manifest.worker;
    meta.needsWorker = true;
    meta.worker = {
      placement: worker.placement,
      grid: worker.grid,
      edge: worker.edge,
      spawn: (ctx: PluginWorkerContext) =>
        interpretWorkerTemplate(worker, ctx, { workerDir }),
    };
  }
  return meta;
}

/** Resolve the absolute worker source dir for a synthesized meta. */
function resolveWorkerDir(
  manifest: AppManifest,
  options: SynthesizeMetaOptions,
): string {
  if (options.workerDir) return options.workerDir;
  const declared = manifest.worker?.workerDir;
  if (declared && path.isAbsolute(declared)) return declared;
  return path.join(options.packageDir, declared ?? 'worker');
}
