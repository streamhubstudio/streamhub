/**
 * Unit spec — signed playback URL primitives (playback-url.util.ts, fix P0-3).
 *
 * Pins the capability-URL contract for private-playback apps:
 *   - a signature minted with signPlayback verifies 'ok' before exp;
 *   - 'expired' only when the signature is GENUINE but past exp;
 *   - ANY tampering (room, app, exp, sig byte) → 'invalid' (not 'expired' —
 *     tampered exp must never reach the expiry branch);
 *   - malformed inputs / missing master secret → 'invalid';
 *   - per-app secrets differ (app A's sig never validates for app B);
 *   - TTL clamping (default 300, floor 30, cap 86400).
 */
import {
  clampPlaybackTtl,
  DEFAULT_PLAYBACK_TTL_S,
  MAX_PLAYBACK_TTL_S,
  MIN_PLAYBACK_TTL_S,
  playbackSecretFor,
  signPlayback,
  verifyPlayback,
} from './playback-url.util';

const MASTER = 'test-master-secret';
const NOW = 1_800_000_000_000; // fixed clock (ms)
const EXP = Math.floor(NOW / 1000) + 300;

function sigFor(app = 'live', room = 'show', exp = EXP): string {
  return signPlayback(MASTER, app, room, exp);
}

describe('playback-url.util — verifyPlayback', () => {
  it('accepts a genuine, unexpired signature', () => {
    expect(
      verifyPlayback({
        masterSecret: MASTER,
        app: 'live',
        room: 'show',
        exp: String(EXP),
        sig: sigFor(),
        nowMs: NOW,
      }),
    ).toBe('ok');
  });

  it('reports "expired" for a genuine signature past exp', () => {
    expect(
      verifyPlayback({
        masterSecret: MASTER,
        app: 'live',
        room: 'show',
        exp: String(EXP),
        sig: sigFor(),
        nowMs: (EXP + 1) * 1000,
      }),
    ).toBe('expired');
  });

  it('rejects a TAMPERED room / app / exp as invalid (not expired)', () => {
    const base = { masterSecret: MASTER, exp: String(EXP), sig: sigFor(), nowMs: NOW };
    expect(verifyPlayback({ ...base, app: 'live', room: 'other-room' })).toBe('invalid');
    expect(verifyPlayback({ ...base, app: 'other-app', room: 'show' })).toBe('invalid');
    // Attacker extends exp on a genuine sig → MAC mismatch, never 'expired'.
    expect(
      verifyPlayback({
        masterSecret: MASTER,
        app: 'live',
        room: 'show',
        exp: String(EXP + 9999),
        sig: sigFor(),
        nowMs: NOW,
      }),
    ).toBe('invalid');
  });

  it('rejects a flipped signature byte / wrong length / non-hex', () => {
    const good = sigFor();
    const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    const base = { masterSecret: MASTER, app: 'live', room: 'show', exp: String(EXP), nowMs: NOW };
    expect(verifyPlayback({ ...base, sig: flipped })).toBe('invalid');
    expect(verifyPlayback({ ...base, sig: good.slice(0, 32) })).toBe('invalid');
    expect(verifyPlayback({ ...base, sig: 'z'.repeat(64) })).toBe('invalid');
  });

  it('rejects missing/malformed exp or sig and a missing master secret', () => {
    const base = { app: 'live', room: 'show', nowMs: NOW };
    expect(verifyPlayback({ ...base, masterSecret: MASTER })).toBe('invalid');
    expect(
      verifyPlayback({ ...base, masterSecret: MASTER, exp: 'soon', sig: sigFor() }),
    ).toBe('invalid');
    expect(
      verifyPlayback({ ...base, masterSecret: MASTER, exp: '-5', sig: sigFor() }),
    ).toBe('invalid');
    expect(
      verifyPlayback({ ...base, masterSecret: '', exp: String(EXP), sig: sigFor() }),
    ).toBe('invalid');
  });

  it('derives DIFFERENT secrets per app from the same master', () => {
    const a = playbackSecretFor(MASTER, 'app-a');
    const b = playbackSecretFor(MASTER, 'app-b');
    expect(a.equals(b)).toBe(false);
    expect(signPlayback(MASTER, 'app-a', 'r', EXP)).not.toBe(
      signPlayback(MASTER, 'app-b', 'r', EXP),
    );
  });
});

describe('playback-url.util — clampPlaybackTtl', () => {
  it('defaults, floors and caps', () => {
    expect(clampPlaybackTtl(undefined)).toBe(DEFAULT_PLAYBACK_TTL_S);
    expect(clampPlaybackTtl('nope')).toBe(DEFAULT_PLAYBACK_TTL_S);
    expect(clampPlaybackTtl(0)).toBe(DEFAULT_PLAYBACK_TTL_S);
    expect(clampPlaybackTtl(5)).toBe(MIN_PLAYBACK_TTL_S);
    expect(clampPlaybackTtl(3600)).toBe(3600);
    expect(clampPlaybackTtl(999_999_999)).toBe(MAX_PLAYBACK_TTL_S);
  });
});
