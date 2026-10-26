/**
 * APPSTORE domain types — the immutable per-app-version bundle store.
 *
 * A "version" is one immutable directory `DATA_DIR/appstore/<pluginId>/<version>/`
 * holding `bundle.tar.gz` + `manifest.json`. Built-ins are materialized at boot
 * as `builtin-<coreVersion>` from the shipped worker source; everything else is
 * an operator UPLOAD carrying a valid semver. Nothing is ever overwritten — a
 * dupe upload is a 409 — so a custom build can never clobber another version.
 */

/** How a stored version came to exist. */
export type BundleSource = 'builtin' | 'uploaded';

/** The on-disk `manifest.json` written next to every `bundle.tar.gz`. */
export interface BundleManifest {
  pluginId: string;
  /** Directory segment: `builtin-<coreVersion>` OR a valid semver (uploads). */
  version: string;
  /** Hex SHA-256 of `bundle.tar.gz` (computed server-side; verified on extract). */
  sha256: string;
  source: BundleSource;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** File count + total uncompressed bytes of the worker payload (informational). */
  files?: { count: number; bytes: number };
  /** Free-text operator note (uploads only). */
  notes?: string | null;
}

/** One row of the version list, enriched with catalog flags + the archive size. */
export interface VersionListItem extends BundleManifest {
  /** The shipped built-in version for the running core. */
  builtin: boolean;
  /** The version the framework treats as "latest" (highest semver, else builtin). */
  latest: boolean;
  /** Size of `bundle.tar.gz` on disk, in bytes. */
  bundleBytes: number;
}

/** The version catalog for one plugin. */
export interface VersionCatalog {
  pluginId: string;
  versions: VersionListItem[];
  /** The `builtin-<coreVersion>` id, or null when no built-in is materialized. */
  builtinVersion: string | null;
  /** The `latest` version id (see {@link VersionListItem.latest}), or null. */
  latestVersion: string | null;
}
