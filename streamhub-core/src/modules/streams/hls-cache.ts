import * as fs from 'fs';

/**
 * Cache-Control / Content-Type policy for files served under `/hls`
 * (Edge/CDN cache — CLUSTER-ROADMAP §4 item #2).
 *
 * Live HLS egress writes `index.m3u8` + `.ts` segments to
 * `<dataDir>/apps/<app>/hls/<room>/`; the origin serves them at `/hls/...`.
 * The header semantics here let an edge/CDN reverse proxy cache-collapse
 * concurrent viewers so the origin only serves each object ~once, offloading
 * viewer fan-out bandwidth:
 *
 *  - `.ts` **segments** are immutable once written (a segment file is never
 *    rewritten) → `public, max-age=1y, immutable`. Always cacheable regardless
 *    of the CDN knob (this is the bulk of the bytes and the biggest win).
 *  - `.m3u8` **playlists** mutate every segment while a stream is LIVE → a short
 *    `max-age` (~half the segment duration) + `stale-while-revalidate` so a CDN
 *    collapses concurrent polls without pinning viewers to a stale live edge.
 *  - A **finished** playlist (carries `#EXT-X-ENDLIST`) is immutable for that
 *    recording → a longer TTL is safe.
 *
 * The CDN knob (`STREAMHUB_HLS_CDN`, default off) only affects the *playlist*
 * policy: when off, playlists stay `no-cache` (the pre-CDN behavior); when on,
 * they become briefly cacheable. Segments and Content-Type are unconditional.
 */

/** Segment duration used by the live HLS egress (matches HlsService). */
export const HLS_SEGMENT_DURATION_S = 4;

/** Immutable `.ts` segment TTL: one year. */
const SEGMENT_MAX_AGE_S = 31536000;

/**
 * Live playlist freshness window (`stale-while-revalidate`): ~half the segment
 * duration so a CDN serves at most a half-segment-stale live edge.
 */
const LIVE_PLAYLIST_SWR_S = Math.max(1, Math.floor(HLS_SEGMENT_DURATION_S / 2));

/** Finished (ENDLIST) playlist TTL — immutable for the recording; cache longer. */
const FINISHED_PLAYLIST_MAX_AGE_S = 3600;

const CT_PLAYLIST = 'application/vnd.apple.mpegurl';
const CT_SEGMENT = 'video/mp2t';

export type HlsFileKind = 'playlist' | 'segment' | 'other';

/** Classify an on-disk `/hls` file by extension. */
export function hlsFileKind(filePath: string): HlsFileKind {
  if (filePath.endsWith('.m3u8')) return 'playlist';
  if (filePath.endsWith('.ts')) return 'segment';
  return 'other';
}

export interface HlsCacheOptions {
  /** CDN-friendly playlist caching enabled (`STREAMHUB_HLS_CDN`). */
  cdn: boolean;
  /** Playlist carries `#EXT-X-ENDLIST` (finished VOD) → immutable, cache longer. */
  finished?: boolean;
}

/**
 * Compute the response headers (`Cache-Control`, `Content-Type`,
 * `Access-Control-Allow-Origin`) to apply to a `/hls` file.
 *
 * Pure: given a path + options it returns the header map; the caller writes them
 * onto the response. `.ts` segments are always long-cached + immutable; `.m3u8`
 * caching depends on the CDN knob and whether the playlist has finished.
 */
export function hlsCacheHeaders(
  filePath: string,
  opts: HlsCacheOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
  };
  switch (hlsFileKind(filePath)) {
    case 'segment':
      headers['Content-Type'] = CT_SEGMENT;
      headers['Cache-Control'] = `public, max-age=${SEGMENT_MAX_AGE_S}, immutable`;
      break;
    case 'playlist':
      headers['Content-Type'] = CT_PLAYLIST;
      if (!opts.cdn) {
        // Pre-CDN behavior: never cache the mutating live playlist.
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      } else if (opts.finished) {
        headers['Cache-Control'] = `public, max-age=${FINISHED_PLAYLIST_MAX_AGE_S}`;
      } else {
        headers['Cache-Control'] =
          `public, max-age=1, stale-while-revalidate=${LIVE_PLAYLIST_SWR_S}`;
      }
      break;
    default:
      // Unknown file type under /hls: keep CORS open, leave caching to defaults.
      break;
  }
  return headers;
}

/**
 * Cheap sync check: does an on-disk `.m3u8` carry `#EXT-X-ENDLIST` (a finished
 * VOD playlist that will not change again)? Playlists are tiny (a few KB) and
 * hot in the page cache. Robust: any read error → treat as live (not finished).
 */
export function playlistIsFinished(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').includes('#EXT-X-ENDLIST');
  } catch {
    return false;
  }
}
