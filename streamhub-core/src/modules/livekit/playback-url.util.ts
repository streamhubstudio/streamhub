/**
 * Signed short-lived playback URLs (security fix P0-3, OWASP A01/A06).
 *
 * `GET /apps/:app/play-token/:room` is @Public by design (it powers the
 * anonymous /play + /embed players). Before this fix the ONLY thing protecting
 * a room whose app had `features.public_playback: false` was… the 404 on that
 * endpoint, and for apps left public the only barrier was guessing the room
 * name (security by obscurity).
 *
 * With this util, a PRIVATE app's playback needs a capability URL:
 *
 *   /api/v1/apps/<app>/play-token/<room>?exp=<unix-seconds>&sig=<hex>
 *
 *   sig = HMAC-SHA256( perAppSecret, `${app}\n${room}\n${exp}` )
 *   perAppSecret = HMAC-SHA256( STREAMHUB_JWT_SECRET, `playback:${app}` )
 *
 * Properties:
 *  - per-app secret (derived, no schema/config change; rotating the master
 *    rotates every app secret);
 *  - tenant-scoped: a signature for app A never validates for app B, and the
 *    room is part of the MAC (no cross-room reuse);
 *  - short TTL (default 300 s, clamped 30 s…24 h) — `exp` is inside the MAC so
 *    it cannot be extended;
 *  - constant-time comparison (crypto.timingSafeEqual) — no byte-by-byte
 *    signature oracles.
 *
 * PUBLIC apps (`public_playback` unset/true) are untouched: the endpoint keeps
 * minting anonymous subscribe-only tokens with no signature (back-compat).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default lifetime of a signed playback URL (seconds). */
export const DEFAULT_PLAYBACK_TTL_S = 300;
/** Clamp bounds for the requested TTL. */
export const MIN_PLAYBACK_TTL_S = 30;
export const MAX_PLAYBACK_TTL_S = 86_400;

/** Per-app playback signing key, derived from the platform master secret. */
export function playbackSecretFor(masterSecret: string, app: string): Buffer {
  return createHmac('sha256', masterSecret).update(`playback:${app}`).digest();
}

/** Hex HMAC over the canonical `app\nroom\nexp` string. */
export function signPlayback(
  masterSecret: string,
  app: string,
  room: string,
  exp: number,
): string {
  return createHmac('sha256', playbackSecretFor(masterSecret, app))
    .update(`${app}\n${room}\n${exp}`)
    .digest('hex');
}

export type PlaybackVerdict = 'ok' | 'expired' | 'invalid';

/**
 * Verify a signed playback URL. Returns:
 *  - 'invalid' — missing/malformed exp or sig, wrong signature (incl. any
 *    tampering of app/room/exp), or no master secret configured;
 *  - 'expired' — signature is genuine but `exp` is in the past;
 *  - 'ok'      — genuine and not expired.
 *
 * Signature is checked BEFORE expiry so a tampered-then-expired URL reads as
 * 'invalid', and comparison is constant-time.
 */
export function verifyPlayback(opts: {
  masterSecret: string;
  app: string;
  room: string;
  exp?: string | number;
  sig?: string;
  /** Test seam; defaults to Date.now(). */
  nowMs?: number;
}): PlaybackVerdict {
  if (!opts.masterSecret) return 'invalid';

  const expRaw = typeof opts.exp === 'number' ? String(opts.exp) : opts.exp;
  if (!expRaw || !/^\d{1,12}$/.test(expRaw)) return 'invalid';
  const exp = Number(expRaw);

  const sig = (opts.sig || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return 'invalid';

  const expected = signPlayback(opts.masterSecret, opts.app, opts.room, exp);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';

  const now = opts.nowMs ?? Date.now();
  if (exp * 1000 < now) return 'expired';
  return 'ok';
}

/** Clamp a requested TTL (seconds) into [MIN, MAX]; default when absent/NaN. */
export function clampPlaybackTtl(ttl: unknown): number {
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PLAYBACK_TTL_S;
  return Math.min(Math.max(Math.floor(n), MIN_PLAYBACK_TTL_S), MAX_PLAYBACK_TTL_S);
}
