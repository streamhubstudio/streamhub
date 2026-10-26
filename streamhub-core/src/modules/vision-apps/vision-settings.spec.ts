/**
 * Unit specs for the PURE per-model settings validator (vision-settings.ts).
 *
 * Locks the Wave-2 CONTRACT schemas: polygons need ≥3 points and clamp to 0–1,
 * lines need a positive length + a valid `inside`, demography engines are gated,
 * unknown keys are dropped, and an unknown model is rejected.
 */
import {
  VisionSettingsError,
  emptyModelSettings,
  validateModelSettings,
} from './vision-settings';

describe('validateModelSettings', () => {
  describe('occupancy / crowd (zones)', () => {
    it('normalizes a polygon: clamps to 0–1, rounds, drops unknown keys', () => {
      const out = validateModelSettings('occupancy', {
        zones: [
          {
            id: 'z1',
            tag: 'store-a',
            detect: 'personas',
            points: [
              [1.4, -0.2],
              [0.500009, 0.25],
              [0.1, 0.9],
            ],
            confidence: 0.42,
            alertLimit: 5,
            alertAfterSec: 30,
            evil: 'nope',
          },
        ],
      }) as { zones: unknown[] };
      expect(out.zones[0]).toEqual({
        id: 'z1',
        tag: 'store-a',
        detect: 'personas',
        points: [
          [1, 0],
          [0.5, 0.25],
          [0.1, 0.9],
        ],
        confidence: 0.42,
        alertLimit: 5,
        alertAfterSec: 30,
      });
      expect((out.zones[0] as Record<string, unknown>).evil).toBeUndefined();
    });

    it('defaults detect to personas and auto-fills a missing id', () => {
      const out = validateModelSettings('crowd', {
        zones: [{ points: [[0, 0], [1, 0], [1, 1]] }],
      }) as { zones: { id: string; detect: string }[] };
      expect(out.zones[0].detect).toBe('personas');
      expect(out.zones[0].id).toBe('zone-1');
    });

    it('rejects a polygon with fewer than 3 points', () => {
      expect(() =>
        validateModelSettings('occupancy', {
          zones: [{ points: [[0, 0], [1, 1]] }],
        }),
      ).toThrow(VisionSettingsError);
    });

    it('rejects a non-array zones and a bad detect', () => {
      expect(() => validateModelSettings('occupancy', { zones: {} })).toThrow(
        VisionSettingsError,
      );
      expect(() =>
        validateModelSettings('occupancy', {
          zones: [{ points: [[0, 0], [1, 0], [1, 1]], detect: 'cars' }],
        }),
      ).toThrow(VisionSettingsError);
    });

    it('treats an empty body as no zones', () => {
      expect(validateModelSettings('occupancy', {})).toEqual({ zones: [] });
      expect(validateModelSettings('occupancy', undefined)).toEqual({ zones: [] });
    });
  });

  describe('counting (lines)', () => {
    it('normalizes a line + fps + capacity', () => {
      const out = validateModelSettings('counting', {
        lines: [
          { id: 'l1', tag: 'door', x: 0.2, y: 0.5, length: 0.6, angle: 12, inside: 'top' },
        ],
        fps: 4,
        capacity: 50,
      }) as { lines: unknown[]; fps: number; capacity: number };
      expect(out.lines[0]).toEqual({
        id: 'l1',
        tag: 'door',
        x: 0.2,
        y: 0.5,
        length: 0.6,
        angle: 12,
        inside: 'top',
      });
      expect(out.fps).toBe(4);
      expect(out.capacity).toBe(50);
    });

    it('defaults fps to 3.5 and rejects a bad inside / non-positive length', () => {
      const out = validateModelSettings('counting', { lines: [] }) as { fps: number };
      expect(out.fps).toBe(3.5);
      expect(() =>
        validateModelSettings('counting', {
          lines: [{ x: 0, y: 0, length: 0.5, inside: 'sideways' }],
        }),
      ).toThrow(VisionSettingsError);
      expect(() =>
        validateModelSettings('counting', {
          lines: [{ x: 0, y: 0, length: 0, inside: 'top' }],
        }),
      ).toThrow(VisionSettingsError);
    });

    it('normalizes optional POIs (item 34) + auto-fills a missing id', () => {
      const out = validateModelSettings('counting', {
        lines: [],
        pois: [
          { id: 'aisle', tag: 'aisle-3', points: [[1.2, -0.1], [0.8, 0.2], [0.5, 0.9]], evil: 'x' },
          { points: [[0, 0], [1, 0], [1, 1]] },
        ],
      }) as { pois: { id: string; tag: string; points: number[][] }[] };
      expect(out.pois).toHaveLength(2);
      expect(out.pois[0]).toEqual({ id: 'aisle', tag: 'aisle-3', points: [[1, 0], [0.8, 0.2], [0.5, 0.9]] });
      expect(out.pois[1].id).toBe('poi-2'); // auto-filled
      expect((out.pois[0] as Record<string, unknown>).evil).toBeUndefined();
    });

    it('omits pois when absent (backward compatible) and rejects a bad POI', () => {
      const out = validateModelSettings('counting', { lines: [] }) as { pois?: unknown };
      expect(out.pois).toBeUndefined();
      expect(() =>
        validateModelSettings('counting', { lines: [], pois: [{ points: [[0, 0], [1, 1]] }] }),
      ).toThrow(VisionSettingsError);
      expect(() =>
        validateModelSettings('counting', { lines: [], pois: {} }),
      ).toThrow(VisionSettingsError);
    });
  });

  describe('demography', () => {
    it('accepts local by default and normalizes roi + interval', () => {
      const out = validateModelSettings('demography', {
        intervalSec: 90,
        roi: { points: [[0, 0], [1, 0], [1, 1]] },
      }) as { engine: string; intervalSec: number; roi: { points: number[][] } };
      expect(out.engine).toBe('local');
      expect(out.intervalSec).toBe(90);
      expect(out.roi.points).toHaveLength(3);
    });

    it('accepts openai/deepseek but rejects an unknown engine', () => {
      expect((validateModelSettings('demography', { engine: 'openai' }) as { engine: string }).engine).toBe('openai');
      expect(() => validateModelSettings('demography', { engine: 'gemini' })).toThrow(
        VisionSettingsError,
      );
    });

    it('rejects an roi with fewer than 3 points', () => {
      expect(() =>
        validateModelSettings('demography', { roi: { points: [[0, 0]] } }),
      ).toThrow(VisionSettingsError);
    });

    it('accepts optional POIs alongside a legacy roi (item 34)', () => {
      const out = validateModelSettings('demography', {
        intervalSec: 120,
        roi: { points: [[0, 0], [1, 0], [1, 1]] },
        pois: [{ id: 'till', tag: 'checkout', points: [[0.6, 0], [1, 0], [1, 1], [0.6, 1]] }],
      }) as { roi: { points: number[][] }; pois: { tag: string }[] };
      expect(out.roi.points).toHaveLength(3);
      expect(out.pois).toHaveLength(1);
      expect(out.pois[0].tag).toBe('checkout');
      // Absent → omitted (backward compatible).
      expect((validateModelSettings('demography', {}) as { pois?: unknown }).pois).toBeUndefined();
    });
  });

  it('rejects an unknown model', () => {
    expect(() => validateModelSettings('facerec', {})).toThrow(VisionSettingsError);
  });

  it('emptyModelSettings gives a valid base per model', () => {
    expect(emptyModelSettings('occupancy')).toEqual({ zones: [] });
    expect(emptyModelSettings('counting')).toEqual({ lines: [], fps: 3.5 });
    expect(emptyModelSettings('demography')).toEqual({ intervalSec: 120, engine: 'local' });
  });
});
