/**
 * PLUGIN LIVE-DATA CHANNEL — a tiny, in-memory "latest payload" store that lets
 * a plugin WORKER stream small runtime payloads (e.g. face/object boxes) to the
 * PLAYER overlay of the same plugin, through the core:
 *
 *   worker ── POST /apps/:app/plugins/:id/live (ingest-token) ──▶ this store
 *   player ── GET  /apps/:app/plugins/:id/live?room=…  (public) ──▶ latest
 *
 * Design constraints (deliberate):
 *   - LATEST-ONLY, per (app, plugin, room). This is a live overlay feed, not an
 *     event log — history belongs in webhooks/callbacks, not here.
 *   - MEMORY-ONLY. Nothing touches SQLite; a restart simply clears the feed.
 *   - BOUNDED. Payloads are size-capped and the key space is capped with
 *     oldest-first eviction, so a misbehaving worker can never balloon memory.
 *   - Readers get `ageMs` so they can apply their own staleness policy.
 *
 * AuthN for writes lives outside this class: the worker-hook mints a random
 * ingest token per worker start (see PluginWorkerManager) and the service layer
 * checks it before calling `push`.
 */
import { Injectable } from '@nestjs/common';

/** What a reader gets back: the payload plus freshness metadata. */
export interface LiveDataView {
  /** Unix ms timestamp of when the payload was ingested. */
  ts: number;
  /** Milliseconds elapsed since ingest (computed at read time). */
  ageMs: number;
  /** The worker-posted JSON payload, verbatim. */
  payload: unknown;
}

interface LiveEntry {
  ts: number;
  payload: unknown;
}

/** Max serialized payload size accepted (bytes of JSON). */
export const MAX_LIVE_PAYLOAD_BYTES = 64 * 1024;
/** Max distinct (app, plugin, room) keys kept before oldest-first eviction. */
export const MAX_LIVE_KEYS = 256;

@Injectable()
export class PluginLiveDataService {
  private readonly entries = new Map<string, LiveEntry>();

  /** Injectable clock (plain field, swap in tests for determinism). */
  now: () => number = Date.now;

  private key(app: string, pluginId: string, room: string): string {
    return `${app}::${pluginId}::${room}`;
  }

  /**
   * Store the latest payload for (app, plugin, room). Returns false when the
   * payload is over the size cap (caller maps that to a 4xx); otherwise true.
   */
  push(app: string, pluginId: string, room: string, payload: unknown): boolean {
    let size: number;
    try {
      size = JSON.stringify(payload)?.length ?? 0;
    } catch {
      return false; // circular / non-serializable — refuse
    }
    if (size > MAX_LIVE_PAYLOAD_BYTES) return false;

    const k = this.key(app, pluginId, room);
    if (!this.entries.has(k) && this.entries.size >= MAX_LIVE_KEYS) {
      this.evictOldest();
    }
    this.entries.set(k, { ts: this.now(), payload });
    return true;
  }

  /** Latest payload for (app, plugin, room), or null if none was ever pushed. */
  latest(app: string, pluginId: string, room: string): LiveDataView | null {
    const entry = this.entries.get(this.key(app, pluginId, room));
    if (!entry) return null;
    return {
      ts: entry.ts,
      ageMs: Math.max(0, this.now() - entry.ts),
      payload: entry.payload,
    };
  }

  /** Drop every room feed of one (app, plugin) — used on uninstall. */
  clear(app: string, pluginId: string): void {
    const prefix = `${app}::${pluginId}::`;
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of this.entries) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
