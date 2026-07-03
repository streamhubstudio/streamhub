/**
 * Unit spec — G4 config presets (pure logic).
 *
 * Locks down the declarative preset catalogue + the credential-safe deep-merge
 * used by AppsService.applyConfigPreset. No DB / filesystem — pure functions.
 */
import {
  CONFIG_PRESETS,
  PRESET_PROTECTED_KEYS,
  applyPresetPatch,
  deepMerge,
  findPreset,
  stripProtected,
} from './config-presets';

describe('config-presets — catalogue', () => {
  it('ships exactly the three brief presets with unique ids', () => {
    const names = CONFIG_PRESETS.map((p) => p.name);
    expect(names).toEqual([
      'low-latency',
      'high-quality-recording',
      'mass-audience-HLS',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every preset has a title/description/useCase + a non-empty "sets" summary', () => {
    for (const p of CONFIG_PRESETS) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.useCase.length).toBeGreaterThan(0);
      expect(Array.isArray(p.sets) && p.sets.length).toBeTruthy();
    }
  });

  it('NO preset patch touches a protected (credential/identity) key', () => {
    for (const p of CONFIG_PRESETS) {
      for (const key of Object.keys(p.patch)) {
        expect(PRESET_PROTECTED_KEYS).not.toContain(key);
      }
    }
  });

  it('findPreset resolves by id and is undefined for the unknown', () => {
    expect(findPreset('low-latency')?.name).toBe('low-latency');
    expect(findPreset('nope')).toBeUndefined();
  });

  it('low-latency = passthrough + simulcast (WebRTC-first)', () => {
    const p = findPreset('low-latency')!;
    expect((p.patch.transcoding as any).enabled).toBe(false);
    expect((p.patch.webrtc as any).adaptive).toBe(true);
    expect((p.patch.distribution as any).mode).toBe('edge');
  });

  it('high-quality-recording = transcoding ON + adaptive VOD ladder', () => {
    const p = findPreset('high-quality-recording')!;
    expect((p.patch.transcoding as any).enabled).toBe(true);
    expect((p.patch.transcoding as any).vod_adaptive).toBe(true);
    expect((p.patch.transcoding as any).vod_renditions.length).toBeGreaterThan(0);
  });

  it('mass-audience-HLS = HLS ladder behind a CDN', () => {
    const p = findPreset('mass-audience-HLS')!;
    expect((p.patch.distribution as any).mode).toBe('cdn');
    expect((p.patch.hls as any).segment_seconds).toBe(4);
    expect((p.patch.transcoding as any).vod_adaptive).toBe(true);
  });
});

describe('config-presets — deepMerge', () => {
  it('merges nested objects recursively', () => {
    const out = deepMerge(
      { a: { x: 1, y: 2 }, keep: true },
      { a: { y: 9, z: 3 } },
    );
    expect(out).toEqual({ a: { x: 1, y: 9, z: 3 }, keep: true });
  });

  it('REPLACES arrays wholesale (ladder swap, not concat)', () => {
    const out = deepMerge(
      { layers: [{ h: 720 }, { h: 480 }, { h: 240 }] },
      { layers: [{ h: 1080 }] },
    );
    expect(out.layers).toEqual([{ h: 1080 }]);
  });

  it('overwrites scalars and ignores undefined patch values', () => {
    const out = deepMerge({ a: 1, b: 2 }, { a: 5, b: undefined });
    expect(out).toEqual({ a: 5, b: 2 });
  });

  it('does not mutate the inputs', () => {
    const base = { a: { x: 1 } };
    const patch = { a: { y: 2 } };
    deepMerge(base, patch);
    expect(base).toEqual({ a: { x: 1 } });
    expect(patch).toEqual({ a: { y: 2 } });
  });
});

describe('config-presets — credential protection', () => {
  it('stripProtected removes s3/callbacks/name/display_name/room_prefix', () => {
    const clean = stripProtected({
      s3: { bucket: 'x' },
      callbacks: { secret: 'y' },
      name: 'renamed',
      display_name: 'X',
      room_prefix: 'y',
      transcoding: { enabled: true },
    });
    expect(clean).toEqual({ transcoding: { enabled: true } });
  });

  it('applyPresetPatch NEVER overwrites s3 / callbacks even if a patch tries', () => {
    const current = {
      name: 'live',
      s3: { bucket: 'real-bucket', access_key_env: 'APP_LIVE_S3_KEY' },
      callbacks: { url: 'https://hook', secret: 'topsecret' },
      transcoding: { enabled: false },
    };
    const merged = applyPresetPatch(current, {
      s3: { bucket: 'HACKED' },
      callbacks: { secret: 'HACKED' },
      name: 'HACKED',
      transcoding: { enabled: true },
    });
    expect((merged.s3 as any).bucket).toBe('real-bucket');
    expect((merged.callbacks as any).secret).toBe('topsecret');
    expect(merged.name).toBe('live');
    expect((merged.transcoding as any).enabled).toBe(true);
  });
});
