/**
 * G4 config presets — declarative per-app `config.yaml` presets.
 *
 * A preset is a *partial* config deep-merged over the app's current config.yaml
 * and then hot-reloaded (see AppsService.applyConfigPreset). Presets encode the
 * three delivery profiles from the brief:
 *
 *   - `low-latency`             — WebRTC-first, passthrough (no re-encode).
 *   - `high-quality-recording`  — transcoding ON + adaptive HLS VOD ladder.
 *   - `mass-audience-HLS`       — HLS ladder + `distribution.mode: cdn`.
 *
 * SAFETY: presets ONLY touch non-sensitive delivery/quality blocks. They NEVER
 * overwrite credentials or identity — `s3`, `callbacks`, `name`, `display_name`
 * and `room_prefix` are stripped from every patch before the merge
 * (`PRESET_PROTECTED_KEYS`), so S3 keys / secret refs / webhook secrets survive
 * untouched.
 *
 * The `distribution:` and `hls:` blocks are the forward-looking config surface
 * from DISTRIBUTION-CDN-P2P.md (§6) + the settings matrix (B1): they are written
 * to (and round-trip through) the raw YAML so a CDN/edge setup can read them, and
 * are consumed as those features land. The keys that take effect *today*
 * (transcoding, webrtc, rtmp, features, recording) are all real, resolved config.
 *
 * G4 fold-2 — toggle with a negative: a preset can also be DEACTIVATED
 * (`AppsService.deactivateConfigPreset`). Two pure helpers make that honest:
 *
 *   - `isPresetApplied(current, patch)` — a preset reads as "applied" iff
 *     EVERY leaf key its patch sets is still present, at the same value, in
 *     the app's current (parsed) config. It says nothing about keys the
 *     preset doesn't own, so unrelated config drift never flips it false.
 *   - `buildDeactivatePatch(patch, defaults)` — the inverse patch: every leaf
 *     the preset sets is reverted to the app's FACTORY default for that exact
 *     path (`PRESET_DEFAULT_CONFIG`); leaves with no factory default (the
 *     forward-looking `distribution`/`hls` blocks, absent on a fresh app) come
 *     back as `unset` paths for the caller to delete outright post-merge.
 *
 * HONESTY NOTE: the backend does not track the PRE-APPLY value of each key —
 * only a generic, timestamped `config.yaml.bak.<ts>` backup taken on every
 * write (not attributed to a specific preset apply). So "deactivate" restores
 * FACTORY DEFAULTS, not necessarily whatever a key held a moment before the
 * preset was applied (e.g.: apply `low-latency`, hand-edit `rtmp.transcode`,
 * then deactivate → you get the factory default, not your hand-edited value).
 * An operator who needs the literal pre-apply state can still use the config
 * backup taken at apply time (Config tab → Backups). This is a deliberate,
 * documented simplification — see the CONFIG-UX brief (item 12).
 */

import { DEFAULT_TRANSCODE_MAX_HEIGHT } from '../livekit/ingress-encoding.util';

/** A rendition of an adaptive ladder, on-disk snake_case shape. */
interface DiskRendition {
  height: number;
  bitrate_kbps: number;
}

export interface ConfigPreset {
  /** URL-safe id used in `POST /apps/:app/presets/:name/apply`. */
  name: string;
  /** Short human title. */
  title: string;
  /** One-line description of the profile. */
  description: string;
  /** The vertical / use case this targets. */
  useCase: string;
  /** Human summary of exactly what the preset sets (drives the UI + docs). */
  sets: string[];
  /** Declarative partial config, deep-merged over the current config.yaml. */
  patch: Record<string, unknown>;
}

/**
 * Config keys a preset must NEVER overwrite — credentials (`s3`, `callbacks`)
 * and identity/branding (`name`, `display_name`, `room_prefix`). Stripped from
 * the patch defensively before merging, even though no built-in preset sets them.
 */
export const PRESET_PROTECTED_KEYS: readonly string[] = [
  's3',
  'callbacks',
  'name',
  'display_name',
  'room_prefix',
];

const LADDER_1080: DiskRendition[] = [
  { height: 1080, bitrate_kbps: 5000 },
  { height: 720, bitrate_kbps: 2800 },
  { height: 480, bitrate_kbps: 1400 },
];

const LADDER_HLS: DiskRendition[] = [
  { height: 720, bitrate_kbps: 2800 },
  { height: 480, bitrate_kbps: 1400 },
  { height: 360, bitrate_kbps: 800 },
];

export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    name: 'low-latency',
    title: 'Baja latencia (WebRTC-first)',
    description:
      'Reproducción interactiva sub-segundo: passthrough puro (sin re-encode), ' +
      'simulcast ON, distribución por edges. Ideal CCTV, subastas, 1:1. El ' +
      'playout delay bajo se aplica desde el SDK/player, no desde el yaml ' +
      '(ver LATENCY-TUNING L3).',
    useCase: 'CCTV, monitoreo, subastas, telemedicina/soporte, live-shopping interactivo',
    sets: [
      'transcoding.enabled = false (passthrough puro, sin re-encode en el server)',
      'webrtc.adaptive = true (simulcast ON — es MEJOR para latencia, LATENCY-TUNING)',
      'rtmp.transcode = false (ingress passthrough)',
      'features.adaptive_player = true',
      'distribution.mode = edge (WebRTC-first, sin indirección de CDN)',
      'hls: segmentos cortos (2s / list 3) por si se usa HLS puntual',
    ],
    patch: {
      transcoding: { enabled: false },
      webrtc: { adaptive: true },
      rtmp: { transcode: false },
      features: { adaptive_player: true },
      distribution: { mode: 'edge' },
      hls: { segment_seconds: 2, list_size: 3 },
    },
  },
  {
    name: 'high-quality-recording',
    title: 'Grabación de alta calidad',
    description:
      'Transcoding ON con ladder, grabación H.264 (opcional h264+vp8) y VOD ' +
      'adaptativo (HLS master + renditions). Prioriza calidad y compatibilidad ' +
      'del archivo sobre latencia.',
    useCase: 'Eventos grabados, clases, VOD premium, archivo/QC',
    sets: [
      'transcoding.enabled = true (re-encode server-side)',
      'transcoding.encoding = h264 (cambiar a h264+vp8 para alternativa WebM/VP8)',
      'transcoding.vod_adaptive = true (HLS VOD adaptativo por grabación)',
      'transcoding.vod_renditions = 1080/720/480 (ladder explícito)',
      'recording.enabled = true, mode = room-composite',
      'rtmp.transcode = true, webrtc.adaptive = true (+ layers 1080/720/480)',
    ],
    patch: {
      transcoding: {
        enabled: true,
        encoding: 'h264',
        vod_adaptive: true,
        vod_renditions: LADDER_1080,
      },
      recording: { enabled: true, mode: 'room-composite' },
      rtmp: { transcode: true },
      webrtc: {
        adaptive: true,
        layers: [
          { name: 'high', height: 1080 },
          { name: 'med', height: 720 },
          { name: 'low', height: 480 },
        ],
      },
      features: { adaptive_player: true },
    },
  },
  {
    name: 'mass-audience-HLS',
    title: 'Audiencia masiva (HLS + CDN)',
    description:
      'HLS con segmentos/list optimizados detrás de un CDN (distribution.mode ' +
      'cdn) + ladder transcodificado, para miles/cientos de miles de ' +
      'espectadores. Latencia 6–15s a cambio de escala barata y cacheable ' +
      '(ver DISTRIBUTION-CDN-P2P).',
    useCase: 'Eventos masivos, streams públicos, radio/audio 24/7, webinars grandes',
    sets: [
      'transcoding.enabled = true + vod_adaptive = true (ladder 720/480/360)',
      'webrtc.adaptive = true, features.adaptive_player = true',
      'recording.enabled = true',
      'distribution.mode = cdn (+ cdn.base_url a completar con el dominio del CDN)',
      'hls: segment_seconds = 4, list_size = 10 (ventana optimizada del m3u8)',
    ],
    patch: {
      transcoding: {
        enabled: true,
        encoding: 'h264',
        vod_adaptive: true,
        vod_renditions: LADDER_HLS,
      },
      webrtc: { adaptive: true },
      features: { adaptive_player: true },
      recording: { enabled: true },
      distribution: {
        mode: 'cdn',
        cdn: { base_url: '', vod_base_url: '', provider: 'bunny' },
      },
      hls: { segment_seconds: 4, list_size: 10 },
    },
  },
  {
    name: 'rtmp-passthrough',
    title: 'RTMP passthrough (remux, sin transcode)',
    description:
      'Ingesta RTMP H.264/AAC servida como HLS por REMUX puro (`ffmpeg -c copy`), ' +
      'sin pasar por LiveKit: CPU casi nula, sin GPU (estilo AntMedia). MUTUAMENTE ' +
      'EXCLUYENTE con transcoding/adaptive — este preset apaga todo re-encode. La ' +
      'fuente DEBE ser H.264/AAC (sin red de seguridad de transcode) y no hay ' +
      'WebRTC/sub-segundo, ABR, grabación ni features de sala. Requiere ' +
      'STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on en el server.',
    useCase: 'Relay RTMP→HLS barato y masivo, cámaras/encoders H.264/AAC ya conformes',
    sets: [
      'rtmp.passthrough = true (remux directo a HLS, sin re-encode)',
      'rtmp.transcode = false, transcoding.enabled = false (sin transcode)',
      'webrtc.adaptive = false, features.adaptive_player = false (sin ABR/WebRTC)',
      'recording.enabled = false (sin egress/VOD para passthrough)',
    ],
    patch: {
      rtmp: { passthrough: true, transcode: false },
      transcoding: { enabled: false, vod_adaptive: false },
      webrtc: { adaptive: false },
      recording: { enabled: false },
      features: { adaptive_player: false },
    },
  },
];

/** Look up a preset by its id. */
export function findPreset(name: string): ConfigPreset | undefined {
  return CONFIG_PRESETS.find((p) => p.name === name);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `patch` into `base`, returning a NEW object (inputs untouched):
 *  - nested plain objects merge recursively,
 *  - arrays and scalars REPLACE wholesale (so a preset's `webrtc.layers` /
 *    `vod_renditions` swap the ladder rather than concatenating),
 *  - `undefined` patch values are ignored.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    const cur = out[key];
    if (isPlainObject(val) && isPlainObject(cur)) {
      out[key] = deepMerge(cur, val);
    } else if (isPlainObject(val)) {
      out[key] = deepMerge({}, val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Remove protected (credential/identity) keys from a patch. */
export function stripProtected(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(patch)) {
    if (PRESET_PROTECTED_KEYS.includes(key)) continue;
    clean[key] = val;
  }
  return clean;
}

/**
 * Apply a preset patch onto a parsed config object, protecting credentials +
 * identity. Pure — returns a new merged object; never mutates `current`.
 */
export function applyPresetPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return deepMerge(current, stripProtected(patch));
}

// ---------------------------------------------------------------------------
// G4 fold-2 — preset toggle with a negative (apply ⇄ deactivate)
// ---------------------------------------------------------------------------

/**
 * Factory defaults for the config blocks a built-in preset can touch —
 * `recording`, `webrtc`, `rtmp`, `transcoding`, `features` — mirroring
 * `AppsService.defaultDiskConfig()` for exactly those blocks (name/room-prefix/
 * s3/mqtt/callbacks/latency_alert are app-identity/credential fields no preset
 * ever sets, so they're intentionally not duplicated here). KEEP IN SYNC with
 * `defaultDiskConfig()` — `apps.presets.spec.ts` cross-checks a fresh app's
 * resolved config against this object so drift fails the test suite.
 *
 * `distribution` and `hls` are deliberately ABSENT: they're the forward-
 * looking config surface (DISTRIBUTION-CDN-P2P §6) with no factory default —
 * a fresh app simply doesn't have them. `buildDeactivatePatch` treats any
 * preset-patch key missing here as "no default" and unsets it instead.
 */
export const PRESET_DEFAULT_CONFIG: Record<string, unknown> = {
  recording: {
    enabled: true,
    mode: 'room-composite',
    layout: 'grid',
    local_dir: 'recordings',
    delete_local_after_upload: true,
    split_minutes: 0,
    snapshot_seconds: 0,
  },
  webrtc: {
    adaptive: true,
    layers: [
      { name: 'high', height: 720 },
      { name: 'med', height: 480 },
      { name: 'low', height: 240 },
    ],
    transcode_max_height: DEFAULT_TRANSCODE_MAX_HEIGHT,
  },
  rtmp: { enabled: true, transcode: true, passthrough: false },
  transcoding: {
    enabled: false,
    encoding: 'h264',
    vod_adaptive: false,
    vod_renditions: [],
  },
  features: {
    rtmp_password: false,
    viewer_counter: true,
    chat: false,
    reactions: false,
    hidden_qc: true,
    adaptive_player: true,
    public_playback: true,
    linear: {
      persistent_room: false,
      room_empty_timeout_seconds: 86400,
      always_on_hls: false,
      dvr: false,
      dvr_window_seconds: 3600,
    },
  },
};

/** Read the value at `path` in a nested plain-object tree. `found` is false if
 * any segment along the way is missing or not a plain object. */
function getAtPath(
  obj: Record<string, unknown> | undefined,
  path: string[],
): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isPlainObject(cur) || !(key in cur)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

/** Deep structural equality for plain objects / arrays / scalars. Arrays are
 * order-sensitive (a re-ordered ladder is a DIFFERENT config, not the same
 * preset) — consistent with `deepMerge` treating arrays as a replace-wholesale
 * leaf, not something to merge element-by-element. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Walk every LEAF of `patch` — a leaf is any value that isn't itself a plain
 * object (scalars, null, and arrays: arrays replace wholesale like
 * `deepMerge`, so they're a leaf too, not something to recurse into) — and
 * invoke `visit(path, value)` for each one. */
function walkLeaves(
  patch: Record<string, unknown>,
  visit: (path: string[], value: unknown) => void,
  prefix: string[] = [],
): void {
  for (const [key, val] of Object.entries(patch)) {
    const path = [...prefix, key];
    if (isPlainObject(val)) walkLeaves(val, visit, path);
    else visit(path, val);
  }
}

/**
 * Detect whether a preset is currently APPLIED to a parsed config: true iff
 * every leaf key the preset's patch sets is still present, at the same path,
 * with the exact same value, in `current`. Says nothing about keys the preset
 * doesn't own — a config that has since drifted on an unrelated field is
 * still "applied" for this preset's purposes. Pure.
 */
export function isPresetApplied(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  let applied = true;
  walkLeaves(patch, (path, expected) => {
    if (!applied) return;
    const { found, value } = getAtPath(current, path);
    if (!found || !deepEqual(value, expected)) applied = false;
  });
  return applied;
}

/**
 * Build the "deactivate" patch for a preset: for every leaf the preset's
 * patch sets, look up the same path in `defaults` (`PRESET_DEFAULT_CONFIG`).
 * Leaves with a known factory default are mirrored into the returned `patch`
 * (deep-merge it over the current config exactly like an apply); leaves with
 * NO default (the forward-looking `distribution`/`hls` blocks) are returned
 * as `unset` paths for the caller to delete outright — `deepMerge` only ever
 * ADDS, so "revert to absence" needs an explicit delete (`deleteAtPath`).
 * Pure — never mutates its inputs.
 */
export function buildDeactivatePatch(
  patch: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { patch: Record<string, unknown>; unset: string[][] } {
  const out: Record<string, unknown> = {};
  const unset: string[][] = [];
  walkLeaves(patch, (path) => {
    const { found, value } = getAtPath(defaults, path);
    if (!found) {
      unset.push(path);
      return;
    }
    let cur = out;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!isPlainObject(cur[key])) cur[key] = {};
      cur = cur[key] as Record<string, unknown>;
    }
    cur[path[path.length - 1]] = value;
  });
  return { patch: out, unset };
}

/**
 * Delete the leaf at `path` from a nested plain-object tree (MUTATES `obj` in
 * place), then prune any ancestor object left empty by the deletion — so
 * unsetting every leaf of a forward-looking block (e.g. all of `distribution`)
 * drops the block entirely rather than leaving `distribution: {}` behind.
 * Order-independent: safe to call once per `unset` path in any order.
 */
export function deleteAtPath(obj: Record<string, unknown>, path: string[]): void {
  if (path.length === 0) return;
  const stack: Record<string, unknown>[] = [obj];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (!isPlainObject(next)) return; // nothing to delete
    cur = next;
    stack.push(cur);
  }
  delete cur[path[path.length - 1]];
  for (let i = stack.length - 1; i >= 1; i--) {
    if (Object.keys(stack[i]).length > 0) break;
    delete stack[i - 1][path[i - 1]];
  }
}
