import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Built-in user/password hashing (replaces OIDC/Logto — StreamHub is now the
 * identity-of-record). Salted scrypt (memory-hard KDF), the SAME primitive the
 * RTMP ingress password store already uses (see livekit/ingress-auth.service.ts).
 *
 * Chosen over argon2/bcrypt on purpose: those are native addons that need a
 * compile step at `npm install`; scrypt ships with Node's `crypto`, so the
 * `npm run build` (tsc) footprint stays unchanged and there is nothing new to
 * compile on the target box. scrypt with a per-user 16-byte salt and N=2^15 is
 * a sound password hash.
 */

/** scrypt cost — N=2^15 (~32MB, ~50-100ms). Encoded in the stored string. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * scrypt needs ~128*N*r bytes; at N=2^15,r=8 that is exactly Node's DEFAULT
 * `maxmem` (32MB), which trips "memory limit exceeded". Raise the ceiling
 * explicitly so the chosen cost always fits, with headroom for verify.
 */
const SCRYPT_MAXMEM = 128 * (1 << 16) * SCRYPT_R; // 64MB

/**
 * Hash a plaintext password. Returns a self-describing string
 * `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` so the params travel WITH the hash
 * and can be tuned later without a migration. Stored in `users.password_hash`.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/** Entropy (bytes) for a generated random password — 256 bits, base64url. */
const RANDOM_PASSWORD_BYTES = 32;

/**
 * Generate a cryptographically strong random password (256 bits, base64url ~43
 * chars). Used to seed a NON-guessable password for users who never chose one
 * (magic-link create-on-first-use): the value is thrown away after hashing, so
 * password login for that account is effectively disabled until they run the
 * reset flow. This is stronger than leaving `password_hash` NULL because it
 * closes the "no password set" branch uniformly with a real scrypt hash.
 */
export function generateRandomPassword(): string {
  return randomBytes(RANDOM_PASSWORD_BYTES).toString('base64url');
}

/**
 * Convenience: a scrypt hash of a fresh {@link generateRandomPassword}. The
 * plaintext is never returned — the account has a valid hash nobody knows, so
 * `verifyPassword` can never succeed for it until the password is reset.
 */
export function hashRandomPassword(): string {
  return hashPassword(generateRandomPassword());
}

/**
 * Constant-time verify of a plaintext against a stored `scrypt$…` string.
 * Returns false on any malformed/foreign hash rather than throwing.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!N || !r || !p) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
