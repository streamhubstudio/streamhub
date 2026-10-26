/**
 * Pure per-cell player resolution for the Cockpit CCTV wall (node:test-able).
 *
 * BUG FIX (player-provider aware wall): a cockpit tile used to be hard-wired to
 * the sub-second WebRTC `<LivePlayer>`. That player only shows video for rooms
 * that have a live LiveKit publisher — but a CCTV wall is frequently fed by
 * RTMP/SRT→HLS *passthrough* remux (the documented ~1% CPU/camera wall) or a
 * ws-mjpeg camera, neither of which produces a LiveKit room. Those tiles then
 * connected to an empty room and rendered the "empty room" placeholder → NO
 * VIDEO. And because `<LivePlayer>` never routes through the app's active player
 * PROVIDER (Vidstack, …) — that provider only swaps `<HlsPlayer>`/`<VodPlayer>`
 * — installing the Vidstack player had no effect on the wall either.
 *
 * This decides, per tile, which player to mount so the wall works with HLS,
 * MJPEG and the Vidstack provider, using the SAME signal the public /play +
 * /embed pages use (`defaultPlayback` over a one-shot HLS probe).
 */
import { defaultPlayback, type HlsProbeResult } from '../../lib/share.ts'

/** How a single cockpit tile should render its camera. */
export type CockpitCellMode = 'mjpeg' | 'hls' | 'webrtc'

export interface CockpitCellModeInput {
  /** The stream's ingest type (`Stream.type`), if known. */
  streamType?: string | null
  /** Result of probing the room's public HLS playlist (undefined while pending). */
  hls?: HlsProbeResult | null
}

/**
 * Resolve a tile's player:
 *  - a direct ws-mjpeg camera → `<MjpegPlayer>` (an <img>, no LiveKit room);
 *  - otherwise HLS when the public playlist exists AND is fresh — routes through
 *    the app's active player provider (Vidstack) or the built-in video.js;
 *  - otherwise the sub-second WebRTC `<LivePlayer>` (unchanged default, so a
 *    plain LiveKit-published camera with no HLS egress behaves exactly as before).
 */
export function pickCellMode(input: CockpitCellModeInput): CockpitCellMode {
  if (input.streamType === 'ws-mjpeg') return 'mjpeg'
  return defaultPlayback(input.hls) === 'hls' ? 'hls' : 'webrtc'
}
