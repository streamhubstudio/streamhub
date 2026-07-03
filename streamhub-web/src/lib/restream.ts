/**
 * Restream (multi-destination RTMP forwarding) — pure form helpers.
 *
 * Mirrors the core's preset/URL logic (streamhub-core/src/modules/restream/
 * restream.presets.ts — keep in sync): the backend is the source of truth and
 * re-validates + builds the final URL; these helpers only drive the AddTarget
 * form (validation before submit + a preview of the destination URL).
 */
import type { RestreamPlatform } from '@/api'

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
}

/** Ordered platform choices for the selector (custom last). */
export const RESTREAM_PLATFORMS: RestreamPlatform[] = [
  'youtube',
  'twitch',
  'facebook',
  'custom',
]

/** Loose rtmp(s)://host[/path] shape check (host required). */
export function isRtmpUrl(url: string): boolean {
  return /^rtmps?:\/\/[^\s/]+(\/\S*)?$/i.test((url ?? '').trim())
}

/**
 * Validate the AddTarget form. Returns an i18n error KEY (under
 * `restream:formError.*`) or null when the input is submittable.
 */
export function validateRestreamInput(
  platform: RestreamPlatform,
  key: string,
  url: string,
): string | null {
  const k = (key ?? '').trim()
  const u = (url ?? '').trim()
  if (platform === 'custom') {
    if (!u) return 'urlRequired'
    if (!isRtmpUrl(u)) return 'urlInvalid'
    return null
  }
  if (!k) return 'keyRequired'
  if (/[\s/]/.test(k)) return 'keyInvalid'
  return null
}

/**
 * Destination URL preview shown under the form (exactly what the backend will
 * build). Null while the input is incomplete/invalid.
 */
export function buildRestreamPreview(
  platform: RestreamPlatform,
  key: string,
  url: string,
): string | null {
  if (validateRestreamInput(platform, key, url) !== null) return null
  const k = (key ?? '').trim()
  const u = (url ?? '').trim()
  if (platform === 'custom') {
    return k ? `${u.replace(/\/+$/, '')}/${k}` : u
  }
  return `${RESTREAM_PRESETS[platform].base}/${k}`
}
