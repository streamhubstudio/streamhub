/**
 * ffmpeg helpers for the VOD post-transcode pipeline (adaptive HLS ladder +
 * WebM/VP8 alternate). The LiveKit egress only produces a single MP4/H.264
 * file, so every extra output is generated HERE, server-side, from that MP4.
 *
 * Shell-out style mirrors media.util.ts: helpers never throw — they return
 * false on any failure (missing binary, bad input, timeout) so the transcode
 * job can degrade gracefully. Pure functions (playlist/ladder math) are
 * exported separately so they stay testable without mocking.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { AppConfig, VodRendition } from '../../shared/contracts';

/** Generous cap for a full-file transcode (long recordings are slow). */
const TRANSCODE_TIMEOUT_MS = 30 * 60_000;

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
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

/** Default H.264 video bitrate (kbps) per rendition height. */
const BITRATE_TABLE: Record<number, number> = {
  2160: 12000,
  1440: 8000,
  1080: 5000,
  720: 2800,
  480: 1400,
  360: 800,
  240: 500,
  144: 250,
};

/** Default video bitrate (kbps) for a height: table hit or a linear fallback. */
export function bitrateForHeight(height: number): number {
  return BITRATE_TABLE[height] ?? Math.max(200, Math.round(height * 3.5));
}

/**
 * Effective VOD rendition ladder for an app: the explicit
 * `transcoding.vod_renditions` when configured, else derived from the
 * `webrtc.layers` heights with default per-height bitrates. Deduped by height,
 * sorted descending, capped at 5 renditions.
 */
export function resolveVodRenditions(cfg: AppConfig): VodRendition[] {
  const configured = cfg.transcoding?.vodRenditions ?? [];
  const source: VodRendition[] = configured.length
    ? configured
    : (cfg.webrtc?.layers ?? []).map((l) => ({
        height: l.height,
        bitrateKbps: bitrateForHeight(l.height),
      }));
  const seen = new Set<number>();
  return source
    .map((r) => ({
      height: Math.floor(Number(r.height)),
      bitrateKbps: Math.floor(Number(r.bitrateKbps)),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.height) &&
        r.height >= 144 &&
        r.height <= 4320 &&
        Number.isFinite(r.bitrateKbps) &&
        r.bitrateKbps > 0,
    )
    .filter((r) => (seen.has(r.height) ? false : (seen.add(r.height), true)))
    .sort((a, b) => b.height - a.height)
    .slice(0, 5);
}

/** Round to the nearest even integer (encoders require even dimensions). */
function even(n: number): number {
  return 2 * Math.round(n / 2);
}

/**
 * Width for a rendition height, preserving the source aspect ratio when known
 * (falls back to 16:9). Always even.
 */
export function widthForHeight(
  height: number,
  sourceWidth?: number | null,
  sourceHeight?: number | null,
): number {
  const aspect =
    sourceWidth && sourceHeight && sourceHeight > 0
      ? sourceWidth / sourceHeight
      : 16 / 9;
  return even(height * aspect);
}

/** One entry of the HLS master playlist. */
export interface MasterPlaylistEntry {
  /** Relative URI of the rendition playlist (e.g. `720p/index.m3u8`). */
  uri: string;
  height: number;
  bitrateKbps: number;
  /** Even pixel width; derived 16:9 from height when omitted. */
  width?: number;
}

/**
 * Build the HLS master playlist referencing every rendition (pure). BANDWIDTH
 * = video bitrate + 128k audio, in bits/s. Entries keep the given order (the
 * caller sorts highest-first).
 */
export function buildMasterPlaylist(entries: MasterPlaylistEntry[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const e of entries) {
    const bandwidth = (e.bitrateKbps + 128) * 1000;
    const width = e.width ?? widthForHeight(e.height);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${e.height},CODECS="avc1.4d401f,mp4a.40.2"`,
      e.uri,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Content-Type for files produced by the HLS transcode. */
export function hlsContentType(file: string): string {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

/**
 * Transcode `sourcePath` into ONE HLS rendition under `outDir`: scaled H.264 +
 * AAC, VOD playlist `index.m3u8` + `seg_NNNN.ts` segments. Returns true on
 * success; never throws.
 */
export async function transcodeHlsRendition(
  sourcePath: string,
  outDir: string,
  rendition: VodRendition,
  segmentSeconds = 4,
): Promise<boolean> {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const kbps = rendition.bitrateKbps;
    await run(
      'ffmpeg',
      [
        '-y',
        '-i',
        sourcePath,
        '-vf',
        `scale=-2:${rendition.height}`,
        '-c:v',
        'libx264',
        '-profile:v',
        'main',
        '-preset',
        'veryfast',
        '-b:v',
        `${kbps}k`,
        '-maxrate',
        `${Math.round(kbps * 1.07)}k`,
        '-bufsize',
        `${kbps * 2}k`,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-hls_time',
        String(segmentSeconds),
        '-hls_playlist_type',
        'vod',
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        path.join(outDir, 'seg_%04d.ts'),
        path.join(outDir, 'index.m3u8'),
      ],
      TRANSCODE_TIMEOUT_MS,
    );
    return fs.existsSync(path.join(outDir, 'index.m3u8'));
  } catch {
    return false;
  }
}

/**
 * Transcode `sourcePath` into a WebM/VP8 (+ Opus audio) file at `outPath`.
 * Returns true on success; never throws.
 */
export async function transcodeWebmVp8(
  sourcePath: string,
  outPath: string,
  bitrateKbps = 2500,
): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await run(
      'ffmpeg',
      [
        '-y',
        '-i',
        sourcePath,
        '-c:v',
        'libvpx',
        '-b:v',
        `${bitrateKbps}k`,
        '-deadline',
        'good',
        '-cpu-used',
        '2',
        '-c:a',
        'libopus',
        '-b:a',
        '128k',
        outPath,
      ],
      TRANSCODE_TIMEOUT_MS,
    );
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
}
