/**
 * Pure classifier for the MediaMTX publish path (single-port :1935 switch,
 * features/rtmp-single-port.md). MediaMTX routes ONE public RTMP port by path:
 * the front forwards `live/<key>` to the LiveKit ingress and everything else
 * (`<app>/<key>`) is a StreamHub passthrough push. The core's loopback hooks
 * ({@link ../passthrough/mediamtx-hook.controller}) call this to decide which
 * plane a hook fired for. No DI, no I/O — the shapes are unit-testable.
 *
 * DISCRIMINATOR — the `ptk_` key prefix, not just the first segment. A
 * passthrough push on an app literally named `live` (the DEFAULT seeded app)
 * would otherwise collide with the LiveKit `live/<key>` namespace; keying on the
 * passthrough-key prefix makes `live/ptk_…` route to the passthrough plane while
 * a real LiveKit push `live/<livekitKey>` stays on the LiveKit plane. This is a
 * deliberate refinement of the design doc's "route by first segment" rule.
 */
import { PASSTHROUGH_STREAM_KEY_PREFIX } from '../livekit/ingress-auth.service';

/** LiveKit ingress plane path segment (`live/<key>`). */
export const MEDIAMTX_LIVEKIT_PATH_PREFIX = 'live';

export type MediamtxPathClass =
  /** StreamHub passthrough push — validate/arm via `<app>` + `<key>`. */
  | { kind: 'passthrough'; app: string; key: string }
  /**
   * LiveKit ingress plane (`live/<key>`) — the core forwards it (`key` = the
   * path AFTER `live/`, which the forward hop reuses on both hops).
   */
  | { kind: 'livekit'; key: string }
  /** Unrecognized shape — deny (auth) / no-op (ready/notready). */
  | { kind: 'invalid' };

/**
 * Classify a MediaMTX publish path (e.g. `myapp/ptk_abc`, `live/sk_xyz`).
 * Tolerant of a stray leading slash; anything not shaped `<seg>/<seg>` (with the
 * sole exception of a deeper `live/…` path) is `invalid`.
 */
export function classifyMediamtxPath(rawPath: string): MediamtxPathClass {
  const path = (rawPath ?? '').replace(/^\/+/, '');
  const twoSeg = /^([^/]+)\/([^/]+)$/.exec(path);
  if (twoSeg) {
    const [, app, key] = twoSeg;
    // The ptk_ key IS the passthrough capability → passthrough even under `live`.
    if (key.startsWith(PASSTHROUGH_STREAM_KEY_PREFIX)) {
      return { kind: 'passthrough', app, key };
    }
    // `live/<non-ptk key>` = a real LiveKit ingress push (the core forwards it).
    if (app === MEDIAMTX_LIVEKIT_PATH_PREFIX) return { kind: 'livekit', key };
    return { kind: 'passthrough', app, key };
  }
  // A deeper `live/a/b` path is still the LiveKit plane; forward the remainder.
  const deep = new RegExp(`^${MEDIAMTX_LIVEKIT_PATH_PREFIX}/(.+)$`).exec(path);
  if (deep) return { kind: 'livekit', key: deep[1] };
  return { kind: 'invalid' };
}
