import { execFile } from 'child_process';

/** Probed media metadata. All fields best-effort; null when unknown. */
export interface ProbedMedia {
  width: number | null;
  height: number | null;
  durationS: number | null;
  /** Container/codec hint, e.g. "h264". */
  format: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Probe a local media file with ffprobe. Never throws — returns all-null on any
 * failure (missing binary, unreadable file, etc.).
 */
export async function probeMedia(localPath: string): Promise<ProbedMedia> {
  const empty: ProbedMedia = {
    width: null,
    height: null,
    durationS: null,
    format: null,
  };
  try {
    const out = await run(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        localPath,
      ],
      30000,
    );
    const parsed = JSON.parse(out) as FfprobeOutput;
    const video = (parsed.streams ?? []).find(
      (s) => s.codec_type === 'video',
    );
    const durRaw = video?.duration ?? parsed.format?.duration;
    const dur = durRaw ? Number.parseFloat(durRaw) : NaN;
    return {
      width: video?.width ?? null,
      height: video?.height ?? null,
      durationS: Number.isFinite(dur) ? dur : null,
      format: video?.codec_name ?? parsed.format?.format_name ?? null,
    };
  } catch {
    return empty;
  }
}

/**
 * Extract a single JPEG frame from `localPath` into `outPath` via ffmpeg.
 * Seeks to `atSeconds` (defaults to 1s). Returns true on success, false on any
 * failure (never throws).
 */
export async function extractSnapshot(
  localPath: string,
  outPath: string,
  atSeconds = 1,
): Promise<boolean> {
  try {
    await run(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(Math.max(0, atSeconds)),
        '-i',
        localPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outPath,
      ],
      60000,
    );
    return true;
  } catch {
    return false;
  }
}
