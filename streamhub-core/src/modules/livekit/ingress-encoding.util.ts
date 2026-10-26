/**
 * Pure builder for the LiveKit RTMP/URL ingress VIDEO encoding
 * (`IngressVideoOptions`) — the "efficient transcode profile".
 *
 * WHY: LiveKit's default for a transcoded RTMP/URL input is a 3-layer 720p
 * H.264 SIMULCAST — three real-time x264 encodes per stream, which pins an
 * 8-core box at ~100% under 3 concurrent streams (measured on prod). Making the
 * ingress SINGLE-layer takes the same 3×1080p load to ~24%. LiveKit does NOT
 * expose the x264 speed-preset, but it ships battle-tested encoding PRESETS.
 *
 * PRESETS ONLY (stability rule, 2.8.3): we exclusively use LiveKit's built-in
 * `IngressVideoEncodingPreset` values — never hand-rolled
 * `IngressVideoEncodingOptions` layers. Custom options proved version-coupled
 * (server 1.8.4 rejects `H264_MAIN` with "video codec unsupported"; the 2.8.1
 * custom-layer path shipped broken because unit tests mock the ingress client).
 * Presets are the API surface LiveKit itself validates, so they are as stable
 * as the transcode itself. Consequences:
 *  - single-layer: 1080 → H264_1080P_30FPS_1_LAYER, everything else (720/480/
 *    360) → H264_720P_30FPS_1_LAYER (sub-720 caps FOLD UP to the 720p preset —
 *    measured: with a 1080p source the decode dominates, so a lower output cap
 *    barely moves CPU anyway; the cap is a quality/bandwidth knob, not a CPU one).
 *  - adaptive (app opt-in): the matching 3-layer preset (720p/1080p), i.e. the
 *    ladder LiveKit itself defaults to — but chosen EXPLICITLY and capped by
 *    the app config instead of leaking in by accident.
 *
 * The global rollback switch lives OUTSIDE this builder: with
 * `STREAMHUB_INGEST_PROFILE=livekit` the service never calls it (LiveKit
 * decides everything, pre-2.7.1 behaviour).
 *
 * CLUSTER: pure per-app config consumed at ingress-create time on whichever
 * node owns the room — no shared/central state, so it scales per node.
 */
import {
  IngressVideoEncodingPreset,
  IngressVideoOptions,
  TrackSource,
} from '@livekit/protocol';

/** Allowed transcode resolution caps (px height), ascending. */
export const TRANSCODE_HEIGHTS = [360, 480, 720, 1080] as const;
export type TranscodeHeight = (typeof TRANSCODE_HEIGHTS)[number];

/**
 * Default resolution cap when unset/invalid: 720p. A sane, AntMedia-style
 * default (single 720p transcode).
 */
export const DEFAULT_TRANSCODE_MAX_HEIGHT: TranscodeHeight = 720;

/**
 * Sanitize a raw `transcode_max_height` (config.yaml / API) to one of the four
 * allowed tiers. Garbage / non-positive ⇒ the 720p default; an out-of-set but
 * plausible number snaps to the NEAREST tier (e.g. 1440→1080, 240→360). The DTO
 * layer additionally REJECTS out-of-set values at the API boundary; this is the
 * defensive resolve for hand-edited yaml.
 */
export function sanitizeTranscodeMaxHeight(v: unknown): TranscodeHeight {
  const n = Math.floor(Number(v));
  if ((TRANSCODE_HEIGHTS as readonly number[]).includes(n)) {
    return n as TranscodeHeight;
  }
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TRANSCODE_MAX_HEIGHT;
  return TRANSCODE_HEIGHTS.reduce<TranscodeHeight>(
    (best, h) => (Math.abs(h - n) < Math.abs(best - n) ? h : best),
    DEFAULT_TRANSCODE_MAX_HEIGHT,
  );
}

/** Inputs for {@link buildIngressVideoOptions}. */
export interface IngressEncodingInput {
  /** Resolution cap (px height). Sanitized to a tier; default 720p. */
  maxHeight?: number;
  /**
   * Adaptive ladder? Only an EXPLICIT `true` produces the (capped) 3-layer
   * preset — any other value keeps the safe single-layer default.
   */
  adaptive?: boolean;
}

/**
 * Build the `IngressVideoOptions` for a TRANSCODED ingress — presets only:
 *
 *  - single layer (default): `H264_1080P_30FPS_1_LAYER` when the cap is 1080,
 *    else `H264_720P_30FPS_1_LAYER` (sub-720 caps fold up to 720).
 *  - adaptive (explicit opt-in): the matching `*_3_LAYERS` preset.
 */
export function buildIngressVideoOptions(
  input: IngressEncodingInput,
): IngressVideoOptions {
  const maxHeight = sanitizeTranscodeMaxHeight(input.maxHeight);
  const tier: 720 | 1080 = maxHeight === 1080 ? 1080 : 720;
  const adaptive = input.adaptive === true;

  const preset = adaptive
    ? tier === 1080
      ? IngressVideoEncodingPreset.H264_1080P_30FPS_3_LAYERS
      : IngressVideoEncodingPreset.H264_720P_30FPS_3_LAYERS
    : tier === 1080
      ? IngressVideoEncodingPreset.H264_1080P_30FPS_1_LAYER
      : IngressVideoEncodingPreset.H264_720P_30FPS_1_LAYER;

  return new IngressVideoOptions({
    source: TrackSource.CAMERA,
    encodingOptions: { case: 'preset', value: preset },
  });
}
