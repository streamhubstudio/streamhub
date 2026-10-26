/**
 * Unit spec — per-app secret crypto (Streamflow). Pure node:crypto, no IO.
 * Locks: AES-256-GCM round-trip, per-app HKDF key isolation, tamper/foreign
 * rejection (null, never throws), empty-master refusal, masking + redaction.
 */
import {
  decryptSecret,
  encryptSecret,
  looksMasked,
  maskSecret,
  redactSecretValues,
} from './secret-crypt.util';

const MASTER = 'deployment-jwt-secret-abc';

describe('encrypt / decrypt', () => {
  it('round-trips a value under the same app + master', () => {
    const enc = encryptSecret('sk-live-XYZ', MASTER, 'live');
    expect(enc.startsWith('aesgcm$')).toBe(true);
    expect(enc.includes('sk-live-XYZ')).toBe(false); // ciphertext, not plaintext
    expect(decryptSecret(enc, MASTER, 'live')).toBe('sk-live-XYZ');
  });

  it('is per-app: app A ciphertext does NOT decrypt under app B', () => {
    const enc = encryptSecret('topsecret', MASTER, 'appA');
    expect(decryptSecret(enc, MASTER, 'appB')).toBeNull();
    expect(decryptSecret(enc, MASTER, 'appA')).toBe('topsecret');
  });

  it('fails closed on a wrong master, tamper, or malformed value', () => {
    const enc = encryptSecret('v', MASTER, 'live');
    expect(decryptSecret(enc, 'other-master', 'live')).toBeNull();
    expect(decryptSecret(enc + 'x', MASTER, 'live')).toBeNull();
    expect(decryptSecret('not-a-secret', MASTER, 'live')).toBeNull();
    expect(decryptSecret('', MASTER, 'live')).toBeNull();
  });

  it('refuses to encrypt without a master secret or app', () => {
    expect(() => encryptSecret('v', '', 'live')).toThrow();
    expect(() => encryptSecret('v', MASTER, '')).toThrow();
  });

  it('uses a fresh IV per write (two encrypts differ)', () => {
    const a = encryptSecret('same', MASTER, 'live');
    const b = encryptSecret('same', MASTER, 'live');
    expect(a).not.toBe(b);
    expect(decryptSecret(a, MASTER, 'live')).toBe('same');
    expect(decryptSecret(b, MASTER, 'live')).toBe('same');
  });
});

describe('maskSecret', () => {
  it('shows a prefix hint + last4, empty for empty', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('sk-livekey1234abcd')).toBe('sk-…abcd');
    expect(maskSecret('plainlongvalue9999')).toBe('pl…9999');
    expect(maskSecret('abcd')).toBe('…');
  });
  it('looksMasked detects the ellipsis sentinel', () => {
    expect(looksMasked('sk-…abcd')).toBe(true);
    expect(looksMasked('sk-live-real')).toBe(false);
  });
});

describe('redactSecretValues', () => {
  it('scrubs secret substrings from nested output', () => {
    const out = redactSecretValues(
      { header: 'Bearer sk-live-XYZ', nested: ['sk-live-XYZ', 'ok'] },
      ['sk-live-XYZ'],
    );
    expect(out).toEqual({ header: 'Bearer [redacted]', nested: ['[redacted]', 'ok'] });
  });
  it('ignores short/empty needles and leaves clean values', () => {
    expect(redactSecretValues({ a: 'hello' }, [])).toEqual({ a: 'hello' });
    expect(redactSecretValues({ a: 'hello' }, ['a'])).toEqual({ a: 'hello' }); // needle < 4
  });
});
