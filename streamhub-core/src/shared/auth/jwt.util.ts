import * as crypto from 'crypto';

/**
 * Minimal HS256 JWT sign/verify built on Node's `crypto` (no extra deps —
 * keeps the `npm run build` / tsc footprint unchanged). Used by the auth module
 * to mint UI login tokens and by the guard to accept them alongside `sk_` API
 * tokens. Only HS256 is supported on purpose.
 */

export interface JwtPayload {
  /** Subject — the authenticated principal (the admin username). */
  sub: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  [claim: string]: unknown;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromB64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/**
 * Sign a compact HS256 JWT. `iat`/`exp` are added automatically from
 * `expiresInSec`; any extra claims (e.g. `sub`) come from `claims`.
 */
export function signJwt(
  claims: Record<string, unknown>,
  secret: string,
  expiresInSec: number,
): string {
  if (!secret) throw new Error('signJwt: empty secret');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iat: now, exp: now + expiresInSec, ...claims };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify an HS256 JWT signed with `secret`. Throws on malformed token, wrong
 * algorithm, bad signature, or expiry. Returns the decoded payload on success.
 */
export function verifyJwt(token: string, secret: string): JwtPayload {
  if (!secret) throw new Error('verifyJwt: empty secret');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [encHeader, encPayload, sig] = parts;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64url');
  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw new Error('invalid signature');
  }

  const header = JSON.parse(fromB64url(encHeader)) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('unsupported alg');

  const payload = JSON.parse(fromB64url(encPayload)) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new Error('token expired');
  }
  return payload;
}
