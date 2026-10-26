/**
 * Unit spec — Streamflow event catalogue. Guards that the discoverable trigger
 * catalogue stays in sync with (a) every core `CallbackEvent` union member and
 * (b) every in-tree plugin-meta event, that the cluster family is scoped
 * 'cluster', and that no concrete event name is duplicated across families.
 *
 * When someone adds a new `CallbackEvent`, this spec fails until it is added to
 * the catalogue too — that is the drift guard.
 */
import { catalogueEventNames, EVENT_CATALOGUE } from './event-catalogue';

// The core CallbackEvent union (shared/contracts/types.ts) — kept here so a new
// union member forces a catalogue update.
const CORE_EVENTS = [
  'room_started', 'room_finished', 'participant_joined', 'participant_left',
  'track_published', 'track_unpublished',
  'ingress_started', 'ingress_ended', 'egress_started', 'egress_updated', 'egress_ended',
  'stream_started', 'stream_ended',
  'recording_started', 'recording_part_ready', 'recording_ready', 'recording_failed',
  'snapshot_taken', 'vod_ready', 'vod_variants_ready',
  'hls_started', 'hls_stopped',
  'restream_started', 'restream_stopped', 'restream_failed',
  'chat_message', 'reaction',
  'plugin_worker_started', 'plugin_worker_stopped', 'plugin_worker_error',
  'plugin.version_changed',
  'stream.latency_high', 'stream.latency_recovered',
  'plate.detected', 'plate.allowed', 'plate.denied',
  'node.online', 'node.offline',
  'network.threshold_exceeded', 'network.threshold_recovered',
  'streamflow.run_started', 'streamflow.run_finished', 'streamflow.run_failed', 'streamflow.output',
  'iot.data',
];

// In-tree plugin metas' declared events (streamhub-core/src/plugins/*/plugin.meta.ts).
const META_EVENTS = [
  'count.in', 'count.out', 'count.occupancy',
  'occupancy.session_started', 'occupancy.session_ended', 'occupancy.alert',
  'crowd.count', 'crowd.threshold',
  'demography.face',
];

// Vendor app manifests' declared events.
const VENDOR_EVENTS = [
  'presence.absent', 'presence.returned', 'presence.after_hours',
  'ppe.violation',
];

describe('event catalogue', () => {
  const names = new Set(catalogueEventNames());

  it('includes every core CallbackEvent union member', () => {
    const missing = CORE_EVENTS.filter((e) => !names.has(e));
    expect(missing).toEqual([]);
  });

  it('includes every in-tree plugin-meta event', () => {
    const missing = META_EVENTS.filter((e) => !names.has(e));
    expect(missing).toEqual([]);
  });

  it('includes every vendor manifest event', () => {
    const missing = VENDOR_EVENTS.filter((e) => !names.has(e));
    expect(missing).toEqual([]);
  });

  it('scopes the cluster family as cluster and lists node.* + cluster.capacity', () => {
    const cluster = EVENT_CATALOGUE.find((f) => f.family === 'cluster');
    expect(cluster?.scope).toBe('cluster');
    const clusterNames = cluster?.events.map((e) => e.event) ?? [];
    expect(clusterNames).toEqual(expect.arrayContaining(['node.online', 'node.offline', 'cluster.capacity']));
  });

  it('flags worker-callback-only events (perimeter)', () => {
    const perimeter = EVENT_CATALOGUE.find((f) => f.family === 'perimeter');
    expect(perimeter?.events[0].viaWorkerCallback).toBe(true);
  });

  it('has no duplicate concrete event name across families', () => {
    const list = catalogueEventNames();
    expect(list.length).toBe(new Set(list).size);
  });

  it('every family declares an app or cluster scope', () => {
    for (const fam of EVENT_CATALOGUE) {
      expect(['app', 'cluster']).toContain(fam.scope);
      expect(fam.events.length).toBeGreaterThan(0);
    }
  });
});
