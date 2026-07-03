/**
 * Pure helpers for the direct WS MJPEG ingest (ESP32-CAM — see
 * streamhub-docs/integrations/ESP32-WS-INGEST.md).
 *
 * Two concerns, both dependency-free → node:test-able:
 *  - build the playback / publish URLs of a ws-mjpeg camera (the MJPEG <img>
 *    endpoint, the frame.jpg thumbnail, the wss:// publish URL for devices);
 *  - decide the player MODE for /play and /embed from the public live-info
 *    endpoint (`ws-mjpeg` camera live → 'mjpeg', otherwise → 'webrtc').
 */

/** Shape of GET /apps/:app/ws-ingest/live/:room (public live info). */
export interface WsLiveInfo {
  active?: boolean
  type?: string | null
  room?: string
  mjpegUrl?: string
  frameUrl?: string
  wsUrl?: string
  [k: string]: unknown
}

export type PlayerMode = 'mjpeg' | 'webrtc'

/**
 * Player-mode decision for /play + /embed: MJPEG only when the public info
 * reports an ACTIVE ws-mjpeg camera. Any error/missing info (older core,
 * private app, LiveKit-only room) falls back to the WebRTC player — the new
 * mode must never break existing playback.
 */
export function pickPlayerMode(info: WsLiveInfo | null | undefined): PlayerMode {
  return info?.active === true && info?.type === 'ws-mjpeg' ? 'mjpeg' : 'webrtc'
}

/** `/live/<app>/<room>/mjpeg` — multipart MJPEG stream (works in an <img>). */
export function mjpegUrl(app: string, room: string, token?: string | null): string {
  return liveUrl(app, room, 'mjpeg', token)
}

/** `/live/<app>/<room>/frame.jpg` — last frame (thumbnails / snapshots). */
export function frameUrl(app: string, room: string, token?: string | null): string {
  return liveUrl(app, room, 'frame.jpg', token)
}

function liveUrl(
  app: string,
  room: string,
  file: string,
  token?: string | null,
): string {
  const base = `/live/${encodeURIComponent(app)}/${encodeURIComponent(room)}/${file}`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * Append a cache-buster so a re-mounted <img> reopens the multipart stream
 * instead of showing the browser's stale cached response.
 */
export function withCacheBuster(url: string, epoch: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${epoch}`
}

/**
 * Absolute `wss://<host>/ingest/ws?app=&room=` publish URL for a device
 * (OBS-style copyable). `base` may be:
 *  - an http(s) origin (`https://streamhub.example.com`) → wss://…
 *  - empty/relative → derived from `fallbackOrigin` (window.location.origin).
 */
export function wsPublishUrl(
  base: string | undefined,
  fallbackOrigin: string,
  app: string,
  room: string,
): string {
  const origin = (base && base.trim()) || fallbackOrigin
  const wsOrigin = origin.replace(/\/+$/, '').replace(/^http/i, 'ws')
  return `${wsOrigin}/ingest/ws?app=${encodeURIComponent(app)}&room=${encodeURIComponent(room)}`
}

/**
 * Make a server-provided URL absolute against an origin. The core returns
 * RELATIVE urls (`/live/...`, `/ingest/ws?...`) when PUBLIC_BASE_URL is unset;
 * the dashboard knows its own origin. ws(s) URLs get the ws(s) scheme.
 */
export function absoluteUrl(url: string | undefined, origin: string): string {
  if (!url) return ''
  if (/^(https?|wss?):\/\//i.test(url)) return url
  const clean = origin.replace(/\/+$/, '')
  // WebSocket paths keep the ws(s) scheme derived from the http(s) origin.
  if (url.startsWith('/ingest/ws') || url.startsWith('/live/ws')) {
    return `${clean.replace(/^http/i, 'ws')}${url}`
  }
  return `${clean}${url}`
}
