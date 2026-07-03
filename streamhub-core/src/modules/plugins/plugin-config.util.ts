/**
 * Config validation + normalization against a plugin's `configSchema`.
 *
 * Pure functions (no NestJS, no DB) so they are trivially unit-tested and
 * reused by both the install (PATCH) path and the worker spawn path.
 *
 * Rules:
 *   - Unknown keys are rejected (typo protection).
 *   - Missing keys are filled from the field default.
 *   - Each value is coerced/validated to the field type; bad values throw.
 *   - `required` fields must be non-empty (after defaults) — enforced only when
 *     `requireRequired` is set (i.e. when enabling), so a draft install can be
 *     saved incomplete.
 */
import { PluginConfigField, PluginMeta } from './plugin.contract';

export class PluginConfigError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

function coerceField(field: PluginConfigField, raw: unknown): unknown {
  switch (field.type) {
    case 'string':
    case 'secret': {
      if (typeof raw !== 'string') {
        throw new PluginConfigError(
          `field '${field.key}' must be a string`,
          field.key,
        );
      }
      return raw;
    }
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) {
        throw new PluginConfigError(
          `field '${field.key}' must be a number`,
          field.key,
        );
      }
      if (field.min !== undefined && n < field.min) {
        throw new PluginConfigError(
          `field '${field.key}' must be >= ${field.min}`,
          field.key,
        );
      }
      if (field.max !== undefined && n > field.max) {
        throw new PluginConfigError(
          `field '${field.key}' must be <= ${field.max}`,
          field.key,
        );
      }
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new PluginConfigError(
        `field '${field.key}' must be a boolean`,
        field.key,
      );
    }
    case 'select': {
      if (typeof raw !== 'string') {
        throw new PluginConfigError(
          `field '${field.key}' must be a string`,
          field.key,
        );
      }
      const allowed = (field.options ?? []).map((o) => o.value);
      if (!allowed.includes(raw)) {
        throw new PluginConfigError(
          `field '${field.key}' must be one of: ${allowed.join(', ')}`,
          field.key,
        );
      }
      return raw;
    }
    default: {
      // Exhaustiveness guard — a new field type must be handled above.
      const never: never = field.type;
      throw new PluginConfigError(`unknown field type '${String(never)}'`);
    }
  }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Validate + normalize an incoming (partial) config object against a schema.
 * Returns a NEW object with exactly the schema's keys, defaults filled and
 * every value type-checked. Throws PluginConfigError on any problem.
 *
 * @param requireRequired enforce `required` fields are non-empty (on enable).
 */
export function validateConfig(
  meta: PluginMeta,
  input: Record<string, unknown> | null | undefined,
  requireRequired = false,
): Record<string, unknown> {
  const incoming = input ?? {};
  const schemaKeys = new Set(meta.configSchema.map((f) => f.key));

  for (const key of Object.keys(incoming)) {
    if (!schemaKeys.has(key)) {
      throw new PluginConfigError(`unknown config key '${key}'`, key);
    }
  }

  const out: Record<string, unknown> = {};
  for (const field of meta.configSchema) {
    const provided = Object.prototype.hasOwnProperty.call(incoming, field.key);
    let value: unknown = provided ? incoming[field.key] : field.default;
    // Treat an explicit null on a non-nullable field as "use default".
    if (!provided || value === null) value = field.default;
    if (value !== null && value !== undefined) {
      value = coerceField(field, value);
    }
    if (requireRequired && field.required && isEmpty(value)) {
      throw new PluginConfigError(
        `field '${field.key}' is required`,
        field.key,
      );
    }
    out[field.key] = value;
  }
  return out;
}

/** Full defaults object for a plugin (an install with no user config). */
export function defaultConfig(meta: PluginMeta): Record<string, unknown> {
  return validateConfig(meta, {}, false);
}

/**
 * Redact `secret` field values for API responses / logs. Non-empty secrets are
 * masked to a fixed sentinel; empty stays empty so the UI can show "not set".
 */
export function redactSecrets(
  meta: PluginMeta,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secretKeys = new Set(
    meta.configSchema.filter((f) => f.type === 'secret').map((f) => f.key),
  );
  const out: Record<string, unknown> = { ...config };
  for (const key of secretKeys) {
    if (!isEmpty(out[key])) out[key] = '********';
  }
  return out;
}

/**
 * Keys that must NEVER be exposed to an anonymous (public) client, regardless of
 * their field type — server-to-server callback/webhook targets and anything that
 * smells like a credential/token. The public overlay endpoint only needs the
 * fields that drive CLIENT-SIDE rendering (format, colour, position, …), so this
 * errs on the side of dropping.
 */
const SENSITIVE_KEY_RE =
  /secret|token|password|passwd|credential|api[_-]?key|apikey|access[_-]?key|private|callback|webhook/i;

/**
 * Project a validated config down to ONLY the fields safe to serve publicly
 * (no auth). Drops every `secret`-typed field AND any field whose key looks like
 * a credential or a callback/webhook URL (e.g. yolo's `callbackUrl`). Iterates
 * the SCHEMA (not the stored object) so unknown/extra stored keys never leak.
 *
 * Used by the public player-overlay endpoint so overlays (e.g. the Timestamp
 * CCTV stamp) render for anonymous viewers without exposing any secret.
 */
export function sanitizePublicConfig(
  meta: PluginMeta,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of meta.configSchema) {
    if (field.type === 'secret') continue;
    if (SENSITIVE_KEY_RE.test(field.key)) continue;
    if (Object.prototype.hasOwnProperty.call(config, field.key)) {
      out[field.key] = config[field.key];
    }
  }
  return out;
}
