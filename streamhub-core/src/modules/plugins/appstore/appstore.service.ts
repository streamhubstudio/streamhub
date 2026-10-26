/**
 * APPSTORE — the immutable per-app-version bundle store on the master.
 *
 * Layout (per design internal design notes §1):
 *
 *   DATA_DIR/appstore/<pluginId>/<version>/
 *     bundle.tar.gz     the packed worker bundle (same USTAR+gzip as the exporter)
 *     manifest.json     { pluginId, version, sha256, source, createdAt, files, notes }
 *     extracted/        lazily populated on first spawn use (sha256-verified)
 *
 * IMMUTABLE: a published version is NEVER overwritten. Re-uploading the same
 * semver is a 409. Built-ins are materialized at boot as `builtin-<coreVersion>`
 * from the shipped worker source (idempotent + cheap — skipped when the current
 * core VERSION's builtin entry already exists), reusing the exporter's bundle
 * builder so there is no second packing path.
 *
 * This service is app-AGNOSTIC: it knows nothing about which tenant pins which
 * version (that lives in `app_plugins.worker_version`). The pin/rollback
 * orchestration + delete-refusal-when-pinned live in PluginVersionService.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '../../../shared/config/config.service';
import { LOGS_SERVICE, LogsServiceContract } from '../../../shared/contracts';
import { getAppVersion } from '../../health/app-version';
import { defaultConfig } from '../plugin-config.util';
import {
  composePluginBundle,
  packTarGz,
  resolveWorkerDir,
} from '../plugin-export.service';
import { PluginMeta } from '../plugin.contract';
import { PluginRegistryService } from '../plugin-registry.service';
import { extractTarGz, listTarGzPaths } from './tar.util';
import {
  BundleManifest,
  BundleSource,
  VersionCatalog,
  VersionListItem,
} from './appstore.types';

/** MAJOR.MINOR.PATCH(-prerelease)(+build) — the registry's semver, reused. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const BUNDLE_FILE = 'bundle.tar.gz';
const MANIFEST_FILE = 'manifest.json';
const EXTRACTED_DIR = 'extracted';

/** Hex SHA-256 of a buffer. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** True for a valid, non-reserved uploadable version (a real semver). */
export function isUploadableVersion(v: string): boolean {
  return SEMVER.test(v) && !v.startsWith('builtin');
}

/** Compare two semver-ish ids for "latest" ordering (release > prerelease). */
function semverCompare(a: string, b: string): number {
  const parse = (v: string): [number, number, number, number] => {
    const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?/.exec(v);
    if (!m) return [0, 0, 0, 1];
    // A prerelease (`-…`) ranks BELOW the same release → flag 0, else 1.
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return a.localeCompare(b);
}

@Injectable()
export class AppstoreService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppstoreService.name);

  constructor(
    private readonly registry: PluginRegistryService,
    private readonly config: ConfigService,
    @Inject(LOGS_SERVICE) private readonly logs: LogsServiceContract,
  ) {}

  // --- paths -----------------------------------------------------------------

  /** `DATA_DIR/appstore`. */
  storeRoot(): string {
    return path.join(this.config.dataDir, 'appstore');
  }

  private pluginDir(id: string): string {
    return path.join(this.storeRoot(), id);
  }

  /** Absolute dir for one version. `version` is validated path-safe by callers. */
  versionDir(id: string, version: string): string {
    return path.join(this.pluginDir(id), version);
  }

  private bundlePath(id: string, version: string): string {
    return path.join(this.versionDir(id, version), BUNDLE_FILE);
  }

  private manifestPath(id: string, version: string): string {
    return path.join(this.versionDir(id, version), MANIFEST_FILE);
  }

  /** The `builtin-<coreVersion>` id for the running core. */
  builtinVersionId(): string {
    return `builtin-${getAppVersion()}`;
  }

  // --- boot: materialize built-ins ------------------------------------------

  async onApplicationBootstrap(): Promise<void> {
    try {
      const made = this.materializeBuiltins();
      const bytes = this.storeSizeBytes();
      this.logs.write(
        'info',
        'appstore',
        `builtin bundles materialized: ${made}; store size ${(bytes / 1024).toFixed(0)} KiB`,
        {},
      );
    } catch (err) {
      // Best-effort — a bare node without the worker source must still boot.
      this.logs.write('warn', 'appstore', 'builtin materialization failed', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Materialize the shipped built-in bundle for every exportable worker plugin
   * as `builtin-<coreVersion>`, idempotently. Cheap on a warm store: it skips a
   * plugin whose current-version builtin entry already exists. Returns how many
   * were freshly built.
   */
  materializeBuiltins(): number {
    const version = this.builtinVersionId();
    let made = 0;
    for (const manifest of this.registry.listManifests()) {
      if (!manifest.needsWorker || !manifest.exportable) continue;
      const meta = this.registry.getMeta(manifest.id);
      if (!meta?.export?.workerDir) continue;
      if (fs.existsSync(this.manifestPath(meta.id, version))) continue; // idempotent
      const srcDir = resolveWorkerDir(meta.export.workerDir, meta.id);
      if (!srcDir) {
        this.logger.warn(
          `no worker source for '${meta.id}' — skipping builtin materialization`,
        );
        continue;
      }
      try {
        const entries = composePluginBundle(meta, meta.id, srcDir);
        const gz = packTarGz(entries);
        const bytes = entries.reduce((n, e) => n + e.body.length, 0);
        this.writeVersion(meta.id, version, gz, 'builtin', null, {
          count: entries.length,
          bytes,
        });
        made += 1;
      } catch (err) {
        this.logger.error(
          `failed to materialize builtin for '${meta.id}': ${(err as Error).message}`,
        );
      }
    }
    return made;
  }

  // --- write / read ----------------------------------------------------------

  /** Write an immutable version dir (bundle + manifest). Assumes non-existence. */
  private writeVersion(
    id: string,
    version: string,
    gz: Buffer,
    source: BundleSource,
    notes: string | null,
    files?: { count: number; bytes: number },
  ): BundleManifest {
    const dir = this.versionDir(id, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.bundlePath(id, version), gz);
    const manifest: BundleManifest = {
      pluginId: id,
      version,
      sha256: sha256(gz),
      source,
      createdAt: new Date().toISOString(),
      files,
      notes: notes ?? null,
    };
    fs.writeFileSync(
      this.manifestPath(id, version),
      JSON.stringify(manifest, null, 2),
    );
    return manifest;
  }

  /** Read one version's manifest, or null when it does not exist. */
  readManifest(id: string, version: string): BundleManifest | null {
    try {
      const raw = fs.readFileSync(this.manifestPath(id, version), 'utf8');
      return JSON.parse(raw) as BundleManifest;
    } catch {
      return null;
    }
  }

  /** True when a version dir exists for this plugin. */
  hasVersion(id: string, version: string): boolean {
    return fs.existsSync(this.manifestPath(id, version));
  }

  /**
   * The full version catalog for a plugin: every stored version enriched with
   * the `builtin`/`latest` flags. `latest` = the highest uploaded semver, or the
   * built-in when nothing has been uploaded. Empty when the plugin has no store
   * yet (returns the current builtin id so a caller can still show the default).
   */
  listVersions(id: string): VersionCatalog {
    const builtin = this.builtinVersionId();
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(this.pluginDir(id), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      dirs = [];
    }
    const manifests = dirs
      .map((v) => this.readManifest(id, v))
      .filter((m): m is BundleManifest => m !== null);

    // "latest": prefer the highest uploaded semver; fall back to the builtin.
    const uploaded = manifests
      .filter((m) => m.source === 'uploaded')
      .map((m) => m.version)
      .sort(semverCompare);
    const latest =
      uploaded.length > 0
        ? uploaded[uploaded.length - 1]
        : manifests.some((m) => m.version === builtin)
          ? builtin
          : null;

    const versions: VersionListItem[] = manifests
      .map((m) => ({
        ...m,
        builtin: m.version === builtin,
        latest: m.version === latest,
        bundleBytes: this.bundleBytes(id, m.version),
      }))
      // builtin first, then uploaded newest-first.
      .sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
        return -semverCompare(a.version, b.version);
      });

    return {
      pluginId: id,
      versions,
      builtinVersion: manifests.some((m) => m.version === builtin)
        ? builtin
        : null,
      latestVersion: latest,
    };
  }

  private bundleBytes(id: string, version: string): number {
    try {
      return fs.statSync(this.bundlePath(id, version)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Read a stored bundle for download. Returns the gzip bytes + its sha256 + a
   * suggested filename. 404 when the version does not exist.
   */
  readBundle(
    id: string,
    version: string,
  ): { body: Buffer; sha256: string; filename: string } {
    const manifest = this.readManifest(id, version);
    if (!manifest) {
      throw new NotFoundException(
        `no bundle for '${id}' version '${version}'`,
      );
    }
    const body = fs.readFileSync(this.bundlePath(id, version));
    return {
      body,
      sha256: manifest.sha256,
      filename: `streamhub-app-${id}-${version}.tar.gz`,
    };
  }

  // --- upload ----------------------------------------------------------------

  /**
   * Store an operator-uploaded bundle as a NEW immutable version. Validates the
   * plugin is a versionable (exportable) worker, the version is a real semver,
   * the archive carries the worker entrypoint, and that the version does not
   * already exist (409). The sha256 is computed server-side over the exact bytes
   * received. Returns the written manifest.
   */
  saveUploaded(
    id: string,
    version: string,
    gz: Buffer,
    notes?: string,
  ): BundleManifest {
    const meta = this.requireVersionableMeta(id);
    if (!isUploadableVersion(version)) {
      throw new BadRequestException(
        `invalid version '${version}' — expected a semver (e.g. 2.9.0); ` +
          "'builtin-*' is reserved",
      );
    }
    if (this.hasVersion(id, version)) {
      throw new ConflictException(
        `version '${version}' of '${id}' already exists (immutable — bump the semver)`,
      );
    }
    if (!gz || gz.length === 0) {
      throw new BadRequestException('empty bundle upload');
    }
    // gzip magic — fail fast on a non-gzip upload before touching disk.
    if (gz[0] !== 0x1f || gz[1] !== 0x8b) {
      throw new BadRequestException('bundle is not a gzip archive');
    }
    const paths = listTarGzPaths(gz);
    if (paths.length === 0) {
      throw new BadRequestException('bundle is not a valid tar.gz archive');
    }
    this.assertWorkerEntrypoint(meta, id, paths);
    const bytes = paths.length; // file count is enough for informational stats
    const manifest = this.writeVersion(id, version, gz, 'uploaded', notes ?? null, {
      count: bytes,
      bytes: gz.length,
    });
    this.logs.write(
      'info',
      `plugin:${id}`,
      `appstore: uploaded version '${version}' (${gz.length} bytes, sha256 ${manifest.sha256.slice(0, 12)}…)`,
      { version },
    );
    return manifest;
  }

  /**
   * Validate the uploaded archive carries the worker entrypoint under
   * `<id>/worker/` per the exporter's layout. The entrypoint module is derived
   * from the meta's OWN spawn args (`python -m <module>`); we accept its package
   * (`<module>/__init__.py` or `/__main__.py`) or a top-level `<module>.py`. When
   * the module can't be derived we fall back to "any .py under <id>/worker/".
   */
  private assertWorkerEntrypoint(
    meta: PluginMeta,
    id: string,
    paths: string[],
  ): void {
    const workerPrefix = `${id}/worker/`;
    const workerFiles = paths.filter((p) => p.startsWith(workerPrefix));
    if (workerFiles.length === 0) {
      throw new BadRequestException(
        `bundle is missing the '${workerPrefix}' worker directory ` +
          '(expected the streamhub-app export layout)',
      );
    }
    const mod = this.deriveModule(meta, id);
    const wanted = [
      `${workerPrefix}${mod}/__init__.py`,
      `${workerPrefix}${mod}/__main__.py`,
      `${workerPrefix}${mod}.py`,
    ];
    const hasEntry = mod
      ? paths.some((p) => wanted.includes(p))
      : workerFiles.some((p) => p.endsWith('.py'));
    if (!hasEntry) {
      throw new BadRequestException(
        `bundle is missing the worker entrypoint (expected '${wanted[0]}' or ` +
          `'${wanted[2]}')`,
      );
    }
  }

  /** The python module the worker runs, from the meta's `python -m <module>`. */
  private deriveModule(meta: PluginMeta, id: string): string {
    try {
      const spec = meta.worker!.spawn({
        app: 'validate',
        config: defaultConfig(meta),
        appDir: '/data/apps/validate',
        dataDir: this.config.dataDir,
        livekitUrl: this.config.livekitUrl,
      });
      const args = spec.args ?? [];
      const i = args.indexOf('-m');
      if (i >= 0 && args[i + 1]) return args[i + 1];
    } catch {
      /* fall through to the conventional name */
    }
    return `${id.replace(/-/g, '_')}_worker`;
  }

  // --- delete ----------------------------------------------------------------

  /**
   * Delete a stored version. Refuses the built-in (undeletable) and an unknown
   * version (404). The caller (PluginVersionService) is responsible for the
   * "refuse when any install pins it" check — the store itself is app-agnostic.
   */
  deleteVersion(id: string, version: string): void {
    if (version === this.builtinVersionId() || version.startsWith('builtin')) {
      throw new BadRequestException(
        `version '${version}' is a built-in and cannot be deleted`,
      );
    }
    if (!this.hasVersion(id, version)) {
      throw new NotFoundException(`no version '${version}' for '${id}'`);
    }
    fs.rmSync(this.versionDir(id, version), { recursive: true, force: true });
    this.logs.write(
      'info',
      `plugin:${id}`,
      `appstore: deleted version '${version}'`,
      { version },
    );
  }

  // --- extraction (spawn resolution) ----------------------------------------

  /**
   * Resolve the on-disk WORKER SOURCE dir for a pinned version, extracting the
   * bundle lazily on first use. The bundle's sha256 is VERIFIED against the
   * manifest before extraction — a tampered bundle refuses to extract (throws).
   * Returns `<version>/extracted/<id>/worker` — the drop-in equivalent of the
   * built-in worker source dir (the exporter copies srcDir → `<id>/worker/`).
   */
  resolveExtractedWorkerDir(id: string, version: string): string {
    const manifest = this.readManifest(id, version);
    if (!manifest) {
      throw new NotFoundException(`no version '${version}' for '${id}'`);
    }
    const extractedRoot = path.join(
      this.versionDir(id, version),
      EXTRACTED_DIR,
    );
    const workerDir = path.join(extractedRoot, id, 'worker');
    if (!fs.existsSync(workerDir)) {
      const gz = fs.readFileSync(this.bundlePath(id, version));
      const digest = sha256(gz);
      if (digest !== manifest.sha256) {
        throw new BadRequestException(
          `bundle sha256 mismatch for '${id}' '${version}' ` +
            `(manifest ${manifest.sha256.slice(0, 12)}…, actual ${digest.slice(0, 12)}…) — refusing to extract`,
        );
      }
      // Extract into a fresh dir (idempotent: guarded by the existence check).
      fs.mkdirSync(extractedRoot, { recursive: true });
      extractTarGz(gz, extractedRoot);
    }
    return workerDir;
  }

  /** The sha256 recorded for a version, or null when unknown. */
  versionSha256(id: string, version: string): string | null {
    return this.readManifest(id, version)?.sha256 ?? null;
  }

  // --- helpers ---------------------------------------------------------------

  private requireVersionableMeta(id: string): PluginMeta {
    const meta = this.registry.getMeta(id);
    if (!meta) throw new NotFoundException(`plugin '${id}' not found`);
    if (!meta.needsWorker || !meta.worker || !meta.export?.workerDir) {
      throw new BadRequestException(
        `plugin '${id}' is not versionable (no exportable worker)`,
      );
    }
    return meta;
  }

  /** Total bytes of every `bundle.tar.gz` under the store (boot-log stat). */
  private storeSizeBytes(): number {
    const root = this.storeRoot();
    let total = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === BUNDLE_FILE) {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(root);
    return total;
  }
}
