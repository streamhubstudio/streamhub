/**
 * PLUGIN AUTO-DISCOVERY (no central registry file).
 *
 * On boot the registry scans `src/plugins/<id>/plugin.meta.{ts,js}` (resolved
 * relative to this file, so it maps to `dist/plugins/...` at runtime and
 * `src/plugins/...` under ts-jest) and imports each one. A plugin registers
 * simply by EXISTING on disk — plugin agents drop a folder in and never edit a
 * shared file, so they cannot collide.
 *
 * Each discovered module must default-export (or `export const plugin =`) a
 * `PluginMeta`. Malformed/duplicate manifests are logged and skipped rather than
 * crashing boot — a broken plugin never takes down the core.
 */
import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  PluginConfigField,
  PluginManifest,
  PluginMeta,
  toManifest,
} from './plugin.contract';
import {
  AppManifest,
  synthesizeMeta,
  validateAppManifest,
} from './app-manifest';

const CATEGORIES = new Set(['tool', 'processor', 'panel']);
const UI_SLOTS = new Set(['app-tab', 'panel', 'player-overlay', 'player']);
const KINDS = new Set(['plugin', 'app']);
const FIELD_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'select',
  'secret',
]);
const WORKER_PLACEMENTS = new Set(['local', 'grid']);

/**
 * Pragmatic semver matcher: MAJOR.MINOR.PATCH with an OPTIONAL `-prerelease`
 * and/or `+build` suffix (e.g. 1.0.0, 0.1.0, 2.3.1-beta.1, 1.0.0+build.5).
 * A manifest whose `version` is present but doesn't match is skipped+logged,
 * like any other malformed field; an ABSENT version is allowed (→ '0.0.0').
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

@Injectable()
export class PluginRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly plugins = new Map<string, PluginMeta>();

  /** Directory that holds the plugin folders (dist/plugins at runtime). */
  private readonly pluginsRoot: string;

  /**
   * Directory that holds VENDORED (decoupled) app packages, each a folder with a
   * declarative `streamhub.app.json` — NO executable JS (the security line of
   * the app-decoupling work). Populated by `scripts/apps-pull.mjs`; gitignored;
   * absent in a clean checkout (the scan then no-ops). Scanned AFTER the
   * built-ins so an in-tree plugin always wins an id collision.
   */
  private readonly vendorRoot: string;

  /**
   * `@Optional()` so Nest DI does NOT try to resolve the `string` params as
   * providers — under DI they're injected as undefined and we fall back to the
   * built-in paths; unit tests pass explicit fixture roots via `new`.
   */
  constructor(
    @Optional() pluginsRoot?: string,
    @Optional() vendorRoot?: string,
  ) {
    this.pluginsRoot =
      pluginsRoot ?? path.resolve(__dirname, '..', '..', 'plugins');
    // vendorRoot is the SIBLING of pluginsRoot (`plugins/` → `plugins-vendor/`).
    // Deriving it from the given pluginsRoot — rather than the built-in path —
    // means a fixture root gets a fixture-adjacent (non-existent) vendor dir, so
    // a unit test that passes only a temp pluginsRoot never accidentally scans
    // the real src/plugins-vendor.
    this.vendorRoot =
      vendorRoot ?? path.resolve(this.pluginsRoot, '..', 'plugins-vendor');
  }

  onModuleInit(): void {
    this.discover();
  }

  /**
   * Whether the plugin framework is enabled. Disabled ONLY when
   * `STREAMHUB_PLUGINS_ENABLE` is explicitly falsy (`false`/`0`/`off`/`no`) —
   * a bare media server (`install.sh --no-plugins`). Unset/anything else = on,
   * so the default behaviour is unchanged. Read from the env directly to keep
   * the constructor unit-test friendly (specs `new` it with a fixture root).
   */
  private pluginsEnabled(): boolean {
    const raw = (process.env.STREAMHUB_PLUGINS_ENABLE ?? '').trim().toLowerCase();
    return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
  }

  /** (Re)scan the plugins directory. Idempotent; clears then repopulates. */
  discover(): void {
    this.plugins.clear();
    if (!this.pluginsEnabled()) {
      // Empty catalog: plugin routes 404 (registry.getMeta → undefined) and the
      // worker reconcile spawns nothing (no meta → skipped). Zero side effects.
      this.logger.log('plugins disabled (STREAMHUB_PLUGINS_ENABLE=false); 0 plugins loaded');
      return;
    }
    this.scanDir(this.pluginsRoot, true);
    // TEST-ONLY fixture apps. `STREAMHUB_PLUGIN_FIXTURE_ROOT` is NEVER set in
    // production (or the compiled image, which ships no test/ tree), so this is
    // a no-op there. It lets the test suite discover a stable synthetic
    // reference app (`refapp`/`reftool`) as an in-tree fixture, so decoupling a
    // real app to its own repo never breaks a spec that just needed "some
    // exportable/edge/non-edge worker app" to exercise a behaviour.
    const fixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT?.trim();
    if (fixtureRoot) this.scanDir(fixtureRoot, false);
    this.discoverVendor();
    this.logger.log(
      `discovered ${this.plugins.size} plugin(s): ${[...this.plugins.keys()].join(', ') || '(none)'}`,
    );
  }

  /** Scan one plugins root, loading each `<dir>/plugin.meta.*`. */
  private scanDir(root: string, warnIfMissing: boolean): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      if (warnIfMissing) {
        this.logger.warn(`no plugins directory at ${root}; 0 plugins loaded`);
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Underscore folders are never plugins — src/plugins/_templates/ holds
      // the next-gen capability manifest SKELETONS (vision/grid/babel/
      // semantic-search); promote one by moving it up a level.
      if (entry.name.startsWith('_')) continue;
      const metaFile = this.resolveMetaFile(entry.name, root);
      if (!metaFile) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(metaFile) as Record<string, unknown>;
        const meta = (mod.default ?? mod.plugin ?? mod.meta) as
          | PluginMeta
          | undefined;
        const err = this.validate(meta, entry.name);
        if (err) {
          this.logger.error(`skipping plugin '${entry.name}': ${err}`);
          continue;
        }
        const m = meta as PluginMeta;
        if (this.plugins.has(m.id)) {
          this.logger.error(
            `duplicate plugin id '${m.id}' (folder '${entry.name}') — skipped`,
          );
          continue;
        }
        this.plugins.set(m.id, m);
      } catch (e) {
        this.logger.error(
          `failed to load plugin '${entry.name}': ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * Scan the vendor root for DECLARATIVE app packages (`streamhub.app.json`).
   * Each is validated to the SAME bar as a built-in and projected to a
   * PluginMeta whose `worker.spawn` is the pure template interpreter — the core
   * runs NO JavaScript the package carried. An id already claimed by a built-in
   * wins (the vendored copy is skipped with a warning), so dropping a vendored
   * package next to an in-tree app never silently shadows it. A missing vendor
   * dir (the clean-checkout default) is a silent no-op.
   */
  private discoverVendor(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.vendorRoot, { withFileTypes: true });
    } catch {
      return; // no vendor dir → nothing to do (the common case)
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const dir = path.join(this.vendorRoot, entry.name);
      const manifestFile = path.join(dir, 'streamhub.app.json');
      if (!fs.existsSync(manifestFile)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      } catch (e) {
        this.logger.error(
          `skipping vendored app '${entry.name}': manifest is not valid JSON (${(e as Error).message})`,
        );
        continue;
      }
      const errs = validateAppManifest(raw, entry.name);
      if (errs.length) {
        this.logger.error(
          `skipping vendored app '${entry.name}': ${errs.join('; ')}`,
        );
        continue;
      }
      const manifest = raw as AppManifest;
      if (this.plugins.has(manifest.id)) {
        this.logger.warn(
          `vendored app '${manifest.id}' shadows an in-tree plugin — keeping the in-tree one, skipping the vendored package`,
        );
        continue;
      }
      try {
        this.plugins.set(manifest.id, synthesizeMeta(manifest, { packageDir: dir }));
      } catch (e) {
        this.logger.error(
          `failed to load vendored app '${entry.name}': ${(e as Error).message}`,
        );
      }
    }
  }

  /** All plugins as serializable manifests (marketplace catalog). */
  listManifests(): PluginManifest[] {
    return [...this.plugins.values()]
      .map(toManifest)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Full meta (incl. worker closure) for internal use. */
  getMeta(id: string): PluginMeta | undefined {
    return this.plugins.get(id);
  }

  /** Serializable manifest for one plugin, or undefined. */
  getManifest(id: string): PluginManifest | undefined {
    const m = this.plugins.get(id);
    return m ? toManifest(m) : undefined;
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  // ---------------------------------------------------------------------------

  private resolveMetaFile(folder: string, root: string = this.pluginsRoot): string | null {
    for (const ext of ['.ts', '.js']) {
      const f = path.join(root, folder, `plugin.meta${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  /** Structural validation of a discovered manifest. Returns error or null. */
  private validate(meta: unknown, folder: string): string | null {
    if (!meta || typeof meta !== 'object') {
      return 'no PluginMeta default export';
    }
    const m = meta as Partial<PluginMeta>;
    if (!m.id || typeof m.id !== 'string') return 'missing string id';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id)) {
      return `id '${m.id}' must be a lowercase slug`;
    }
    if (m.id !== folder) {
      return `id '${m.id}' must equal folder name '${folder}'`;
    }
    if (!m.name || typeof m.name !== 'string') return 'missing name';
    if (typeof m.description !== 'string') return 'missing description';
    if (!m.category || !CATEGORIES.has(m.category)) {
      return `invalid category '${m.category}'`;
    }
    if (!m.ui || !UI_SLOTS.has(m.ui)) return `invalid ui slot '${m.ui}'`;
    // version is OPTIONAL at load time (back-compat → '0.0.0' on the manifest),
    // but when present it MUST be a valid semver string.
    if (m.version !== undefined) {
      if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
        return `invalid version '${String(m.version)}' (expected semver, e.g. 1.2.3)`;
      }
    }
    // Taxonomy + Studio-App descriptors (all OPTIONAL → default 'plugin' with
    // no storage/export). Malformed values are rejected like any other field.
    const te = this.validateTaxonomy(m);
    if (te) return te;
    if (!Array.isArray(m.configSchema)) return 'configSchema must be an array';
    const seen = new Set<string>();
    for (const f of m.configSchema as PluginConfigField[]) {
      const fe = this.validateField(f, seen);
      if (fe) return fe;
    }
    if (m.needsWorker && (!m.worker || typeof m.worker.spawn !== 'function')) {
      return 'needsWorker=true but worker.spawn() is missing';
    }
    if (m.worker) {
      const pe = this.validatePlacement(m.worker);
      if (pe) return pe;
    }
    return null;
  }

  /**
   * Validate the OPTIONAL Studio-App taxonomy descriptors (`kind`, `storage`,
   * `export`). Absent → a plain `plugin` with no storage/export. A `kind` other
   * than the two known values, an `export` on a non-app, or a `storage.db`/
   * `export.workerDir` that is not a BARE filename (path separators or '..')
   * are rejected like any other malformed field.
   */
  private validateTaxonomy(m: Partial<PluginMeta>): string | null {
    if (m.kind !== undefined && !KINDS.has(m.kind)) {
      return `invalid kind '${String(m.kind)}' (plugin|app)`;
    }
    if (m.storage !== undefined) {
      if (!m.storage || typeof m.storage !== 'object') {
        return 'storage must be an object';
      }
      const db = (m.storage as { db?: unknown }).db;
      if (db !== undefined) {
        if (typeof db !== 'string') return 'storage.db must be a string';
        if (!this.isBareFilename(db)) {
          return `storage.db '${db}' must be a bare filename (no path separators)`;
        }
      }
    }
    if (m.export !== undefined) {
      if ((m.kind ?? 'plugin') !== 'app') {
        return "export is only valid on kind 'app'";
      }
      if (!m.export || typeof m.export !== 'object') {
        return 'export must be an object';
      }
      const dir = (m.export as { workerDir?: unknown }).workerDir;
      if (dir !== undefined) {
        if (typeof dir !== 'string') return 'export.workerDir must be a string';
        if (!this.isBareFilename(dir)) {
          return `export.workerDir '${dir}' must be a bare directory name (no path separators)`;
        }
      }
    }
    return null;
  }

  /** A safe, single-segment name: non-empty, no '/', '\\' or '..' traversal. */
  private isBareFilename(name: string): boolean {
    if (!name || name === '.' || name === '..') return false;
    if (name.includes('/') || name.includes('\\')) return false;
    if (name.includes('..')) return false;
    return true;
  }

  /**
   * Validate the OPTIONAL grid-placement fields of a worker descriptor
   * (NEXTGEN-ADDONS). Absent fields are fine — placement defaults to 'local'.
   */
  private validatePlacement(worker: PluginMeta['worker']): string | null {
    const w = worker as unknown as Record<string, unknown>;
    const placement = w.placement;
    if (placement !== undefined && !WORKER_PLACEMENTS.has(String(placement))) {
      return `invalid worker.placement '${String(placement)}' (local|grid)`;
    }
    if (w.edge !== undefined && typeof w.edge !== 'boolean') {
      return 'worker.edge must be a boolean';
    }
    const grid = w.grid;
    if (grid === undefined) return null;
    if (placement !== 'grid') {
      return "worker.grid requirements need worker.placement 'grid'";
    }
    if (!grid || typeof grid !== 'object' || Array.isArray(grid)) {
      return 'worker.grid must be an object';
    }
    const g = grid as Record<string, unknown>;
    if (g.gpu !== undefined && typeof g.gpu !== 'boolean') {
      return 'worker.grid.gpu must be a boolean';
    }
    if (
      g.minVramGb !== undefined &&
      (typeof g.minVramGb !== 'number' || g.minVramGb < 0)
    ) {
      return 'worker.grid.minVramGb must be a non-negative number';
    }
    for (const key of ['capabilities', 'regions'] as const) {
      const v = g[key];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
        return `worker.grid.${key} must be an array of strings`;
      }
    }
    return null;
  }

  private validateField(raw: unknown, seen: Set<string>): string | null {
    if (!raw || typeof raw !== 'object') {
      return 'config field must be an object';
    }
    const f = raw as Record<string, unknown>;
    if (!f.key || typeof f.key !== 'string') return 'config field missing key';
    if (seen.has(f.key)) return `duplicate config key '${f.key}'`;
    seen.add(f.key);
    if (typeof f.type !== 'string' || !FIELD_TYPES.has(f.type)) {
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
}
