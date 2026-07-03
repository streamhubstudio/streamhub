/**
 * Restream destination presets + pure URL helpers (module `restream`).
 *
 * AntMedia calls this feature "endpoints" / RTMP forwarding. A destination is
 * either a well-known platform (base RTMP ingest URL + the user's stream key)
 * or a fully custom rtmp(s):// URL. Everything here is pure and side-effect
 * free so it can be unit-tested without any service wiring (the web UI mirrors
 * this logic in streamhub-web/src/lib/restream.ts — keep them in sync).
 */

/** Supported destination platforms. `custom` = user pastes the full URL. */
export type RestreamPlatform = 'youtube' | 'twitch' | 'facebook' | 'custom';

export const RESTREAM_PLATFORMS: readonly RestreamPlatform[] = [
  'youtube',
  'twitch',
  'facebook',
  'custom',
] as const;

/** Well-known RTMP ingest bases (the stream key is appended as last segment). */
export const RESTREAM_PRESETS: Record<
  Exclude<RestreamPlatform, 'custom'>,
  { base: string; label: string }
> = {
  youtube: { base: 'rtmp://a.rtmp.youtube.com/live2', label: 'YouTube Live' },
  twitch: { base: 'rtmp://live.twitch.tv/app', label: 'Twitch' },
  facebook: {
    base: 'rtmps://live-api-s.facebook.com:443/rtmp',
    label: 'Facebook Live',
  },
};

/** Loose rtmp(s)://host[/path] shape check (host required). */
export function isRtmpUrl(url: string): boolean {
  return /^rtmps?:\/\/[^\s/]+(\/\S*)?$/i.test((url ?? '').trim());
}

/**
 * Build the destination push URL from platform + key/url:
 *  - preset platforms: `base + '/' + key` (key required, kept verbatim — some
 *    platforms embed query params in their keys);
 *  - custom: the full `url` as pasted (key, when also given, is appended as the
 *    last path segment for convenience).
 * Throws an Error with a human message on invalid input; callers map it to a
 * 400 (core) or an inline form error (web).
 */
export function buildTargetUrl(
  platform: RestreamPlatform,
  input: { url?: string; key?: string },
): string {
  const key = (input.key ?? '').trim();
  const url = (input.url ?? '').trim();

  if (platform === 'custom') {
    if (!url) throw new Error('url is required for a custom destination');
    if (!isRtmpUrl(url)) {
      throw new Error('url must start with rtmp:// or rtmps://');
    }
    if (!key) return url;
    return `${url.replace(/\/+$/, '')}/${key}`;
  }

  const preset = RESTREAM_PRESETS[platform];
  if (!preset) throw new Error(`unknown platform '${String(platform)}'`);
  if (!key) throw new Error(`stream key is required for ${preset.label}`);
  if (/[\s/]/.test(key)) {
    throw new Error('stream key must not contain spaces or slashes');
  }
  return `${preset.base}/${key}`;
}

/**
 * Redact the stream key of a destination URL: everything after the LAST path
 * segment separator keeps its first 4 chars + '…' (mirrors the settings-service
 * mask style). URLs without a path are returned untouched (nothing to hide).
 *
 *   rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl → .../live2/abcd…
 */
export function maskRtmpUrl(url: string): string {
  const raw = (url ?? '').trim();
  const m = /^(rtmps?:\/\/[^/]+)(\/.*)?$/i.exec(raw);
  if (!m) return raw;
  const [, origin, pathPart] = m;
  if (!pathPart || pathPart === '/') return raw;
  const cut = pathPart.lastIndexOf('/');
  const prefix = pathPart.slice(0, cut + 1);
  const key = pathPart.slice(cut + 1);
  if (!key) return raw;
  const visible = key.length > 4 ? key.slice(0, 4) : '';
  return `${origin}${prefix}${visible}…`;
}
