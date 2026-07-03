/**
 * Unit — auth/password.util (scrypt KDF).
 *
 * The built-in identity store hashes passwords with salted scrypt in the
 * self-describing form `scrypt$N$r$p$saltHex$hashHex`. These tests lock the
 * format, the round-trip, the constant-time-verify surface and the
 * reject-on-garbage behaviour (verifyPassword must NEVER throw).
 *
 * Owned by: auth-tenancy test agent.
 */
import {
  generateRandomPassword,
  hashPassword,
  hashRandomPassword,
  verifyPassword,
} from './password.util';

describe('auth/password.util (scrypt)', () => {
  describe('hashPassword', () => {
    it('emits the self-describing scrypt$N$r$p$salt$hash format', () => {
      const h = hashPassword('correct horse battery staple');
      const parts = h.split('$');
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe('scrypt');
      expect(Number.parseInt(parts[1], 10)).toBe(1 << 15); // N
      expect(Number.parseInt(parts[2], 10)).toBe(8); // r
      expect(Number.parseInt(parts[3], 10)).toBe(1); // p
      expect(parts[4]).toMatch(/^[0-9a-f]{32}$/); // 16-byte salt hex
      expect(parts[5]).toMatch(/^[0-9a-f]{128}$/); // 64-byte key hex
    });

    it('uses a fresh random salt each call (same password → different hash)', () => {
      const a = hashPassword('same-password');
      const b = hashPassword('same-password');
      expect(a).not.toEqual(b);
      // …yet both verify.
      expect(verifyPassword('same-password', a)).toBe(true);
      expect(verifyPassword('same-password', b)).toBe(true);
    });
  });

  describe('verifyPassword', () => {
    it('accepts the correct password', () => {
      const stored = hashPassword('s3cret-passphrase');
      expect(verifyPassword('s3cret-passphrase', stored)).toBe(true);
    });

    it('rejects a wrong password', () => {
      const stored = hashPassword('s3cret-passphrase');
      expect(verifyPassword('s3cret-passphras', stored)).toBe(false);
      expect(verifyPassword('S3cret-passphrase', stored)).toBe(false);
      expect(verifyPassword('', stored)).toBe(false);
    });

    it('returns false (never throws) on structurally malformed / foreign hashes', () => {
      for (const bad of [
        '',
        'not-a-hash',
        'bcrypt$…',
        'scrypt$0$8$1$aa$bb', // N=0 → invalid params
        'scrypt$32768$8', // too few segments
        'scrypt$32768$8$1$aa$bb$cc', // too many segments
      ]) {
        expect(() => verifyPassword('whatever', bad)).not.toThrow();
        expect(verifyPassword('whatever', bad)).toBe(false);
      }
    });

    it('rejects a same-length hash with tampered content', () => {
      const stored = hashPassword('pw');
      const parts = stored.split('$');
      // Flip one nibble, preserving length → mismatching buffer → false.
      parts[5] = (parts[5][0] === 'a' ? 'b' : 'a') + parts[5].slice(1);
      expect(verifyPassword('pw', parts.join('$'))).toBe(false);
    });

    /**
     * Robustness note (documented, low-severity): verifyPassword derives a key of
     * `expected.length` bytes, so a stored hash whose hex fields decode to an
     * EMPTY buffer (e.g. non-hex garbage) compares two zero-length buffers and
     * returns TRUE; likewise a byte-aligned TRUNCATION of a real hash verifies
     * (scrypt's final PBKDF2 step has the prefix property). Neither is reachable
     * in practice — `password_hash` is only ever written by hashPassword(), which
     * always emits a full 16-byte salt + 64-byte key — but a future caller that
     * persisted an attacker-influenced hash string would be at risk. Captured
     * here so the behaviour is known, not silently assumed safe.
     */
    it('documents the empty-hex edge (verifies true — see note above)', () => {
      expect(verifyPassword('anything', 'scrypt$32768$8$1$$')).toBe(true);
    });
  });

  describe('generateRandomPassword / hashRandomPassword', () => {
    it('generates a strong, unique base64url secret each call', () => {
      const a = generateRandomPassword();
      const b = generateRandomPassword();
      expect(a).not.toEqual(b);
      // 32 bytes base64url ≈ 43 chars, url-safe alphabet only.
      expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    });

    it('hashRandomPassword emits a valid scrypt hash nobody can verify', () => {
      const stored = hashRandomPassword();
      expect(stored).toMatch(/^scrypt\$/);
      // The plaintext is thrown away, so no known password verifies → login
      // is effectively disabled for accounts seeded this way.
      expect(verifyPassword('', stored)).toBe(false);
      expect(verifyPassword('password', stored)).toBe(false);
    });
  });
});
