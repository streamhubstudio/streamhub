/**
 * Per-app secret encryption for Streamflow (at rest, in `streamflow.db`).
 *
 * AES-256-GCM (authenticated) under a key DERIVED PER APP so a leaked db for one
 * app cannot decrypt another app's secrets, and a db leak WITHOUT the deployment
 * secret decrypts nothing:
 *
 *   key(app) = HKDF-SHA256(ikm = STREAMHUB_JWT_SECRET,
 *                          salt = 'streamflow-secret',
 *                          info = 'app:' + app, len = 32)
 *
 * Wire format (self-describing, `$`-joined base64url — same shape as
 * auth/secret-cipher.util so ops recognise it): `aesgcm$<iv>$<tag>$<ct>`.
 * `decrypt` NEVER throws — it returns null on any tamper / wrong key / malformed
 * value (matching the auth util contract). Secret VALUES are never logged.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const PREFIX = 'aesgcm';
const SALT = 'streamflow-secret';

/** Derive the 32-byte per-app AES key from the deployment secret via HKDF. */
function deriveKey(masterSecret: string, app: string): Buffer {
  // hkdfSync returns an ArrayBuffer; wrap it in a Buffer for createCipheriv.
  const bits = hkdfSync('sha256', masterSecret, SALT, `app:${app}`, KEY_BYTES);
  return Buffer.from(bits);
}

/** Encrypt a plaintext secret for `app` → `aesgcm$iv$tag$ct` (all base64url). */
export function encryptSecret(
  plaintext: string,
  masterSecret: string,
  app: string,
): string {
  if (!masterSecret) throw new Error('encryptSecret: empty master secret');
  if (!app) throw new Error('encryptSecret: empty app');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, deriveKey(masterSecret, app), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('$');
}

/**
 * Decrypt an `aesgcm$…` value for `app`. Returns null on any malformed/foreign
 * value, wrong app key, or authentication failure — never throws.
 */
export function decryptSecret(
  stored: string,
  masterSecret: string,
  app: string,
): string | null {
  if (!stored || !masterSecret || !app) return null;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv(ALG, deriveKey(masterSecret, app), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * A display mask that leaks only a prefix hint + the last 4 chars, e.g.
 * `sk-…a1b2`. Empty in → empty out. Short values (<=4) mask fully.
 */
export function maskSecret(value: string): string {
  const v = (value ?? '').trim();
  if (!v) return '';
  const last4 = v.slice(-4);
  if (v.length <= 4) return '…';
  // Keep a recognisable provider-ish prefix if present (sk-, sk_, ghp_, …).
  const m = v.match(/^(sk-|sk_|ghp_|xox[a-z]-|AKIA)/);
  const head = m ? m[1] : v.slice(0, 2);
  return `${head}…${last4}`;
}

/** True when a value is the write-only mask sentinel form (never persisted). */
export function looksMasked(value: string): boolean {
  return typeof value === 'string' && value.includes('…');
}

/**
 * Deep-scrub any occurrence of a resolved secret VALUE from a value about to be
 * persisted (run step output) or logged. Each needle substring is replaced with
 * `[redacted]`. Pure; returns a new structure. A belt-and-suspenders guard so a
 * secret that a box copied into its output never lands in run history/logs.
 */
export function redactSecretValues(value: unknown, needles: string[]): unknown {
  const found = needles.filter((n) => typeof n === 'string' && n.length >= 4);
  if (!found.length) return value;
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const n of found) if (out.includes(n)) out = out.split(n).join('[redacted]');
      return out;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = scrub(val);
      return o;
    }
    return v;
  };
  return scrub(value);
}
