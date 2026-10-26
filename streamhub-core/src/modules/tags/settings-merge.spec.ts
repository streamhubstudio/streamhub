/**
 * Unit specs for resolveStreamSettings — the pure per-stream settings merge
 * (module `tags`, Vision-Edge §E).
 *
 * Locks the precedence + merge semantics the vision scheduler will rely on:
 *  - precedence model defaults < tag configs (in order) < per-stream overrides;
 *  - plain objects merge recursively (deep), arrays are REPLACED not concatenated;
 *  - the result is a deep clone (no input object/array leaks into the output).
 */
import { deepMergeSettings, resolveStreamSettings } from './settings-merge';

describe('resolveStreamSettings', () => {
  it('later layers win (defaults < tags < overrides)', () => {
    const out = resolveStreamSettings(
      { fps: 3, conf: 0.4, model: 'yolo11n' },
      [{ conf: 0.5 }, { conf: 0.6, zone: 'a' }],
      { fps: 5 },
    );
    expect(out).toEqual({ fps: 5, conf: 0.6, model: 'yolo11n', zone: 'a' });
  });

  it('deep-merges nested objects across layers', () => {
    const out = resolveStreamSettings(
      { detect: { persons: true, vehicles: false } },
      [{ detect: { vehicles: true } }],
      { detect: { minArea: 100 } },
    );
    expect(out).toEqual({
      detect: { persons: true, vehicles: true, minArea: 100 },
    });
  });

  it('REPLACES arrays wholesale (never concatenates)', () => {
    const out = resolveStreamSettings(
      { zones: [1, 2, 3] },
      [{ zones: [4, 5] }],
      {},
    );
    expect(out).toEqual({ zones: [4, 5] });
  });

  it('a higher-layer array replaces a lower-layer object and vice-versa', () => {
    expect(resolveStreamSettings({ x: { a: 1 } }, [], { x: [9] })).toEqual({
      x: [9],
    });
    expect(resolveStreamSettings({ x: [9] }, [], { x: { a: 1 } })).toEqual({
      x: { a: 1 },
    });
  });

  it('tolerates missing/empty layers and non-object entries', () => {
    expect(resolveStreamSettings(undefined, undefined, undefined)).toEqual({});
    expect(
      resolveStreamSettings({ a: 1 }, [null as never, 'bad' as never], {
        b: 2,
      }),
    ).toEqual({ a: 1, b: 2 });
  });

  it('returns a deep clone — inputs are never mutated or shared', () => {
    const defaults = { detect: { persons: true }, zones: [1] };
    const tag = { zones: [2, 3] };
    const out = resolveStreamSettings(defaults, [tag], {});
    // Mutating the output must not touch the inputs.
    (out.detect as { persons: boolean }).persons = false;
    (out.zones as number[]).push(99);
    expect(defaults).toEqual({ detect: { persons: true }, zones: [1] });
    expect(tag).toEqual({ zones: [2, 3] });
  });
});

describe('deepMergeSettings', () => {
  it('does not mutate either argument', () => {
    const a = { n: { x: 1 } };
    const b = { n: { y: 2 } };
    const out = deepMergeSettings(a, b);
    expect(out).toEqual({ n: { x: 1, y: 2 } });
    expect(a).toEqual({ n: { x: 1 } });
    expect(b).toEqual({ n: { y: 2 } });
  });
});
