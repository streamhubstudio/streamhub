import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Reversible at-rest encryption for small auth secrets (the TOTP shared
 * secret, the per-user SMTP password — owner item 29). Unlike passwords/API
 * tokens (hash-only, sha256/scrypt), these MUST be recoverable — so they are
 * encrypted with AES-256-GCM using a key derived from STREAMHUB_JWT_SECRET
 * (the one secret a deployment already protects), DOMAIN-SEPARATED per secret
 * kind so a leaked TOTP secret's key can never decrypt an SMTP password (and
 * vice-versa). A DB leak alone therefore does not expose either.
 *
 * Format (self-describing, `$`-joined like password.util's scrypt string):
 *   `aesgcm$<ivB64url>$<tagB64url>$<ciphertextB64url>`
 */

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const PREFIX = 'aesgcm';

/** Derive the 32-byte AES key for a given secret DOMAIN (domain-separated). */
function deriveKeyFor(domain: string, masterSecret: string): Buffer {
  return createHash('sha256')
    .update(`streamhub-${domain}:${masterSecret}`, 'utf8')
    .digest();
}

/** Derive the 32-byte AES key from the deployment secret (TOTP domain). */
function deriveKey(masterSecret: string): Buffer {
  return deriveKeyFor('totp', masterSecret);
}

function encryptWithDomain(
  domain: string,
  plaintext: string,
  masterSecret: string,
): string {
  if (!masterSecret) throw new Error('encryptSecret: empty master secret');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, deriveKeyFor(domain, masterSecret), iv);
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

function decryptWithDomain(
  domain: string,
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
    const decipher = createDecipheriv(ALG, deriveKeyFor(domain, masterSecret), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

/** Encrypt a plaintext secret → `aesgcm$iv$tag$ct` (all base64url). */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  return encryptWithDomain('totp', plaintext, masterSecret);
}

/**
 * Decrypt an `aesgcm$…` string. Returns null on any malformed/foreign value or
 * authentication failure (wrong key / tampered ciphertext) instead of throwing.
 */
export function decryptSecret(
  stored: string,
  masterSecret: string,
): string | null {
  return decryptWithDomain('totp', stored, masterSecret);
}

/**
 * Encrypt a per-user SMTP password (owner item 29) → `aesgcm$iv$tag$ct`.
 * Domain-separated from the TOTP secret so the two can never be confused/
 * cross-decrypted even though both derive from the same master secret.
 */
export function encryptUserSmtpSecret(
  plaintext: string,
  masterSecret: string,
): string {
  return encryptWithDomain('user-smtp', plaintext, masterSecret);
}

/** Decrypt a per-user SMTP password. Never throws — null on any failure. */
export function decryptUserSmtpSecret(
  stored: string,
  masterSecret: string,
): string | null {
  return decryptWithDomain('user-smtp', stored, masterSecret);
}
