/**
 * browserCompat — pure helpers for Safari/iOS (WebKit) WebRTC/media playback
 * quirks, shared by the players (LivePlayer / HlsPlayer / VodPlayer), the
 * Broadcast publisher and the Meeting room.
 *
 * Background (see https://streamhub.studio/docs/features/WEBRTC-BROWSER-COMPAT):
 *  - iOS <video> goes fullscreen unless `playsinline` is set. React's
 *    `playsInline` prop covers modern WebKit; the legacy `webkit-playsinline`
 *    attribute is still needed by some embedded WebViews.
 *  - Autoplay with sound is blocked everywhere; muted autoplay can ALSO be
 *    blocked on iOS Low Power Mode / Safari per-site settings — `play()`
 *    rejects with `NotAllowedError` and the UI must offer a tap-to-play.
 *  - `getDisplayMedia` does not exist on iOS/iPadOS Safari at all, so screen
 *    share controls should be hidden there instead of failing on tap.
 *
 * Framework-free and dependency-injected (navigator/user-agent passed in) so
 * node:test covers every branch without a DOM.
 */

/** The slice of `navigator` these helpers read. */
export interface NavigatorLike {
  userAgent?: string
  maxTouchPoints?: number
  mediaDevices?: { getDisplayMedia?: unknown } | null
}

function ua(nav?: NavigatorLike | null): string {
  return nav?.userAgent ?? ''
}

/**
 * iOS / iPadOS detection. iPadOS 13+ masquerades as macOS ("Macintosh") but is
 * still touch-first WebKit — detected via maxTouchPoints.
 */
export function isIOS(nav?: NavigatorLike | null): boolean {
  const agent = ua(nav)
  if (/iPad|iPhone|iPod/.test(agent)) return true
  return /Macintosh/.test(agent) && (nav?.maxTouchPoints ?? 0) > 1
}

/**
 * Desktop/mobile Safari proper (not Chrome/Edge/Firefox, which all include
 * "Safari/" in their UA). On iOS every browser is WebKit under the hood, but
 * only Safari itself reports without the CriOS/FxiOS/EdgiOS markers.
 */
export function isSafari(nav?: NavigatorLike | null): boolean {
  const agent = ua(nav)
  return (
    /Safari\//.test(agent) &&
    !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\//.test(agent) &&
    !/Android/.test(agent)
  )
}

/**
 * Any WebKit engine (Safari anywhere, or ANY browser on iOS — Apple mandates
 * WebKit for all of them). This is the right gate for WebKit media-policy
 * workarounds, since iOS Chrome/Firefox inherit them too.
 */
export function isWebKit(nav?: NavigatorLike | null): boolean {
  return isIOS(nav) || isSafari(nav)
}

/**
 * Whether screen capture is available. `getDisplayMedia` is entirely absent on
 * iOS/iPadOS Safari (and iOS WebViews) — hide share-screen UI when false.
 */
export function supportsScreenShare(
  nav: NavigatorLike | undefined | null = typeof navigator !== 'undefined'
    ? (navigator as NavigatorLike)
    : undefined,
): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function'
}

/**
 * Legacy inline-playback attributes for JSX spread on <video> elements, on top
 * of React's own `playsInline`. Harmless everywhere; needed by older WebViews.
 * Usage: `<video playsInline {...LEGACY_INLINE_VIDEO_ATTRS} />`
 */
export const LEGACY_INLINE_VIDEO_ATTRS = {
  'webkit-playsinline': 'true',
} as const

/** The subset of Element these helpers write to (DI-friendly for tests). */
export interface VideoElementLike {
  setAttribute?: (name: string, value: string) => void
}

/**
 * Imperatively force inline playback on a video element (for players built
 * outside React's JSX, e.g. the video.js mounts). Sets both the standard
 * `playsinline` and the legacy `webkit-playsinline` attributes. Tolerates
 * non-DOM stand-ins (no-ops when setAttribute is missing).
 */
export function applyInlinePlayback(el: VideoElementLike | null | undefined): void {
  if (!el || typeof el.setAttribute !== 'function') return
  el.setAttribute('playsinline', '')
  el.setAttribute('webkit-playsinline', '')
}

/**
 * True when a rejected `video.play()` means the browser blocked autoplay and
 * a user gesture is required (Safari Low Power Mode, per-site autoplay
 * settings, unmuted autoplay everywhere). The player should then surface a
 * tap-to-play affordance instead of treating it as a stream failure.
 */
export function isAutoplayBlockedError(err: unknown): boolean {
  return (err as { name?: unknown } | null | undefined)?.name === 'NotAllowedError'
}
