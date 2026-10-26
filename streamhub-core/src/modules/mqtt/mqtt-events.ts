/**
 * Event → topic-category mapping for per-app MQTT publishing.
 *
 * Topic layout (documented in https://streamhub.studio/docs/features/mqtt):
 *   <topicPrefix>/<category>/<event>   e.g. streamhub/live/vod/vod_ready
 *   <topicPrefix>/log/<level>          app log lines (mqtt.logs)
 *
 * Categories:
 *   connection  — room/participant/track lifecycle, ingest (ingress/stream),
 *                 live HLS + restream state
 *   vod         — recording/VOD/snapshot/egress pipeline
 *   plugin      — plugin worker lifecycle (start/stop/error)
 *   interaction — chat / reactions
 *   alert       — stream health alerts (stream.latency_high / _recovered and
 *                 the stream-health app's health.* family)
 *   iot         — structured IoT device data (iot.data — ws-ingest data frame /
 *                 generic MQTT-in; see internal design notes)
 *   log         — app log stream (not a CallbackEvent; emitted by publishLog)
 */

export type MqttEventCategory =
  | 'connection'
  | 'vod'
  | 'plugin'
  | 'interaction'
  | 'alert'
  | 'iot';

/** Classify a callback event into its MQTT topic category. */
export function eventCategory(event: string): MqttEventCategory {
  if (event.startsWith('stream.latency')) return 'alert';
  // stream-health Studio App family (health.degraded/_recovered/audio_lost/…).
  if (event.startsWith('health.')) return 'alert';
  if (event === 'iot.data' || event.startsWith('iot.')) return 'iot';
  if (event.startsWith('plugin_worker')) return 'plugin';
  if (
    event.startsWith('recording_') ||
    event.startsWith('vod_') ||
    event.startsWith('egress_') ||
    event === 'snapshot_taken'
  ) {
    return 'vod';
  }
  if (event === 'chat_message' || event === 'reaction') return 'interaction';
  // room_*, participant_*, track_*, ingress_*, stream_*, hls_*, restream_*
  return 'connection';
}

/** `<prefix>/<category>/<event>` with a normalized (no trailing /) prefix. */
export function eventTopic(prefix: string, event: string): string {
  return `${normalizePrefix(prefix)}/${eventCategory(event)}/${event}`;
}

/** `<prefix>/log/<level>` for forwarded app log lines. */
export function logTopic(prefix: string, level: string): string {
  return `${normalizePrefix(prefix)}/log/${level}`;
}

export function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '');
}
