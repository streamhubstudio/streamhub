import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigService } from '../../shared/config/config.service';

/**
 * Secret store for S3 (and any other) credentials. Values are persisted in
 * `${DATA_DIR}/data/secrets.json` (chmod 600), NEVER in the versionable
 * config.yaml in clear text (SPEC §7 / §13).
 *
 * config.yaml only carries refs (`access_key_env` / `secret_key_env`). This
 * store resolves a ref to its real value, preferring the on-disk secret store
 * and falling back to `process.env` (so the core `.env` keeps working too).
 *
 * Secret VALUES are never logged. The store is intentionally tiny and
 * synchronous in spirit (small JSON), but uses async fs to avoid blocking.
 */
@Injectable()
export class SecretsStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Absolute path to the secrets file. */
  private filePath(): string {
    return path.join(this.config.dataDir, 'data', 'secrets.json');
  }

  /** Load + cache the secrets map. Missing/corrupt file → empty map. */
  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.cache =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      // ENOENT or invalid JSON → start empty, never crash.
      this.cache = {};
    }
    return this.cache;
  }

  /** Force a re-read on next access (e.g. after the UI updates secrets). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Resolve a secret ref to its value: on-disk store first, then process.env.
   * Returns undefined if neither has it.
   */
  async get(ref: string): Promise<string | undefined> {
    if (!ref) return undefined;
    const map = await this.load();
    if (map[ref] !== undefined && map[ref] !== '') return map[ref];
    const fromEnv = process.env[ref];
    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  }

  /** Persist a single secret (chmod 600). Overwrites if present. */
  async set(ref: string, value: string): Promise<void> {
    await this.setMany({ [ref]: value });
  }

  /** Persist several secrets atomically (chmod 600 on file, 700 on dir). */
  async setMany(values: Record<string, string>): Promise<void> {
    const map = await this.load();
    for (const [k, v] of Object.entries(values)) {
      if (k) map[k] = v;
    }
    const file = this.filePath();
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
    // Enforce perms even if the file pre-existed with looser bits.
    await fs.chmod(file, 0o600).catch(() => undefined);
    this.cache = map;
  }

  /** Remove a secret if present. */
  async remove(ref: string): Promise<void> {
    const map = await this.load();
    if (map[ref] === undefined) return;
    delete map[ref];
    const file = this.filePath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(map, null, 2), { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => undefined);
    this.cache = map;
  }

  /**
   * Convenience: resolve the access/secret pair referenced by an app's
   * config.yaml (`access_key_env` / `secret_key_env`). Empty strings when a
   * ref can't be resolved — callers decide whether that's fatal.
   */
  async resolveS3Credentials(
    accessKeyRef: string,
    secretKeyRef: string,
  ): Promise<{ accessKey: string; secretKey: string }> {
    const [accessKey, secretKey] = await Promise.all([
      this.get(accessKeyRef),
      this.get(secretKeyRef),
    ]);
    return { accessKey: accessKey ?? '', secretKey: secretKey ?? '' };
  }
}
