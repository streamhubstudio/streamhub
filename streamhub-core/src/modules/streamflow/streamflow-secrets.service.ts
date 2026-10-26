/**
 * StreamflowSecretsService — the per-app, write-only secrets manager.
 *
 * Secrets are stored ENCRYPTED (AES-256-GCM, per-app HKDF key from
 * STREAMHUB_JWT_SECRET) in the app's `streamflow.db` `secrets` table. The API is
 * deliberately write-only:
 *   - `list`   → masked metadata (name + `sk-…last4`), NEVER a value;
 *   - `put`    → encrypt + store;
 *   - `remove` → delete;
 *   - `resolve`/`expandConfig` → plaintext, IN-PROCESS at run time only (used by
 *     the runner to expand `{{secret.NAME}}` refs before an executor runs).
 *
 * There is intentionally NO route/method that returns a secret value to a caller.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ConfigService } from '../../shared/config/config.service';
import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import {
  decryptSecret,
  encryptSecret,
  looksMasked,
  maskSecret,
} from './secret-crypt.util';
import { SecretMetaRow, StreamflowStore } from './streamflow.store';

/** Valid secret name: upper snake, 1–64 chars (referenced as {{secret.NAME}}). */
const NAME_RE = /^[A-Z0-9_]{1,64}$/;
/** `{{ secret.NAME }}` template ref (full or inline). */
const SECRET_REF_RE = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g;

@Injectable()
export class StreamflowSecretsService {
  constructor(
    private readonly config: ConfigService,
    private readonly store: StreamflowStore,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  /** Masked metadata for every secret (no values). */
  async list(app: string): Promise<SecretMetaRow[]> {
    const appDir = await this.requireApp(app);
    return this.store.listSecretMeta(app, appDir);
  }

  /** Encrypt + store a secret. Returns its masked metadata. */
  async put(app: string, name: string, value: string): Promise<SecretMetaRow> {
    const appDir = await this.requireApp(app);
    const key = String(name ?? '').trim();
    if (!NAME_RE.test(key)) {
      throw new BadRequestException(
        'secret name must be UPPER_SNAKE_CASE (A–Z, 0–9, _), 1–64 chars',
      );
    }
    const raw = typeof value === 'string' ? value : '';
    if (!raw.trim()) throw new BadRequestException('secret value is required');
    if (looksMasked(raw)) {
      // Refuse to persist a masked display value round-tripped from a GET.
      throw new BadRequestException('refusing to store a masked value');
    }
    if (!this.config.jwtSecret) {
      throw new BadRequestException(
        'STREAMHUB_JWT_SECRET is not set — cannot encrypt secrets',
      );
    }
    const enc = encryptSecret(raw, this.config.jwtSecret, app);
    const last4 = raw.length <= 4 ? '' : raw.slice(-4);
    this.store.setSecret(app, appDir, key, enc, last4);
    return {
      name: key,
      last4,
      createdAt: '',
      updatedAt: '',
    };
  }

  /** Delete a secret (404 when absent). */
  async remove(app: string, name: string): Promise<{ deleted: boolean }> {
    const appDir = await this.requireApp(app);
    const ok = this.store.deleteSecret(app, appDir, String(name ?? '').trim());
    if (!ok) throw new NotFoundException(`secret '${name}' not found`);
    return { deleted: true };
  }

  /** The mask a display surface would show for a value (helper for tests/UI). */
  mask(value: string): string {
    return maskSecret(value);
  }

  /**
   * Resolve one secret to plaintext (IN-PROCESS, run time only). Returns '' when
   * absent / undecryptable. Never logs the value.
   */
  resolve(app: string, appDir: string, name: string): string {
    const enc = this.store.getSecretEnc(app, appDir, name);
    if (!enc || !this.config.jwtSecret) return '';
    return decryptSecret(enc, this.config.jwtSecret, app) ?? '';
  }

  /**
   * Expand every `{{secret.NAME}}` ref in a box config to its plaintext, IN
   * PROCESS, returning an EPHEMERAL config (a fresh copy — the original, with the
   * ref intact, is what the runner persists as the step input). Also returns the
   * list of resolved plaintext values used, so the runner can scrub them from the
   * step OUTPUT before persistence.
   */
  expandConfig(
    app: string,
    appDir: string,
    config: Record<string, unknown>,
  ): { config: Record<string, unknown>; used: string[] } {
    const used = new Set<string>();
    const cache = new Map<string, string>();
    const lookup = (name: string): string => {
      const cached = cache.get(name);
      if (cached !== undefined) return cached;
      const v = this.resolve(app, appDir, name);
      cache.set(name, v);
      if (v) used.add(v);
      return v;
    };
    const expand = (v: unknown): unknown => {
      if (typeof v === 'string') {
        if (!v.includes('{{')) return v;
        return v.replace(SECRET_REF_RE, (_m, name: string) => lookup(name));
      }
      if (Array.isArray(v)) return v.map(expand);
      if (v && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          o[k] = expand(val);
        }
        return o;
      }
      return v;
    };
    return {
      config: expand(config ?? {}) as Record<string, unknown>,
      used: [...used],
    };
  }

  private async requireApp(app: string): Promise<string> {
    const rec = await this.apps.get(app).catch(() => null);
    if (!rec) throw new NotFoundException(`app '${app}' not found`);
    return this.apps.appDir(app);
  }
}
