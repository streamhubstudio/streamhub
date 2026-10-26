/**
 * Unit spec — ingress-encoding.util (efficient transcode profile, PRESETS ONLY).
 *
 * Locks the stability rules of 2.8.3:
 *  1. Only LiveKit's built-in `IngressVideoEncodingPreset` values are ever
 *     emitted — never custom `IngressVideoEncodingOptions` layers (custom
 *     options proved version-coupled: server 1.8.4 rejects H264_MAIN).
 *  2. Single layer is the default; only an explicit `adaptive: true` yields the
 *     matching 3-layer preset.
 *  3. Sub-720 caps FOLD UP to the 720p preset (the cap is a quality/bandwidth
 *     knob — measured decode-bound for high-res sources, not a CPU lever).
 *  4. `sanitizeTranscodeMaxHeight` snaps arbitrary yaml values to a tier.
 */
import {
  IngressVideoEncodingPreset,
  TrackSource,
} from '@livekit/protocol';
import {
  DEFAULT_TRANSCODE_MAX_HEIGHT,
  TRANSCODE_HEIGHTS,
  buildIngressVideoOptions,
  sanitizeTranscodeMaxHeight,
} from './ingress-encoding.util';

function presetOf(video: ReturnType<typeof buildIngressVideoOptions>) {
  expect(video.source).toBe(TrackSource.CAMERA);
  // PRESETS ONLY — the whole point: never a custom 'options' encoding.
  expect(video.encodingOptions.case).toBe('preset');
  return video.encodingOptions.value as IngressVideoEncodingPreset;
}

describe('ingress-encoding.util — sanitizeTranscodeMaxHeight', () => {
  it('accepts the four allowed tiers unchanged', () => {
    for (const h of TRANSCODE_HEIGHTS) {
      expect(sanitizeTranscodeMaxHeight(h)).toBe(h);
    }
  });

  it('snaps plausible out-of-set numbers to the nearest tier', () => {
    expect(sanitizeTranscodeMaxHeight(1440)).toBe(1080);
    expect(sanitizeTranscodeMaxHeight(240)).toBe(360);
    expect(sanitizeTranscodeMaxHeight(500)).toBe(480);
  });

  it('resolves garbage / non-positive to the 720p default', () => {
    for (const v of [undefined, null, 'nope', NaN, -5, 0]) {
      expect(sanitizeTranscodeMaxHeight(v)).toBe(DEFAULT_TRANSCODE_MAX_HEIGHT);
    }
  });
});

describe('ingress-encoding.util — buildIngressVideoOptions (presets only)', () => {
  it('defaults to the SINGLE-layer 720p preset (no input)', () => {
    expect(presetOf(buildIngressVideoOptions({}))).toBe(
      IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER,
    );
  });

  it('cap 1080 → single-layer 1080p preset', () => {
    expect(presetOf(buildIngressVideoOptions({ maxHeight: 1080 }))).toBe(
      IngressVideoEncodingPreset.H264_1080P_30FPS_1_LAYER,
    );
  });

  it('sub-720 caps (480/360) FOLD UP to the single-layer 720p preset', () => {
    for (const h of [480, 360]) {
      expect(presetOf(buildIngressVideoOptions({ maxHeight: h }))).toBe(
        IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER,
      );
    }
  });

  it('adaptive:true → the matching 3-LAYER preset (720p default cap)', () => {
    expect(presetOf(buildIngressVideoOptions({ adaptive: true }))).toBe(
      IngressVideoEncodingPreset.H264_720P_30FPS_3_LAYERS,
    );
  });

  it('adaptive:true + cap 1080 → 1080p 3-LAYER preset', () => {
    expect(
      presetOf(buildIngressVideoOptions({ adaptive: true, maxHeight: 1080 })),
    ).toBe(IngressVideoEncodingPreset.H264_1080P_30FPS_3_LAYERS);
  });

  it('adaptive must be an EXPLICIT true — truthy junk keeps single-layer', () => {
    for (const v of [undefined, false, 0, 1, 'true']) {
      expect(
        presetOf(buildIngressVideoOptions({ adaptive: v as never })),
      ).toBe(IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER);
    }
  });
});
