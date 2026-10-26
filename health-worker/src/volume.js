/**
 * ffmpeg volumedetect argument building + stderr parsing — PURE (subprocess
 * in main.js; tests feed recorded stderr fixtures).
 *
 * Silence detection decodes the AUDIO ONLY of one segment (~2-6 s of AAC —
 * milliseconds of CPU) through `-af volumedetect -f null -` and reads the
 * mean_volume line. No video decode ever happens (`-vn`).
 */

/** ffmpeg argv (after the binary) for the audio-only volume scan of a file. */
export function buildVolumeArgs(file) {
  return [
    '-hide_banner',
    '-nostats',
    '-i', file,
    '-vn',
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ];
}

/**
 * Parse volumedetect stderr.
 * @param {string} stderrText
 * @returns {{ meanDb: number, maxDb: number|null } | null}
 *   null when no volumedetect output is present (e.g. the file has no audio
 *   stream — callers treat that as "audio missing", not "silent").
 */
export function parseVolumeDetect(stderrText) {
  const text = String(stderrText ?? '');
  const mean = text.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  if (!mean) return null;
  const meanDb = Number(mean[1]);
  if (!Number.isFinite(meanDb)) return null;
  const max = text.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  const maxDb = max && Number.isFinite(Number(max[1])) ? Number(max[1]) : null;
  return { meanDb, maxDb };
}
