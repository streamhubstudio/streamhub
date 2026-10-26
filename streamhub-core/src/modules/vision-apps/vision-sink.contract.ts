/**
 * VISION APPS — the detection SINK seam (leaf: token + interface only).
 *
 * Kept in its own dependency-free file so `modules/plugins/plugins.service` can
 * import the token + interface to OPTIONALLY tap vision detections into the
 * per-model db + the rotated app log WITHOUT pulling the vision module's services
 * (which would import back into plugins → a cycle). The concrete implementation
 * ({@link VisionSinkService}) lives in vision.sink.ts and is bound to this token
 * by the @Global VisionAppsModule; when that module is absent the optional
 * injection is simply undefined and nothing breaks.
 */

/** DI token for the vision detection sink (optional consumer: PluginsService). */
export const VISION_EVENT_SINK = Symbol('VISION_EVENT_SINK');

/** The one method the plugin event channel calls for a vision-family event. */
export interface VisionEventSink {
  /**
   * Record one accepted vision detection into `vision.db` + the app's rotated
   * log. `event` is the manifest event name (`occupancy.*`/`count.*`/`crowd.*`/
   * `demography.*`); `payload` is the dispatched envelope (`{ ...data, plugin,
   * room }`). MUST never throw — a sink failure can never break event ingest.
   */
  record(app: string, event: string, payload: Record<string, unknown>): void;
}
