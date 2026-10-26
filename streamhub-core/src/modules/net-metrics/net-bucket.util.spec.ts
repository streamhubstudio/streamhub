/**
 * Unit spec — net-bucket.util (pure hour-bucket math for net-metrics).
 * Locks the UTC bucket format, rolling-window lower bound, and GB→bytes guard.
 */
import {
  GB_BYTES,
  gbToBytes,
  hourBucket,
  windowStartBucket,
} from './net-bucket.util';

describe('net-bucket.util', () => {
  describe('hourBucket', () => {
    it('formats an instant as UTC YYYY-MM-DDTHH', () => {
      const at = Date.UTC(2026, 6, 11, 14, 37, 5); // 2026-07-11 14:37:05 UTC
      expect(hourBucket(at)).toBe('2026-07-11T14');
    });

    it('accepts a Date and truncates to the hour', () => {
      expect(hourBucket(new Date('2026-01-02T03:59:59.999Z'))).toBe(
        '2026-01-02T03',
      );
    });

    it('is stable within an hour and increments across the boundary', () => {
      const base = Date.UTC(2026, 0, 1, 9, 0, 0);
      expect(hourBucket(base)).toBe(hourBucket(base + 59 * 60_000));
      expect(hourBucket(base + 60 * 60_000)).toBe('2026-01-01T10');
    });
  });

  describe('windowStartBucket', () => {
    it('returns the bucket N hours before now', () => {
      const now = Date.UTC(2026, 6, 11, 14, 30, 0);
      expect(windowStartBucket(now, 24)).toBe('2026-07-10T14');
      expect(windowStartBucket(now, 1)).toBe('2026-07-11T13');
    });

    it('clamps negative windows to now', () => {
      const now = Date.UTC(2026, 6, 11, 14, 0, 0);
      expect(windowStartBucket(now, -5)).toBe('2026-07-11T14');
    });
  });

  describe('gbToBytes', () => {
    it('converts GB using binary GiB units', () => {
      expect(gbToBytes(1)).toBe(GB_BYTES);
      expect(gbToBytes(2)).toBe(2 * 1024 ** 3);
    });

    it('treats missing / non-positive / NaN as 0', () => {
      expect(gbToBytes(0)).toBe(0);
      expect(gbToBytes(-3)).toBe(0);
      expect(gbToBytes(undefined)).toBe(0);
      expect(gbToBytes(NaN)).toBe(0);
    });
  });
});
