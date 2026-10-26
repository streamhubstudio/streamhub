/**
 * Per-stream plugin opt-out resolution (module `streams` × `plugins`).
 *
 * A plugin enabled on an app applies to ALL of that app's live streams by
 * DEFAULT. This service owns the per-stream override stored in the per-app
 * `streams.disabled_plugins` column (a JSON array of plugin ids the stream is
 * opted OUT of) and is the ONE coordination point between the two modules:
 *   - the streams controller uses get/set to edit a single stream's opt-out,
 *   - the plugins service uses `resolveDisabled` to subtract a stream's (or a
 *     room's) opted-out plugins from the app's enabled set when serving the
 *     player-overlay list.
 *
 * It lives in its own tiny module (StreamPluginsModule) so both StreamsModule
 * and PluginsModule can import it WITHOUT a circular module dependency
 * (PipelineModule already wires PluginsModule ← StreamsModule ← PipelineModule).
 * It only needs the global DbService.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';

export interface StreamPluginsState {
  /** Canonical stream id (`${room}/${participant}`). */
  streamId: string;
  /** Plugin ids this stream is opted OUT of. */
  disabled: string[];
}

/** Scope for resolving the effective opt-out set (either is optional). */
export interface StreamScope {
  /** Exact canonical stream id — most precise. */
  stream?: string;
  /** Room name — aggregates over the room's active streams. */
  room?: string;
}

@Injectable()
export class StreamPluginOverridesService {
  constructor(private readonly db: DbService) {}

  /** Parse a `disabled_plugins` JSON cell into a clean id array. */
  private parse(json: string | null | undefined): string[] {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? this.normalize(v) : [];
    } catch {
      return [];
    }
  }

  /** Coerce to a deduped array of non-empty string ids (order preserved). */
  private normalize(ids: unknown[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const trimmed = id.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  /**
   * The disabled-plugin list for ONE stream. Throws NotFound when the stream
   * row is absent (used by the read/write endpoints, which must 404).
   */
  getForStream(app: string, streamId: string): StreamPluginsState {
    const row = this.db
      .appDb(app)
      .prepare('SELECT disabled_plugins FROM streams WHERE stream_id = ?')
      .get(streamId) as { disabled_plugins: string | null } | undefined;
    if (!row) throw new NotFoundException(`stream '${streamId}' not found`);
    return { streamId, disabled: this.parse(row.disabled_plugins) };
  }

  /**
   * Replace a stream's disabled-plugin list. Normalizes the input (drops
   * non-strings/empties, dedupes) and persists the JSON array. Throws NotFound
   * when the stream row is absent.
   */
  setForStream(app: string, streamId: string, ids: unknown[]): StreamPluginsState {
    const disabled = this.normalize(ids ?? []);
    const info = this.db
      .appDb(app)
      .prepare('UPDATE streams SET disabled_plugins = ? WHERE stream_id = ?')
      .run(JSON.stringify(disabled), streamId);
    if (info.changes === 0) {
      throw new NotFoundException(`stream '${streamId}' not found`);
    }
    return { streamId, disabled };
  }

  /**
   * Non-throwing lookup of a single stream's disabled ids — [] when the stream
   * is unknown (so overlay resolution degrades to "app default" rather than
   * erroring on a stale/unknown stream id).
   */
  disabledForStream(app: string, streamId: string): string[] {
    try {
      const row = this.db
        .appDb(app)
        .prepare('SELECT disabled_plugins FROM streams WHERE stream_id = ?')
        .get(streamId) as { disabled_plugins: string | null } | undefined;
      return row ? this.parse(row.disabled_plugins) : [];
    } catch {
      return [];
    }
  }

  /**
   * Union of the disabled ids across a room's ACTIVE streams. A player knows
   * only its room (not the individual publisher stream id), so an overlay is
   * hidden for the room when the room's live stream(s) opt out of it. [] when
   * no active stream matches (→ app default).
   */
  disabledForRoom(app: string, room: string): string[] {
    if (!room) return [];
    try {
      const rows = this.db
        .appDb(app)
        .prepare(
          "SELECT disabled_plugins FROM streams WHERE room = ? AND status = 'active'",
        )
        .all(room) as { disabled_plugins: string | null }[];
      const set = new Set<string>();
      for (const r of rows) for (const id of this.parse(r.disabled_plugins)) set.add(id);
      return [...set];
    } catch {
      return [];
    }
  }

  /**
   * Resolve the effective opt-out set for a scope. Prefers an exact stream id;
   * falls back to the room aggregate; empty when neither is given (the caller
   * then serves the unmodified app-level list — full back-compat).
   */
  resolveDisabled(app: string, scope: StreamScope): string[] {
    const stream = scope.stream?.trim();
    if (stream) return this.disabledForStream(app, stream);
    const room = scope.room?.trim();
    if (room) return this.disabledForRoom(app, room);
    return [];
  }
}
