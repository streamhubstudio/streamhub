import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Reversible at-rest encryption for small auth secrets (the TOTP shared
 * secret). Unlike passwords/API tokens (hash-only, sha256/scrypt), a TOTP
 * secret MUST be recoverable to validate codes — so it is encrypted with
 * AES-256-GCM using a key derived from STREAMHUB_JWT_SECRET (the one secret a
 * deployment already protects). A DB leak alone therefore does not expose
 * enrolled 2FA secrets.
 *
 * Format (self-describing, `$`-joined like password.util's scrypt string):
 *   `aesgcm$<ivB64url>$<tagB64url>$<ciphertextB64url>`
 */

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const PREFIX = 'aesgcm';

/** Derive the 32-byte AES key from the deployment secret (domain-separated). */
function deriveKey(masterSecret: string): Buffer {
  return createHash('sha256')
    .update(`streamhub-totp:${masterSecret}`, 'utf8')
    .digest();
}

/** Encrypt a plaintext secret → `aesgcm$iv$tag$ct` (all base64url). */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  if (!masterSecret) throw new Error('encryptSecret: empty master secret');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, deriveKey(masterSecret), iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('$');
}

/**
 * Decrypt an `aesgcm$…` string. Returns null on any malformed/foreign value or
 * authentication failure (wrong key / tampered ciphertext) instead of throwing.
 */
export function decryptSecret(
  stored: string,
  masterSecret: string,
): string | null {
  if (!stored || !masterSecret) return null;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv(ALG, deriveKey(masterSecret), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}
