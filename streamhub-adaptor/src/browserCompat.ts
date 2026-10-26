/**
 * browserCompat — Safari/iOS (WebKit) WebRTC helpers for the adaptor.
 *
 * AntMedia's WebRTCAdaptor accumulated years of fixes for the same recurring
 * browser bug classes (autoplay policy, playsinline, getUserMedia error
 * surfacing, missing getDisplayMedia, ICE failures behind strict NATs). This
 * module centralizes StreamHub's equivalents as small, pure, dependency-free
 * functions so `StreamHubAdaptor` stays a thin LiveKit mapping and every
 * branch is coverable under node:test.
 *
 * See https://streamhub.studio/docs/features/WEBRTC-BROWSER-COMPAT for the full analysis
 * (which quirks livekit-client already absorbs vs what this SDK must do).
 */

/** The slice of `navigator` these helpers read (DI-friendly for tests). */
export interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  mediaDevices?: { getDisplayMedia?: unknown } | null;
}

function ua(nav?: NavigatorLike | null): string {
  return nav?.userAgent ?? "";
}

/**
 * iOS / iPadOS detection. iPadOS 13+ masquerades as macOS ("Macintosh") but
 * is still touch-first WebKit — maxTouchPoints is the discriminator.
 */
export function isIOS(nav?: NavigatorLike | null): boolean {
  const agent = ua(nav);
  if (/iPad|iPhone|iPod/.test(agent)) return true;
  return /Macintosh/.test(agent) && (nav?.maxTouchPoints ?? 0) > 1;
}

/**
 * Safari proper (desktop or mobile). Chrome/Edge/Opera all embed "Safari/" in
 * their UA, and the iOS shells report CriOS/FxiOS/EdgiOS — exclude them all.
 */
export function isSafari(nav?: NavigatorLike | null): boolean {
  const agent = ua(nav);
  return (
    /Safari\//.test(agent) &&
    !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\//.test(agent) &&
    !/Android/.test(agent)
  );
}

/**
 * Any WebKit engine: Safari anywhere, or ANY browser on iOS (Apple mandates
 * WebKit for all of them, so they inherit Safari's media policies).
 */
export function isWebKit(nav?: NavigatorLike | null): boolean {
  return isIOS(nav) || isSafari(nav);
}

/**
 * Whether screen capture exists at all. `getDisplayMedia` is entirely absent
 * on iOS/iPadOS Safari (and iOS WebViews) — callers should fail fast with a
 * clear message instead of letting a TypeError/DeviceUnsupportedError bubble.
 */
export function supportsScreenShare(
  nav: NavigatorLike | undefined | null = typeof navigator !== "undefined"
    ? (navigator as NavigatorLike)
    : undefined,
): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === "function";
}

/** The slice of a media element these helpers write to. */
export interface MediaElementLike {
  setAttribute?: (name: string, value: string) => void;
  muted?: boolean;
}

/**
 * Force inline playback on a video element: the standard `playsinline`
 * attribute (without it iOS hijacks playback into native fullscreen) plus the
 * legacy `webkit-playsinline` some embedded WebViews still need. Optionally
 * hard-mutes the element — required for LOCAL previews (echo) and for any
 * autoplaying element per the muted-autoplay policy. livekit-client's
 * `track.attach()` sets the `playsInline`/`muted` DOM properties; setting the
 * attributes as well survives element re-parenting and server-side rendering.
 * Tolerates non-DOM stand-ins (no-ops without `setAttribute`).
 */
export function applyInlinePlaybackAttributes(
  el: MediaElementLike | null | undefined,
  opts: { muted?: boolean } = {},
): void {
  if (!el) return;
  if (typeof el.setAttribute === "function") {
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    if (opts.muted) el.setAttribute("muted", "");
  }
  if (opts.muted) el.muted = true;
}

/**
 * getUserMedia DOMException names AntMedia apps switch on in their
 * `callbackError` handlers. When acquiring camera/mic fails with one of
 * these, the adaptor must surface THE NAME as the error string (AntMedia
 * parity) instead of a generic `publishError` — e.g. permission-denied UIs
 * key on `"NotAllowedError"`.
 */
const GUM_ERROR_NAMES = new Set([
  "NotAllowedError", // user denied permission (or iOS Settings deny)
  "PermissionDeniedError", // legacy Chrome alias
  "NotFoundError", // no camera/mic present
  "DevicesNotFoundError", // legacy Chrome alias
  "NotReadableError", // device busy/hardware error (Windows/other app holds it)
  "TrackStartError", // legacy Chrome alias
  "OverconstrainedError", // impossible constraints (exact deviceId gone…)
  "ConstraintNotSatisfiedError", // legacy alias
  "SecurityError", // insecure context / permissions policy
  "AbortError", // device start aborted (Safari backgrounding)
]);

/**
 * If `err` is a getUserMedia-style DOMException, return its name (the
 * AntMedia-compatible error code). Otherwise null (caller keeps its generic
 * error code).
 */
export function classifyGetUserMediaError(err: unknown): string | null {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && GUM_ERROR_NAMES.has(name) ? name : null;
}

/**
 * Patterns that indicate the WebRTC transport itself could not be
 * established — the classic "works on my network, fails for the customer"
 * case. Safari is measurably stricter here: behind symmetric NAT / corporate
 * firewalls it frequently NEEDS a TURN relay (ideally TURN/TLS on 443) where
 * Chrome sometimes squeaks through.
 */
const CONNECT_FAILURE_RE =
  /could not establish|pc connection|ice (?:candidate|connection|failed|gathering)|timed? ?out|websocket|signal(?:ling)? ?(?:connection|error)|engine.*(?:closed|disconnected)/i;

export const TURN_HINT =
  "hint: if this client is behind a strict NAT/VPN/firewall (Safari is the " +
  "strictest), the server needs a TURN relay — enable `turn:` (TURN/TLS :5349 " +
  "or :443) in livekit.yaml. See https://streamhub.studio/docs/features/WEBRTC-BROWSER-COMPAT.";

/**
 * Append the TURN hint to connection-level failure messages so integrators
 * see the likely fix right in the `callbackError` payload / console, instead
 * of a bare timeout. Non-connection errors pass through untouched.
 */
export function withTurnHint(message: string): string {
  return CONNECT_FAILURE_RE.test(message) ? `${message} — ${TURN_HINT}` : message;
}

/** The slice of EventTarget the unlock helper needs. */
export interface EventTargetLike {
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
}

/** First user gestures that satisfy autoplay/AudioContext unlock policies. */
const GESTURE_EVENTS = ["pointerdown", "touchend", "keydown"] as const;

/**
 * Run `onGesture` exactly once, on the first user gesture — the standard
 * unlock for blocked audio playback / suspended AudioContexts on
 * Safari/iOS. Returns a disposer. No-ops (returning a no-op disposer) when
 * no document/target is available (SSR, tests).
 */
export function installAutoplayUnlock(
  onGesture: () => void,
  target?: EventTargetLike,
): () => void {
  const tgt =
    target ??
    (typeof document !== "undefined" ? (document as EventTargetLike) : undefined);
  if (!tgt || typeof tgt.addEventListener !== "function") return () => {};

  let done = false;
  const handler = () => {
    if (done) return;
    done = true;
    remove();
    onGesture();
  };
  const remove = () => {
    for (const ev of GESTURE_EVENTS) tgt.removeEventListener(ev, handler);
  };
  for (const ev of GESTURE_EVENTS) tgt.addEventListener(ev, handler);
  return () => {
    done = true;
    remove();
  };
}
