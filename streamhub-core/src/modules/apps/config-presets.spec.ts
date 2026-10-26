/**
 * Unit spec — G4 config presets (pure logic).
 *
 * Locks down the declarative preset catalogue + the credential-safe deep-merge
 * used by AppsService.applyConfigPreset. No DB / filesystem — pure functions.
 */
import {
  CONFIG_PRESETS,
  PRESET_DEFAULT_CONFIG,
  PRESET_PROTECTED_KEYS,
  applyPresetPatch,
  buildDeactivatePatch,
  deepMerge,
  deleteAtPath,
  findPreset,
  isPresetApplied,
  stripProtected,
} from './config-presets';

describe('config-presets — catalogue', () => {
  it('ships the brief presets (+ rtmp-passthrough) with unique ids', () => {
    const names = CONFIG_PRESETS.map((p) => p.name);
    expect(names).toEqual([
      'low-latency',
      'high-quality-recording',
      'mass-audience-HLS',
      'rtmp-passthrough',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('rtmp-passthrough = remux (passthrough on, all transcode/adaptive off)', () => {
    const p = findPreset('rtmp-passthrough')!;
    expect((p.patch.rtmp as any).passthrough).toBe(true);
    expect((p.patch.rtmp as any).transcode).toBe(false);
    expect((p.patch.transcoding as any).enabled).toBe(false);
    expect((p.patch.webrtc as any).adaptive).toBe(false);
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

describe('config-presets — isPresetApplied (G4 fold-2)', () => {
  it('is false against an empty / fresh-ish config', () => {
    for (const p of CONFIG_PRESETS) {
      expect(isPresetApplied({}, p.patch)).toBe(false);
    }
  });

  it('is true right after simulating an apply (deep-merge of the patch)', () => {
    for (const p of CONFIG_PRESETS) {
      const merged = applyPresetPatch({}, p.patch);
      expect(isPresetApplied(merged, p.patch)).toBe(true);
    }
  });

  it('flips false the instant ONE owned leaf drifts', () => {
    const p = findPreset('low-latency')!;
    const merged = applyPresetPatch({}, p.patch) as any;
    expect(isPresetApplied(merged, p.patch)).toBe(true);
    merged.rtmp.transcode = true; // preset set this to false
    expect(isPresetApplied(merged, p.patch)).toBe(false);
  });

  it('ignores drift on keys the preset does NOT own', () => {
    const p = findPreset('low-latency')!;
    const merged = applyPresetPatch({}, p.patch) as any;
    merged.some_unrelated_key = 'whatever';
    merged.recording = { enabled: false }; // low-latency never touches recording
    expect(isPresetApplied(merged, p.patch)).toBe(true);
  });

  it('tells apart two presets that partially overlap (different ladders)', () => {
    const hq = findPreset('high-quality-recording')!;
    const mass = findPreset('mass-audience-HLS')!;
    const hqApplied = applyPresetPatch({}, hq.patch);
    // Both set transcoding.enabled=true + vod_adaptive=true, but the ladders
    // (vod_renditions) and distribution differ — only hq should read applied.
    expect(isPresetApplied(hqApplied, hq.patch)).toBe(true);
    expect(isPresetApplied(hqApplied, mass.patch)).toBe(false);
  });

  it('array leaves are order-sensitive (a re-ordered ladder is NOT the same preset)', () => {
    const p = findPreset('high-quality-recording')!;
    const merged = applyPresetPatch({}, p.patch) as any;
    expect(isPresetApplied(merged, p.patch)).toBe(true);
    merged.transcoding.vod_renditions = [...merged.transcoding.vod_renditions].reverse();
    expect(isPresetApplied(merged, p.patch)).toBe(false);
  });
});

describe('config-presets — PRESET_DEFAULT_CONFIG', () => {
  it('covers every top-level key any built-in preset patch sets, OR is a documented forward-looking key', () => {
    const knownForwardLooking = new Set(['distribution', 'hls']);
    for (const p of CONFIG_PRESETS) {
      for (const key of Object.keys(p.patch)) {
        const covered = key in PRESET_DEFAULT_CONFIG || knownForwardLooking.has(key);
        expect(covered).toBe(true);
      }
    }
  });
});

describe('config-presets — buildDeactivatePatch (G4 fold-2)', () => {
  it('low-latency: reverts owned leaves to factory defaults, unsets distribution/hls', () => {
    const p = findPreset('low-latency')!;
    const { patch, unset } = buildDeactivatePatch(p.patch, PRESET_DEFAULT_CONFIG);
    expect((patch.rtmp as any).transcode).toBe(true); // factory default
    expect((patch.webrtc as any).adaptive).toBe(true); // factory default (same as preset here)
    expect((patch.transcoding as any).enabled).toBe(false); // factory default
    expect((patch.features as any).adaptive_player).toBe(true);
    expect(patch).not.toHaveProperty('distribution');
    expect(patch).not.toHaveProperty('hls');
    expect(unset).toContainEqual(['distribution', 'mode']);
    expect(unset).toContainEqual(['hls', 'segment_seconds']);
    expect(unset).toContainEqual(['hls', 'list_size']);
  });

  it('never mutates its inputs', () => {
    const p = findPreset('mass-audience-HLS')!;
    const patchBefore = JSON.parse(JSON.stringify(p.patch));
    const defaultsBefore = JSON.parse(JSON.stringify(PRESET_DEFAULT_CONFIG));
    buildDeactivatePatch(p.patch, PRESET_DEFAULT_CONFIG);
    expect(p.patch).toEqual(patchBefore);
    expect(PRESET_DEFAULT_CONFIG).toEqual(defaultsBefore);
  });

  it('deactivating an applied preset yields exactly the factory defaults (known leaves) and removes the forward-looking ones (unset leaves)', () => {
    function getAt(obj: any, path: string[]): unknown {
      return path.reduce((cur, key) => cur?.[key], obj);
    }
    for (const p of CONFIG_PRESETS) {
      const applied = applyPresetPatch({}, p.patch);
      expect(isPresetApplied(applied, p.patch)).toBe(true);

      const { patch: revert, unset } = buildDeactivatePatch(p.patch, PRESET_DEFAULT_CONFIG);
      const reverted = applyPresetPatch(applied, revert);
      for (const path of unset) deleteAtPath(reverted, path);

      // Every leaf with a known factory default now matches that default.
      const unsetKeys = new Set(unset.map((path) => path.join('.')));
      function checkLeaves(patchNode: Record<string, unknown>, prefix: string[]): void {
        for (const [key, val] of Object.entries(patchNode)) {
          const path = [...prefix, key];
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            checkLeaves(val as Record<string, unknown>, path);
            continue;
          }
          if (unsetKeys.has(path.join('.'))) continue;
          expect(getAt(reverted, path)).toEqual(getAt(PRESET_DEFAULT_CONFIG, path));
        }
      }
      checkLeaves(p.patch, []);

      // Every forward-looking (unset) leaf is gone entirely.
      for (const path of unset) {
        expect(getAt(reverted, path)).toBeUndefined();
      }
    }
  });
});

describe('config-presets — deleteAtPath', () => {
  it('deletes a leaf and prunes the parent object once it is empty', () => {
    const obj: Record<string, unknown> = { distribution: { mode: 'edge' }, keep: 1 };
    deleteAtPath(obj, ['distribution', 'mode']);
    expect(obj).toEqual({ keep: 1 }); // distribution itself pruned (now empty)
  });

  it('does NOT prune a parent that still has other keys', () => {
    const obj: Record<string, unknown> = {
      hls: { segment_seconds: 4, list_size: 10 },
    };
    deleteAtPath(obj, ['hls', 'segment_seconds']);
    expect(obj).toEqual({ hls: { list_size: 10 } });
    deleteAtPath(obj, ['hls', 'list_size']);
    expect(obj).toEqual({}); // now empty → pruned
  });

  it('is a no-op when the path does not resolve', () => {
    const obj: Record<string, unknown> = { a: 1 };
    deleteAtPath(obj, ['nope', 'deeper']);
    expect(obj).toEqual({ a: 1 });
  });

  it('order-independent: deleting nested cdn.* leaves in any order still fully prunes', () => {
    const a: Record<string, unknown> = {
      distribution: { mode: 'cdn', cdn: { base_url: '', vod_base_url: '', provider: 'bunny' } },
    };
    deleteAtPath(a, ['distribution', 'cdn', 'base_url']);
    deleteAtPath(a, ['distribution', 'mode']);
    deleteAtPath(a, ['distribution', 'cdn', 'vod_base_url']);
    deleteAtPath(a, ['distribution', 'cdn', 'provider']);
    expect(a).toEqual({});
  });
});
