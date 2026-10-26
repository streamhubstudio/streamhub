import * as fs from 'fs';
import * as path from 'path';

/**
 * Product version resolution (single source of truth: the repo-root `VERSION`
 * file, e.g. `2.7.0`).
 *
 * Historically the API surfaced `process.env.npm_package_version` — the
 * streamhub-core package.json version (`0.1.0`), which is NOT the product
 * version and is absent entirely when the compiled core runs as
 * `node dist/main.js` (Docker entrypoint). This helper reads the real VERSION
 * file once at boot and falls back to package.json / `'dev'` when absent, so
 * `/health`, `/auth/config` (`appVersion`) and the system-settings snapshot all
 * report the same truthful value.
 *
 * Lookup order (first hit wins):
 *  1. `<cwd>/VERSION`        — Docker runtime (`WORKDIR /app`, VERSION copied
 *                              next to package.json by deploy/Dockerfile).
 *  2. `<cwd>/../VERSION`     — dev/test runs from `streamhub-core/` (the file
 *                              lives at the repo root).
 *  3. `__dirname/../../../VERSION` — `dist/modules/health` → dist parent, for
 *                              runners with an unusual cwd.
 *  4. `npm_package_version`  — package.json (when launched via npm).
 *  5. `'dev'`.
 */

/** Default places to look for the VERSION file (see module doc). */
export function versionFileCandidates(): string[] {
  return [
    path.resolve(process.cwd(), 'VERSION'),
    path.resolve(process.cwd(), '..', 'VERSION'),
    path.resolve(__dirname, '..', '..', '..', 'VERSION'),
  ];
}

/**
 * Read a VERSION file: first non-empty line, trimmed. Null when the file is
 * missing, unreadable, empty or implausibly long (defensive: this string is
 * echoed on public endpoints).
 */
export function versionFromFile(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const line = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (line.length === 0 || line.length > 32) return null;
    return line;
  } catch {
    return null;
  }
}

/**
 * Resolve the product version from the first readable candidate file, else
 * package.json (npm_package_version), else `'dev'`. Pure — callers wanting the
 * boot-time cached value use {@link getAppVersion}.
 */
export function resolveAppVersion(
  candidates: string[] = versionFileCandidates(),
): string {
  for (const file of candidates) {
    const v = versionFromFile(file);
    if (v) return v;
  }
  return process.env.npm_package_version ?? 'dev';
}

let cached: string | undefined;

/** Product version, resolved once per process (read at boot, then cached). */
export function getAppVersion(): string {
  cached ??= resolveAppVersion();
  return cached;
}
