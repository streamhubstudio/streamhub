/**
 * Frame hub — in-memory last-frame store + fan-out for the direct WS MJPEG
 * ingest (ESP32-WS-INGEST.md §5). PURE logic: no `ws`, no express, no timers —
 * unit-testable without opening sockets (repo rule: specs need no infra).
 *
 * Semantics (per (app, room) slot):
 *  - `publish` keeps ONLY the last frame (depth-1 buffer: ingest memory is
 *    bounded by design) and fans it out to every subscribed viewer.
 *  - Backpressure is PER VIEWER: a viewer whose `ready()` returns false is
 *    skipped for this frame (its `dropped` counter increments) — a slow viewer
 *    never blocks the camera or the other viewers.
 *  - A new subscriber immediately receives the last known frame (instant
 *    picture without waiting for the next capture).
 *  - The slot is deleted when it has no viewers AND no publisher.
 */

/** Transport-agnostic viewer handle (WS socket or HTTP multipart response). */
export interface HubViewer {
  /** 'ws' (binary WS fan-out) or 'http' (multipart/x-mixed-replace). */
  kind: 'ws' | 'http';
  /** false → skip this frame for this viewer (drop, don't queue). */
  ready(): boolean;
  /** Deliver one JPEG frame. Must never throw for a dead peer (wrap it). */
  send(frame: Buffer): void;
  /** Frames skipped for this viewer because it was not ready. */
  dropped: number;
}

interface Slot {
  lastFrame: Buffer | null;
  lastTs: number;
  publisher: boolean;
  viewers: Set<HubViewer>;
  /** Frames published into this slot since it was created. */
  frames: number;
}

export interface SlotInfo {
  lastTs: number;
  hasFrame: boolean;
  publisher: boolean;
  viewers: number;
  frames: number;
}

/** Canonical slot key. */
export function hubKey(app: string, room: string): string {
  return `${app}/${room}`;
}

export class FrameHub {
  private readonly slots = new Map<string, Slot>();

  /** Store the last frame + fan out to every ready viewer. Returns viewers reached. */
  publish(app: string, room: string, frame: Buffer, now = Date.now()): number {
    const slot = this.ensure(hubKey(app, room));
    slot.lastFrame = frame; // reference, not a copy — the ws Buffer is ours
    slot.lastTs = now;
    slot.frames++;
    let delivered = 0;
    for (const v of slot.viewers) {
      if (!v.ready()) {
        v.dropped++;
        continue;
      }
      try {
        v.send(frame);
        delivered++;
      } catch {
        // A dying peer must never break the fan-out loop.
        v.dropped++;
      }
    }
    return delivered;
  }

  /** Add a viewer; it immediately receives the last frame when one exists. */
  subscribe(app: string, room: string, viewer: HubViewer): void {
    const slot = this.ensure(hubKey(app, room));
    slot.viewers.add(viewer);
    if (slot.lastFrame && viewer.ready()) {
      try {
        viewer.send(slot.lastFrame);
      } catch {
        viewer.dropped++;
      }
    }
  }

  /** Remove a viewer; empty slots (no viewers, no publisher) are deleted. */
  unsubscribe(app: string, room: string, viewer: HubViewer): void {
    const key = hubKey(app, room);
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.viewers.delete(viewer);
    this.gc(key, slot);
  }

  /** Mark the publisher present/absent for a slot (drives slot lifetime). */
  setPublisher(app: string, room: string, present: boolean): void {
    const key = hubKey(app, room);
    if (present) {
      this.ensure(key).publisher = true;
      return;
    }
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.publisher = false;
    this.gc(key, slot);
  }

  /** Last frame of a room, or null (no publisher yet / slot gone). */
  lastFrame(app: string, room: string): { frame: Buffer; ts: number } | null {
    const slot = this.slots.get(hubKey(app, room));
    if (!slot?.lastFrame) return null;
    return { frame: slot.lastFrame, ts: slot.lastTs };
  }

  /** Whether a live publisher is attached to the room. */
  hasPublisher(app: string, room: string): boolean {
    return this.slots.get(hubKey(app, room))?.publisher ?? false;
  }

  viewerCount(app: string, room: string): number {
    return this.slots.get(hubKey(app, room))?.viewers.size ?? 0;
  }

  /** Introspection for metrics/status endpoints. */
  info(app: string, room: string): SlotInfo | null {
    const slot = this.slots.get(hubKey(app, room));
    if (!slot) return null;
    return {
      lastTs: slot.lastTs,
      hasFrame: !!slot.lastFrame,
      publisher: slot.publisher,
      viewers: slot.viewers.size,
      frames: slot.frames,
    };
  }

  /** Number of live slots (for metrics). */
  get size(): number {
    return this.slots.size;
  }

  private ensure(key: string): Slot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        lastFrame: null,
        lastTs: 0,
        publisher: false,
        viewers: new Set(),
        frames: 0,
      };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private gc(key: string, slot: Slot): void {
    if (slot.viewers.size === 0 && !slot.publisher) this.slots.delete(key);
  }
}
