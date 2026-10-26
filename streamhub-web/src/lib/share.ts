/**
 * Pure share / public-playback helpers (dependency-free → node:test-able).
 *
 * One place for every PUBLIC playback surface of a room:
 *  - URL builders: /play page, /embed page (+ its <iframe> snippet), the public
 *    HLS playlist `/hls/<app>/<room>/index.m3u8` and a self-contained video.js
 *    embed. The origin comes from the caller (window.location.origin — the same
 *    convention as pages/Player/SharePanel).
 *  - HLS availability probe for the /play + /embed players: passthrough (remux)
 *    channels are HLS-ONLY (no LiveKit room — features/rtmp-passthrough.md), so
 *    the public player probes the playlist once and prefers HLS when it exists
 *    AND is fresh-ish; otherwise WebRTC behaves exactly as before.
 *  - `isPassthroughStream`: detect the synthetic passthrough streams row
 *    (participant 'passthrough' / streamId `<room>/passthrough`) so the panel
 *    never starts a LiveKit HLS egress for a channel whose HLS already exists.
 */

/** `/hls/<app>/<room>/index.m3u8` — relative path (same-origin fetch/player). */
export function hlsPlaylistPath(app: string, room: string): string {
  return `/hls/${encodeURIComponent(app)}/${encodeURIComponent(room)}/index.m3u8`
}

/** Absolute public HLS playlist URL. */
export function hlsPlaylistUrl(origin: string, app: string, room: string): string {
  return `${trimOrigin(origin)}${hlsPlaylistPath(app, room)}`
}

/** `<origin>/play/<app>/<room>` — the public full player page. */
export function publicPlayerUrl(origin: string, app: string, room: string): string {
  return `${trimOrigin(origin)}/play/${slug(app, room)}`
}

/** `<origin>/embed/<app>/<room>` — the bare embeddable player page. */
export function publicEmbedUrl(origin: string, app: string, room: string): string {
  return `${trimOrigin(origin)}/embed/${slug(app, room)}`
}

/** `<iframe>` snippet for the /embed page. */
export function embedIframeSnippet(embedUrl: string): string {
  return (
    `<iframe src="${embedUrl}" width="640" height="360" frameborder="0" ` +
    `allow="autoplay; fullscreen" allowfullscreen></iframe>`
  )
}

/**
 * `<origin>/embed/<app>/<room>?exp=&sig=` — the embed page carrying a SIGNED
 * playback capability (P0-3), for embedding a private-playback app. `exp`/`sig`
 * come from api.playTokenSign: an app+room-scoped, expiring HMAC — NOT an sk_
 * token or JWT, so the snippet never leaks a bearer credential.
 */
export function signedEmbedUrl(
  origin: string,
  app: string,
  room: string,
  exp: string | number,
  sig: string,
): string {
  const q = `exp=${encodeURIComponent(String(exp))}&sig=${encodeURIComponent(sig)}`
  return `${publicEmbedUrl(origin, app, room)}?${q}`
}

/** `<iframe>` over a tokenized (signed) embed URL — the full player widget. */
export function signedEmbedIframe(
  origin: string,
  app: string,
  room: string,
  exp: string | number,
  sig: string,
): string {
  return embedIframeSnippet(signedEmbedUrl(origin, app, room, exp, sig))
}

/**
 * AntMedia-style self-contained <video> embed snippet for a live HLS playlist
 * (video.js via CDN). Shared by the StreamsTab HLS modal and the share menu.
 */
export function hlsEmbedSnippet(playlistUrl: string): string {
  return [
    '<video id="streamhub-hls" class="video-js" controls preload="auto" width="640" height="360">',
    `  <source src="${playlistUrl}" type="application/x-mpegURL" />`,
    '</video>',
    '<link href="https://vjs.zencdn.net/8.23.9/video-js.css" rel="stylesheet" />',
    '<script src="https://vjs.zencdn.net/8.23.9/video.min.js"></script>',
    "<script>videojs('streamhub-hls');</script>",
  ].join('\n')
}

/**
 * True for the synthetic streams row of an RTMP/SRT→HLS passthrough channel
 * (participant 'passthrough', streamId `<room>/passthrough`). These have NO
 * LiveKit room: HLS already exists on disk, so LiveKit egress start/stop,
 * WebRTC preview and moderation do not apply.
 */
export function isPassthroughStream(s: {
  participant?: string | null
  streamId?: string | null
}): boolean {
  return s.participant === 'passthrough' || Boolean(s.streamId?.endsWith('/passthrough'))
}

// --- HLS availability probe ---------------------------------------------------

export interface HlsProbeResult {
  /** The playlist answered 200. */
  available: boolean
  /** The playlist looks recently updated (a live feed, not a stale leftover). */
  fresh: boolean
}

/** A live playlist mutates every segment (~2-6s); allow generous slack. */
export const HLS_FRESH_WINDOW_MS = 90_000

const PROBE_TIMEOUT_MS = 5_000

/**
 * Freshness from response headers, clock-skew safe: compare `Last-Modified`
 * against the server's own `Date` header when present (both come from the same
 * clock), falling back to the client clock. Missing/unparsable headers count
 * as fresh — never hide a working playlist on a proxy that strips headers.
 */
export function playlistIsFresh(
  lastModified: string | null,
  dateHeader: string | null,
  nowMs: number,
  windowMs: number = HLS_FRESH_WINDOW_MS,
): boolean {
  if (!lastModified) return true
  const modified = Date.parse(lastModified)
  if (Number.isNaN(modified)) return true
  const server = dateHeader ? Date.parse(dateHeader) : NaN
  const reference = Number.isNaN(server) ? nowMs : server
  return reference - modified <= windowMs
}

/**
 * Default playback for the public /play + /embed players: HLS only when the
 * playlist exists AND is fresh-ish — a stale leftover playlist must never hide
 * the sub-second WebRTC player. Anything else (no probe yet, 404, error) keeps
 * today's WebRTC-only behavior.
 */
export function defaultPlayback(probe: HlsProbeResult | null | undefined): 'webrtc' | 'hls' {
  return probe?.available === true && probe.fresh ? 'hls' : 'webrtc'
}

/**
 * One-shot probe of the public HLS playlist (no auth — /hls is CORS-open).
 * HEAD first (cheap); if the front rejects HEAD (405/501/…, anything but a
 * plain miss) fall back to GET — the playlist is a few hundred bytes. Any
 * network error or timeout resolves `{available:false}`: the probe must never
 * break WebRTC playback.
 */
export async function probeHls(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HlsProbeResult> {
  const attempt = async (method: 'HEAD' | 'GET') => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    try {
      return await fetchImpl(url, { method, cache: 'no-store', signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    let res = await attempt('HEAD')
    if (!res.ok && res.status !== 404 && res.status !== 403) {
      res = await attempt('GET')
    }
    if (!res.ok) return { available: false, fresh: false }
    return {
      available: true,
      fresh: playlistIsFresh(
        res.headers?.get?.('last-modified') ?? null,
        res.headers?.get?.('date') ?? null,
        Date.now(),
      ),
    }
  } catch {
    return { available: false, fresh: false }
  }
}

// --- internals ------------------------------------------------------------------

function slug(app: string, room: string): string {
  return `${encodeURIComponent(app)}/${encodeURIComponent(room)}`
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '')
}
