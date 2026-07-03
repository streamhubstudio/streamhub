/**
 * Unit specs for the FrameHub — the in-memory last-frame store + fan-out of
 * the direct WS MJPEG ingest (ESP32-WS-INGEST.md §5). Pure logic: no sockets,
 * no timers, no DB.
 *
 * Invariants locked down:
 *  - depth-1 buffer: only the LAST frame is retained per (app, room);
 *  - a new subscriber immediately receives the last known frame;
 *  - per-viewer drop: a not-ready viewer is skipped (dropped++) while the
 *    others still receive the frame — no cross-viewer head-of-line blocking;
 *  - a viewer whose send() throws never breaks the fan-out;
 *  - slot lifecycle: deleted only when no viewers AND no publisher remain.
 */
import { FrameHub, HubViewer } from './frame-hub';

function frame(tag: string): Buffer {
  return Buffer.from(`jpeg:${tag}`);
}

/** Recording viewer with a switchable ready() gate. */
function viewer(kind: 'ws' | 'http' = 'ws'): HubViewer & {
  received: Buffer[];
  readyNow: boolean;
  throwOnSend: boolean;
} {
  const v = {
    kind,
    dropped: 0,
    received: [] as Buffer[],
    readyNow: true,
    throwOnSend: false,
    ready: () => v.readyNow,
    send: (f: Buffer) => {
      if (v.throwOnSend) throw new Error('peer gone');
      v.received.push(f);
    },
  };
  return v;
}

describe('FrameHub (ws-ingest fan-out)', () => {
  let hub: FrameHub;

  beforeEach(() => {
    hub = new FrameHub();
  });

  it('keeps only the last frame per (app, room)', () => {
    hub.publish('live', 'live-cam1', frame('a'));
    hub.publish('live', 'live-cam1', frame('b'));
    expect(hub.lastFrame('live', 'live-cam1')?.frame.toString()).toBe('jpeg:b');
    // Other rooms are independent slots.
    expect(hub.lastFrame('live', 'live-cam2')).toBeNull();
  });

  it('a new subscriber immediately receives the last frame', () => {
    hub.publish('live', 'live-cam1', frame('a'));
    const v = viewer();
    hub.subscribe('live', 'live-cam1', v);
    expect(v.received.map(String)).toEqual(['jpeg:a']);
  });

  it('subscribing before any frame delivers nothing until publish', () => {
    const v = viewer();
    hub.subscribe('live', 'live-cam1', v);
    expect(v.received).toHaveLength(0);
    hub.publish('live', 'live-cam1', frame('a'));
    expect(v.received.map(String)).toEqual(['jpeg:a']);
  });

  it('fans out to every ready viewer; a slow one is dropped, not queued', () => {
    const fast = viewer();
    const slow = viewer('http');
    hub.subscribe('live', 'live-cam1', fast);
    hub.subscribe('live', 'live-cam1', slow);

    slow.readyNow = false; // saturated (awaiting drain / full WS buffer)
    const delivered = hub.publish('live', 'live-cam1', frame('a'));

    expect(delivered).toBe(1);
    expect(fast.received.map(String)).toEqual(['jpeg:a']);
    expect(slow.received).toHaveLength(0);
    expect(slow.dropped).toBe(1);

    // Once the slow viewer drains it receives the NEXT frame (never a backlog).
    slow.readyNow = true;
    hub.publish('live', 'live-cam1', frame('b'));
    expect(slow.received.map(String)).toEqual(['jpeg:b']);
    expect(fast.received.map(String)).toEqual(['jpeg:a', 'jpeg:b']);
  });

  it('a viewer whose send() throws never breaks the fan-out loop', () => {
    const dying = viewer();
    const healthy = viewer();
    hub.subscribe('live', 'live-cam1', dying);
    hub.subscribe('live', 'live-cam1', healthy);
    dying.throwOnSend = true;

    expect(() => hub.publish('live', 'live-cam1', frame('a'))).not.toThrow();
    expect(healthy.received.map(String)).toEqual(['jpeg:a']);
    expect(dying.dropped).toBe(1);
  });

  it('slot lifecycle: deleted only when no viewers AND no publisher', () => {
    const v = viewer();
    hub.setPublisher('live', 'live-cam1', true);
    hub.subscribe('live', 'live-cam1', v);
    hub.publish('live', 'live-cam1', frame('a'));
    expect(hub.size).toBe(1);

    // Publisher leaves but a viewer remains → slot (and last frame) survive.
    hub.setPublisher('live', 'live-cam1', false);
    expect(hub.size).toBe(1);
    expect(hub.hasPublisher('live', 'live-cam1')).toBe(false);
    expect(hub.lastFrame('live', 'live-cam1')).not.toBeNull();

    // Last viewer leaves → slot is gone (bounded memory by design).
    hub.unsubscribe('live', 'live-cam1', v);
    expect(hub.size).toBe(0);
    expect(hub.lastFrame('live', 'live-cam1')).toBeNull();
  });

  it('unsubscribe of an unknown viewer/room is a no-op', () => {
    expect(() => hub.unsubscribe('live', 'nope', viewer())).not.toThrow();
    expect(hub.size).toBe(0);
  });

  it('tracks viewer counts and slot info for metrics', () => {
    const a = viewer();
    const b = viewer();
    hub.setPublisher('live', 'live-cam1', true);
    hub.subscribe('live', 'live-cam1', a);
    hub.subscribe('live', 'live-cam1', b);
    hub.publish('live', 'live-cam1', frame('x'), 12345);

    expect(hub.viewerCount('live', 'live-cam1')).toBe(2);
    expect(hub.info('live', 'live-cam1')).toEqual({
      lastTs: 12345,
      hasFrame: true,
      publisher: true,
      viewers: 2,
      frames: 1,
    });
    expect(hub.info('live', 'other')).toBeNull();
  });
});
