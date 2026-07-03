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
 */

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
