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

const CATEGORIES = new Set(['tool', 'processor', 'panel']);
const UI_SLOTS = new Set(['app-tab', 'panel', 'player-overlay']);
const FIELD_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'select',
  'secret',
]);

@Injectable()
export class PluginRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PluginRegistryService.name);
  private readonly plugins = new Map<string, PluginMeta>();

  /** Directory that holds the plugin folders (dist/plugins at runtime). */
  private readonly pluginsRoot: string;

  /**
   * `@Optional()` so Nest DI does NOT try to resolve the `string` param as a
   * provider — under DI it's injected as undefined and we fall back to the
   * built-in path; unit tests pass an explicit fixture root via `new`.
   */
  constructor(@Optional() pluginsRoot?: string) {
    this.pluginsRoot =
      pluginsRoot ?? path.resolve(__dirname, '..', '..', 'plugins');
  }

  onModuleInit(): void {
    this.discover();
  }

  /** (Re)scan the plugins directory. Idempotent; clears then repopulates. */
  discover(): void {
    this.plugins.clear();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.pluginsRoot, { withFileTypes: true });
    } catch {
      this.logger.warn(
        `no plugins directory at ${this.pluginsRoot}; 0 plugins loaded`,
      );
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaFile = this.resolveMetaFile(entry.name);
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
    this.logger.log(
      `discovered ${this.plugins.size} plugin(s): ${[...this.plugins.keys()].join(', ') || '(none)'}`,
    );
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

  private resolveMetaFile(folder: string): string | null {
    for (const ext of ['.ts', '.js']) {
      const f = path.join(this.pluginsRoot, folder, `plugin.meta${ext}`);
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
    if (!Array.isArray(m.configSchema)) return 'configSchema must be an array';
    const seen = new Set<string>();
    for (const f of m.configSchema as PluginConfigField[]) {
      const fe = this.validateField(f, seen);
      if (fe) return fe;
    }
    if (m.needsWorker && (!m.worker || typeof m.worker.spawn !== 'function')) {
      return 'needsWorker=true but worker.spawn() is missing';
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
