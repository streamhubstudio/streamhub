/**
 * ffprobe argument building + output parsing — PURE (the subprocess itself is
 * spawned by main.js; tests feed recorded fixture JSON, never real ffmpeg).
 *
 * One ffprobe per new segment gives the stream FACTS (codecs / resolution /
 * fps / bitrates) and the per-track start_time values whose difference is the
 * A/V desync signal: within one segment, audio and video should start within
 * a frame or two of each other; a large |video.start - audio.start| is
 * muxed-in PTS drift.
 */

/** ffprobe argv (after the binary) for one media file. */
export function buildFfprobeArgs(file) {
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ];
}

/** Parse "30000/1001" | "25/1" | "25" into fps (1 decimal), else null. */
export function parseFps(rate) {
  const s = String(rate ?? '').trim();
  if (!s || s === '0/0') return null;
  const [num, den] = s.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
  return Math.round((n / d) * 10) / 10;
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function kbps(bitRate) {
  const n = num(bitRate);
  return n === null ? null : Math.round(n / 1000);
}

/**
 * Parse ffprobe -print_format json output.
 * @param {string} jsonText
 * @returns {{
 *   video: { codec: string, width: number|null, height: number|null,
 *            fps: number|null, bitrateKbps: number|null,
 *            startTime: number|null } | null,
 *   audio: { codec: string, sampleRate: number|null, channels: number|null,
 *            bitrateKbps: number|null, startTime: number|null } | null,
 *   durationSec: number|null,
 *   overallBitrateKbps: number|null,
 *   desyncMs: number|null,   // |video.start - audio.start| in ms (needs both)
 * } | null} null on unparseable input.
 */
export function parseFfprobe(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText ?? ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];

  const v = streams.find((s) => s && s.codec_type === 'video');
  const a = streams.find((s) => s && s.codec_type === 'audio');

  const video = v
    ? {
        codec: String(v.codec_name ?? ''),
        width: num(v.width),
        height: num(v.height),
        fps: parseFps(v.avg_frame_rate) ?? parseFps(v.r_frame_rate),
        bitrateKbps: kbps(v.bit_rate),
        startTime: num(v.start_time),
      }
    : null;
  const audio = a
    ? {
        codec: String(a.codec_name ?? ''),
        sampleRate: num(a.sample_rate),
        channels: num(a.channels),
        bitrateKbps: kbps(a.bit_rate),
        startTime: num(a.start_time),
      }
    : null;

  let desyncMs = null;
  if (video?.startTime !== null && video !== null && audio?.startTime !== null && audio !== null) {
    desyncMs = Math.round(Math.abs(video.startTime - audio.startTime) * 1000);
  }

  const fmt = parsed.format && typeof parsed.format === 'object' ? parsed.format : {};
  return {
    video,
    audio,
    durationSec: num(fmt.duration),
    overallBitrateKbps: kbps(fmt.bit_rate),
    desyncMs,
  };
}
