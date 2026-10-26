/**
 * Cross-module contract for the per-app network I/O counter (Vision Edge design
 * §J, Wave 1C). Kept LOCAL to this module (not in shared/contracts) so parallel
 * feature work never collides on the shared barrel — the ONE consumer outside
 * this module (the LiveKit webhook sink) resolves the token lazily through
 * `ModuleRef` and imports only this type, so there is no DI import cycle
 * (net-metrics never imports livekit).
 */

/** DI token for the network-metrics recorder (bound to NetMetricsService). */
export const NET_METRICS_SERVICE = Symbol('NET_METRICS_SERVICE');

/** Byte-flow direction relative to the app: ingest (`in`) vs delivery (`out`). */
export type NetDirection = 'in' | 'out';

/**
 * Sink for byte counts observed on an app's media planes. Every collector
 * (HLS static, MediaMTX poller, LiveKit egress webhook) funnels through
 * `recordBytes`; the service accumulates in memory and flushes hourly buckets
 * to the per-app `net_samples` table. MUST be cheap and MUST never throw — a
 * counter must never break the flow it is measuring.
 */
export interface NetMetricsServiceContract {
  /**
   * Add `bytes` of traffic for `app` on `direction`/`source`. `source` is a
   * short, stable plane label (`'hls'`, `'mediamtx'`, `'livekit-egress'`, …).
   * Non-positive / non-finite byte counts are ignored.
   */
  recordBytes(
    app: string,
    direction: NetDirection,
    source: string,
    bytes: number,
  ): void;
}
