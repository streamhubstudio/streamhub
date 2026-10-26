/**
 * Unit — auth/secret-cipher.util (AES-256-GCM at-rest encryption for the TOTP
 * secret + the per-user SMTP password, owner item 29). Locks down:
 *   - round-trip encrypt/decrypt for both secret kinds,
 *   - DOMAIN SEPARATION: a TOTP-encrypted value can never decrypt as an SMTP
 *     secret (and vice-versa) even under the SAME master secret,
 *   - tamper/garbage/wrong-key input degrades to null, never throws.
 */
import {
  decryptSecret,
  decryptUserSmtpSecret,
  encryptSecret,
  encryptUserSmtpSecret,
} from './secret-cipher.util';

const MASTER = 'test-jwt-secret-1234567890';

describe('auth/secret-cipher.util', () => {
  describe('TOTP secret (encryptSecret/decryptSecret)', () => {
    it('round-trips a plaintext secret', () => {
      const stored = encryptSecret('JBSWY3DPEHPK3PXP', MASTER);
      expect(stored).toMatch(/^aesgcm\$/);
      expect(decryptSecret(stored, MASTER)).toBe('JBSWY3DPEHPK3PXP');
    });

    it('never returns the plaintext verbatim in the stored form', () => {
      const stored = encryptSecret('JBSWY3DPEHPK3PXP', MASTER);
      expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    });

    it('returns null for a wrong master secret', () => {
      const stored = encryptSecret('JBSWY3DPEHPK3PXP', MASTER);
      expect(decryptSecret(stored, 'a-different-master')).toBeNull();
    });

    it('returns null for tampered/garbage/empty input, never throws', () => {
      expect(decryptSecret('not-aesgcm-at-all', MASTER)).toBeNull();
      expect(decryptSecret('', MASTER)).toBeNull();
      expect(decryptSecret('aesgcm$only$two', MASTER)).toBeNull();
      const stored = encryptSecret('JBSWY3DPEHPK3PXP', MASTER);
      const tampered = stored.slice(0, -2) + 'zz';
      expect(decryptSecret(tampered, MASTER)).toBeNull();
    });

    it('throws only when encrypting with an empty master secret', () => {
      expect(() => encryptSecret('x', '')).toThrow();
    });
  });

  describe('per-user SMTP secret (encryptUserSmtpSecret/decryptUserSmtpSecret)', () => {
    it('round-trips a plaintext SMTP password', () => {
      const stored = encryptUserSmtpSecret('s3cret-app-password', MASTER);
      expect(stored).toMatch(/^aesgcm\$/);
      expect(decryptUserSmtpSecret(stored, MASTER)).toBe('s3cret-app-password');
    });

    it('returns null for a wrong master secret / tampered value', () => {
      const stored = encryptUserSmtpSecret('s3cret-app-password', MASTER);
      expect(decryptUserSmtpSecret(stored, 'wrong')).toBeNull();
      expect(decryptUserSmtpSecret(stored.slice(0, -2) + 'zz', MASTER)).toBeNull();
    });
  });

  describe('domain separation (TOTP vs user-SMTP, owner item 29)', () => {
    it('a TOTP-encrypted value does NOT decrypt as an SMTP secret under the same master', () => {
      const totpStored = encryptSecret('same-plaintext-value', MASTER);
      expect(decryptUserSmtpSecret(totpStored, MASTER)).toBeNull();
    });

    it('an SMTP-encrypted value does NOT decrypt as a TOTP secret under the same master', () => {
      const smtpStored = encryptUserSmtpSecret('same-plaintext-value', MASTER);
      expect(decryptSecret(smtpStored, MASTER)).toBeNull();
    });
  });
});
