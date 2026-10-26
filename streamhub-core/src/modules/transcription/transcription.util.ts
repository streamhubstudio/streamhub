/**
 * Pure helpers for the VOD transcription pipeline (transcription plugin).
 *
 *  - SRT building: segments → a valid SubRip document (HH:MM:SS,mmm timecodes,
 *    1-based cue numbering, optional `[speaker]` prefixes).
 *  - ffmpeg/ffprobe argument builders (mp3 audio extraction, audio-stream
 *    probe) + thin shell-out wrappers in the media.util.ts style: they never
 *    throw, and the command runner is injectable so unit tests never spawn a
 *    real process.
 *
 * The SAME segment→SRT semantics are mirrored by the Python worker
 * (transcription-worker/transcription_worker/srt.py) so both providers emit
 * identical subtitles; keep the two in sync.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** One transcript segment (times in seconds). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Speaker/participant label, when the source allows attribution. */
  speaker?: string | null;
}

/** A transcribed audio track: its speaker label + its segments. */
export interface TrackTranscript {
  speaker: string | null;
  segments: { start: number; end: number; text: string }[];
}

/** Injectable command runner (bin, args, timeout) → stdout. */
export type CommandRunner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

/** Default runner: child_process.execFile (same shape as media.util.ts). */
export const defaultRunner: CommandRunner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
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

/** Generous cap for extracting the audio of a long recording. */
const EXTRACT_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Minimum cue duration (s) so zero-length segments still render. */
const MIN_CUE_SECONDS = 0.5;

// ---------------------------------------------------------------------------
// SRT building (pure)
// ---------------------------------------------------------------------------

/** Format seconds as an SRT timecode `HH:MM:SS,mmm` (clamped at 0). */
export function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/**
 * Build a SubRip document from segments: cues sorted by start time, 1-based
 * numbering, empty-text segments dropped, `[speaker]` prefix when a segment
 * carries one, and a minimum cue duration so players render instant cues.
 */
export function buildSrt(segments: TranscriptSegment[]): string {
  const ordered = [...segments]
    .filter((seg) => seg.text && seg.text.trim().length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const cues = ordered.map((seg, i) => {
    const text = seg.speaker
      ? `[${seg.speaker}] ${seg.text.trim()}`
      : seg.text.trim();
    const end = Math.max(seg.end, seg.start + MIN_CUE_SECONDS);
    return `${i + 1}\n${formatSrtTimestamp(seg.start)} --> ${formatSrtTimestamp(end)}\n${text}`;
  });
  return cues.length ? `${cues.join('\n\n')}\n` : '';
}

/**
 * Merge per-track transcripts (e.g. one per audio stream / participant) into a
 * single chronological segment list, attaching each track's speaker label.
 */
export function mergeTrackSegments(
  tracks: TrackTranscript[],
): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const track of tracks) {
    for (const seg of track.segments ?? []) {
      merged.push({
        start: Number(seg.start) || 0,
        end: Number(seg.end) || 0,
        text: String(seg.text ?? ''),
        speaker: track.speaker ?? null,
      });
    }
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Plain-text transcript: one line per segment, `[speaker]`-prefixed. */
export function plainTranscriptText(segments: TranscriptSegment[]): string {
  return segments
    .filter((seg) => seg.text && seg.text.trim().length > 0)
    .map((seg) =>
      seg.speaker ? `[${seg.speaker}] ${seg.text.trim()}` : seg.text.trim(),
    )
    .join('\n');
}

/** Distinct non-null speaker labels, in first-appearance order. */
export function collectSpeakers(segments: TranscriptSegment[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.speaker && !out.includes(seg.speaker)) out.push(seg.speaker);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe (arg builders pure; wrappers never throw)
// ---------------------------------------------------------------------------

/**
 * ffmpeg args to extract ONE audio stream of a VOD into a 16 kHz mono MP3 —
 * the shape speech models want, and a small upload for the OpenAI API.
 * `audioStreamIndex` selects the n-th audio stream (multi-track recordings).
 */
export function buildMp3ExtractArgs(
  sourcePath: string,
  outPath: string,
  audioStreamIndex = 0,
): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-map',
    `0:a:${audioStreamIndex}`,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-ac',
    '1',
    '-ar',
    '16000',
    outPath,
  ];
}

/** ffprobe args listing ONLY the audio streams of a source, as JSON. */
export function buildAudioProbeArgs(source: string): string[] {
  return [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    'a',
    source,
  ];
}

/**
 * Number of audio streams in `source` (local path or http(s) URL), or null
 * when the probe failed (missing binary, unreadable source). Never throws.
 */
export async function probeAudioStreamCount(
  source: string,
  run: CommandRunner = defaultRunner,
): Promise<number | null> {
  try {
    const out = await run('ffprobe', buildAudioProbeArgs(source), PROBE_TIMEOUT_MS);
    const parsed = JSON.parse(out) as { streams?: unknown[] };
    return Array.isArray(parsed.streams) ? parsed.streams.length : 0;
  } catch {
    return null;
  }
}

/**
 * Extract one audio stream to `outPath` as MP3. Returns true when the output
 * file exists afterwards; never throws.
 */
export async function extractMp3Track(
  sourcePath: string,
  outPath: string,
  audioStreamIndex = 0,
  run: CommandRunner = defaultRunner,
): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await run(
      'ffmpeg',
      buildMp3ExtractArgs(sourcePath, outPath, audioStreamIndex),
      EXTRACT_TIMEOUT_MS,
    );
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// S3 key convention
// ---------------------------------------------------------------------------

/**
 * S3 object key for a VOD's SRT: NEXT TO the recording — the VOD's fileKey
 * with its container extension swapped for `.srt` (`rec-123.mp4` →
 * `rec-123.srt`). Falls back to `transcripts/vod-<id>.srt` for VODs that
 * never reached S3.
 */
export function srtKeyForVod(fileKey: string | null, vodId: number): string {
  if (fileKey && fileKey.trim()) {
    return fileKey.replace(/\.[^./\\]+$/, '') + '.srt';
  }
  return `transcripts/vod-${vodId}.srt`;
}
