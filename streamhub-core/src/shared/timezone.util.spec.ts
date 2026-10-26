/**
 * Unit — shared/timezone.util (owner item 11: per-app timezone).
 *
 * Locks down: empty string is always a valid "server default"; real IANA
 * zones validate; garbage does not; the listing helper returns a non-empty,
 * de-duplicated, sorted list that always contains UTC.
 */
import { FALLBACK_TIMEZONES, isValidTimezone, listTimezones } from './timezone.util';

describe('shared/timezone.util', () => {
  describe('isValidTimezone', () => {
    it('treats the empty string as valid (server/host local default)', () => {
      expect(isValidTimezone('')).toBe(true);
    });

    it('accepts well-known IANA zone names', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
      expect(isValidTimezone('Europe/Madrid')).toBe(true);
      expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    });

    it('rejects garbage / non-IANA strings', () => {
      expect(isValidTimezone('Not/AZone')).toBe(false);
      expect(isValidTimezone('literally anything')).toBe(false);
      expect(isValidTimezone('GMT+25')).toBe(false);
    });

    it('rejects a merely-plausible-looking but unknown zone', () => {
      expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    });
  });

  describe('listTimezones', () => {
    it('returns a non-empty, sorted, de-duplicated list containing UTC', () => {
      const zones = listTimezones();
      expect(zones.length).toBeGreaterThan(0);
      expect(zones).toContain('UTC');
      expect(new Set(zones).size).toBe(zones.length);
      const sorted = [...zones].sort();
      expect(zones).toEqual(sorted);
    });

    it('every listed zone validates', () => {
      // Bounded sample so the suite stays fast even with a full ICU zone list.
      const sample = listTimezones().slice(0, 25);
      for (const tz of sample) {
        expect(isValidTimezone(tz)).toBe(true);
      }
    });
  });

  describe('FALLBACK_TIMEZONES', () => {
    it('is a non-empty list of real IANA zones (sanity check on the constant itself)', () => {
      expect(FALLBACK_TIMEZONES.length).toBeGreaterThan(10);
      expect(FALLBACK_TIMEZONES).toContain('UTC');
      for (const tz of FALLBACK_TIMEZONES) {
        expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
      }
    });
  });
});
