/**
 * shaka-packager plumbing for the DRM VOD pipeline.
 *
 * ffmpeg cannot produce CENC/CBCS common-encryption fMP4 — that is
 * shaka-packager territory. This util keeps the three concerns separate:
 *  - `isShakaPackagerAvailable()` — cached binary probe (`packager --version`,
 *    override via `SHAKA_PACKAGER_BIN`); the whole DRM path is a no-op when
 *    the binary is absent.
 *  - `buildRawKeyArgs()` / `buildShakaHlsArgs()` — PURE argv builders
 *    (testable without spawning anything).
 *  - `packageDrmHls()` — the shell-out. Mirrors vod-transcode.util style:
 *    never throws, returns false on any failure.
 *
 * SECURITY NOTE: raw-key mode passes `key=<hex>` on the packager argv, which
 * is visible in the container's process list while packaging runs. That is an
 * accepted trade-off of shaka's raw-key CLI; a production deployment can use
 * the provider-integrated modes (e.g. Widevine key-server signing) instead.
 * The args are never logged.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { DrmScheme } from '../../../shared/contracts';
import type { DrmContentKeys } from './drm-provider';

/** Same generous cap as the ffmpeg transcodes (long recordings are slow). */
const PACKAGE_TIMEOUT_MS = 30 * 60_000;
/** Probe cap — `--version` should return instantly. */
const PROBE_TIMEOUT_MS = 10_000;

/** Default shaka-packager binary name (must be on PATH). */
export const DEFAULT_PACKAGER_BIN = 'packager';

/** Resolved packager binary: `SHAKA_PACKAGER_BIN` env override or `packager`. */
export function shakaPackagerBin(): string {
  return (process.env.SHAKA_PACKAGER_BIN || '').trim() || DEFAULT_PACKAGER_BIN;
}

const availabilityCache = new Map<string, boolean>();

/** Test seam: forget cached probe results. */
export function resetShakaAvailabilityCache(): void {
  availabilityCache.clear();
}

/**
 * Whether the shaka-packager binary is runnable (probe result cached per
 * binary path for the process lifetime). Never throws.
 */
export async function isShakaPackagerAvailable(
  bin: string = shakaPackagerBin(),
): Promise<boolean> {
  const cached = availabilityCache.get(bin);
  if (cached !== undefined) return cached;
  const ok = await new Promise<boolean>((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (err) =>
        resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
  availabilityCache.set(bin, ok);
  return ok;
}

/**
 * Raw-key encryption argv (pure). The first key is the default key (empty
 * `label=` applies to every stream); extra keys get `label=key<i>` so a later
 * per-track `drm_label=` mapping can address them. `--clear_lead 0` because
 * shaka's default leaves the first 5s UNencrypted.
 */
export function buildRawKeyArgs(
  keys: DrmContentKeys,
  scheme: DrmScheme,
): string[] {
  const specs = keys.keys.map((k, i) => {
    const label = i === 0 ? '' : `key${i}`;
    const iv = k.iv ? `:iv=${k.iv}` : '';
    return `label=${label}:key_id=${k.keyId}:key=${k.key}${iv}`;
  });
  const args = [
    '--enable_raw_key_encryption',
    '--protection_scheme',
    scheme,
    '--clear_lead',
    '0',
    '--keys',
    specs.join(','),
  ];
  const psshHex = (keys.pssh ?? [])
    .map((p) => Buffer.from(p.boxBase64, 'base64').toString('hex'))
    .join('');
  if (psshHex) args.push('--pssh', psshHex);
  if (keys.hlsKeyUri) args.push('--hls_key_uri', keys.hlsKeyUri);
  return args;
}

/** One video rendition input for the packaging job (mezzanine MP4). */
export interface ShakaRenditionInput {
  height: number;
  mp4Path: string;
}

/** A full encrypt-and-package job over one asset's rendition mezzanines. */
export interface ShakaHlsJob {
  /** Per-height H.264 mezzanine MP4s (ffmpeg output). */
  renditions: ShakaRenditionInput[];
  /** MP4 whose audio track feeds the shared HLS audio group (the source). */
  audioSourcePath: string;
  /** Output dir — flat: master.m3u8, <h>p.m3u8/.mp4, audio.m3u8/.mp4. */
  outDir: string;
  /** HLS segment duration in seconds (default 4, matches the clear ladder). */
  segmentSeconds?: number;
  /** Encryption argv from `DrmProvider.packagingArgs()`. */
  keyArgs: string[];
  /** Binary override (default `shakaPackagerBin()`). */
  bin?: string;
}

/**
 * Full shaka-packager argv for a CMAF HLS packaging job (pure): one
 * single-file fMP4 output + media playlist per video rendition, one shared
 * audio group, one master playlist, plus the encryption args.
 */
export function buildShakaHlsArgs(job: ShakaHlsJob): string[] {
  const streams = job.renditions.map(
    (r) =>
      `in=${r.mp4Path},stream=video,output=${path.join(
        job.outDir,
        `${r.height}p.mp4`,
      )},playlist_name=${r.height}p.m3u8`,
  );
  streams.push(
    `in=${job.audioSourcePath},stream=audio,output=${path.join(
      job.outDir,
      'audio.mp4',
    )},playlist_name=audio.m3u8,hls_group_id=audio,hls_name=default`,
  );
  return [
    ...streams,
    '--segment_duration',
    String(job.segmentSeconds ?? 4),
    '--hls_master_playlist_output',
    path.join(job.outDir, 'master.m3u8'),
    ...job.keyArgs,
  ];
}

/**
 * Run the packaging job. Returns true when the encrypted master playlist
 * exists afterwards; false on ANY failure (missing binary, bad input,
 * timeout). Never throws, never logs the argv (it contains key material).
 */
export async function packageDrmHls(job: ShakaHlsJob): Promise<boolean> {
  try {
    fs.mkdirSync(job.outDir, { recursive: true });
    const bin = job.bin ?? shakaPackagerBin();
    await new Promise<void>((resolve, reject) => {
      execFile(
        bin,
        buildShakaHlsArgs(job),
        { timeout: PACKAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return fs.existsSync(path.join(job.outDir, 'master.m3u8'));
  } catch {
    return false;
  }
}
