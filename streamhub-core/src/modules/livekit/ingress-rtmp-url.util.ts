/**
 * Pure builders for the public RTMP / RTMPS ingest push URLs surfaced by the
 * ingress endpoints (SPEC §16). Kept as a standalone util (no DI) so the
 * URL contract can be pinned under jest without booting the controller.
 *
 * RTMPS is a TLS-terminated front (stunnel on :RTMPS_PORT → the plaintext
 * ingress on :1935; see deploy/rtmps/). The TLS wrapper is transparent, so the
 * rtmps:// URL is byte-for-byte the rtmp:// URL with the scheme and port swapped
 * — same `/live/<streamKey>` path, same stream key.
 */

/** Legacy default host used when RTMP_PUBLIC_HOST is unset (unchanged). */
export const DEFAULT_RTMP_HOST = 'media.digitalhub.com.ar';
/** Plaintext RTMP ingest port (LiveKit ingress `rtmp_port`). */
export const RTMP_PORT = 1935;
/** RTMP application/path segment prepended to the stream key. */
export const RTMP_APP = 'live';

export interface RtmpUrlConfig {
  /** Public RTMP host (RTMP_PUBLIC_HOST). Empty → DEFAULT_RTMP_HOST. */
  rtmpPublicHost: string;
  /** Whether the RTMPS front is enabled (STREAMHUB_RTMPS_ENABLE). */
  rtmpsEnable: boolean;
  /** Public RTMPS host (RTMPS_PUBLIC_HOST). Empty → rtmpPublicHost → default. */
  rtmpsPublicHost: string;
  /** RTMPS TLS port the stunnel front listens on (STREAMHUB_RTMPS_PORT). */
  rtmpsPort: number;
}

/** Default port for the RTMP→HLS passthrough front (NOT LiveKit's :1935). */
export const RTMP_PASSTHROUGH_PORT = 1937;

/**
 * Build the RTMP push URL for a PASSTHROUGH (remux) ingress:
 * `rtmp://<host>:<port>/<app>/<key>`.
 *
 * Deliberately distinct from {@link buildRtmpUrl}: passthrough runs on its OWN
 * port (default 1937) and its path is `/<app>/<key>` (the app + the passthrough
 * stream key), NOT LiveKit's `/live/<key>` on :1935 — the two ingest planes are
 * byte-for-byte independent. Undefined when there is no stream key.
 */
export function buildPassthroughRtmpUrl(
  streamKey: string | undefined,
  opts: { host: string; port: number; app: string },
): string | undefined {
  if (!streamKey) return undefined;
  const host = opts.host || DEFAULT_RTMP_HOST;
  return `rtmp://${host}:${opts.port}/${opts.app}/${streamKey}`;
}

/**
 * Build the SRT push URL for a PASSTHROUGH (remux) ingress:
 * `srt://<host>:<port>?streamid=<key>`.
 *
 * SRT has no path component — the per-ingress port + the minted key are the
 * capability (ffmpeg's srt listener does not enforce a streamid match; the
 * `streamid` param is carried for encoder compatibility/traceability, mirroring
 * how the RTMP passthrough URL carries the key in its path). Undefined when
 * there is no stream key.
 */
export function buildPassthroughSrtUrl(
  streamKey: string | undefined,
  opts: { host: string; port: number },
): string | undefined {
  if (!streamKey) return undefined;
  const host = opts.host || DEFAULT_RTMP_HOST;
  return `srt://${host}:${opts.port}?streamid=${streamKey}`;
}

/** Build `rtmp://<host>:1935/live/<streamKey>`. Undefined when no stream key. */
export function buildRtmpUrl(
  streamKey: string | undefined,
  cfg: RtmpUrlConfig,
): string | undefined {
  if (!streamKey) return undefined;
  const host = cfg.rtmpPublicHost || DEFAULT_RTMP_HOST;
  return `rtmp://${host}:${RTMP_PORT}/${RTMP_APP}/${streamKey}`;
}

/**
 * Build `rtmps://<host>:<port>/live/<streamKey>` — ONLY when RTMPS is enabled.
 * Host falls back rtmpsPublicHost → rtmpPublicHost → default so an operator that
 * just flips the flag on (same box, same domain) gets a correct URL for free.
 */
export function buildRtmpsUrl(
  streamKey: string | undefined,
  cfg: RtmpUrlConfig,
): string | undefined {
  if (!streamKey || !cfg.rtmpsEnable) return undefined;
  const host = cfg.rtmpsPublicHost || cfg.rtmpPublicHost || DEFAULT_RTMP_HOST;
  return `rtmps://${host}:${cfg.rtmpsPort}/${RTMP_APP}/${streamKey}`;
}
