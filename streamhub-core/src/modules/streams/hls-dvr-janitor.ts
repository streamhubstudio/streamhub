import * as fs from 'fs';
import * as path from 'path';

/**
 * DVR segment-retention janitor (endless-radio Tier 1, QW-4).
 *
 * An always-on/DVR HLS room keeps a full `index.m3u8` timeline growing forever
 * on disk while the egress runs. This janitor reclaims disk by deleting `.ts`
 * segments older than the DVR window — but NEVER a segment still referenced by
 * the LIVE (rolling) playlist, so the live edge a viewer is currently playing is
 * always safe. The full `index.m3u8` references EVERY segment ever written, so
 * it is deliberately NOT used as the safety reference (that would prevent any
 * pruning); the time window is the trim, the live playlist is the guard.
 *
 * Pure/fs split so the decision logic is unit-testable without touching disk.
 */

/** Parse the `.ts` segment basenames referenced by an HLS playlist body. */
export function parsePlaylistSegments(m3u8: string): Set<string> {
  const out = new Set<string>();
  for (const raw of m3u8.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue; // tags/comments/blank
    const uri = line.split('?')[0]; // drop any query string
    if (uri.endsWith('.ts')) out.add(path.basename(uri));
  }
  return out;
}

/** One on-disk segment with its last-modified time (ms epoch). */
export interface SegmentStat {
  name: string;
  mtimeMs: number;
}

/**
 * Pure decision: which `.ts` segments to delete. A segment is expired when it is
 * BOTH older than the retention window AND not referenced by the live playlist.
 */
export function selectExpiredSegments(params: {
  segments: SegmentStat[];
  referenced: ReadonlySet<string>;
  windowMs: number;
  now: number;
}): string[] {
  const { segments, referenced, windowMs, now } = params;
  const cutoff = now - Math.max(0, windowMs);
  return segments
    .filter((s) => s.mtimeMs < cutoff && !referenced.has(s.name))
    .map((s) => s.name);
}

export interface PruneResult {
  /** Basenames actually unlinked. */
  deleted: string[];
  /** Segments left on disk after the pass. */
  kept: number;
}

/** Minimal fs surface (injectable so specs can drive an in-memory fake). */
export type JanitorFs = Pick<
  typeof fs,
  'existsSync' | 'readdirSync' | 'readFileSync' | 'statSync' | 'unlinkSync'
>;

/**
 * Delete `.ts` segments older than `windowSeconds` from an on-disk HLS room dir,
 * never one referenced by the live playlist. No-op (returns zero deletions) when
 * the dir or the live playlist is absent/unreadable — without the live playlist
 * we cannot know the live window, so we conservatively delete nothing. Deletion
 * is best-effort per file; a failed unlink simply keeps the segment.
 */
export function pruneDvrDir(
  dir: string,
  windowSeconds: number,
  opts: {
    /** Live rolling playlist filename in `dir` (default `live.m3u8`). */
    livePlaylist?: string;
    now?: number;
    fsImpl?: JanitorFs;
  } = {},
): PruneResult {
  const io: JanitorFs = opts.fsImpl ?? fs;
  const now = opts.now ?? Date.now();
  const liveName = opts.livePlaylist ?? 'live.m3u8';
  const empty: PruneResult = { deleted: [], kept: 0 };

  if (!io.existsSync(dir)) return empty;

  // Safety guard: without a readable live playlist we cannot know which
  // segments the live edge needs, so we prune nothing.
  let referenced: Set<string>;
  try {
    referenced = parsePlaylistSegments(
      io.readFileSync(path.join(dir, liveName), 'utf8'),
    );
  } catch {
    return empty;
  }

  let entries: string[];
  try {
    entries = io.readdirSync(dir) as string[];
  } catch {
    return empty;
  }

  const segments: SegmentStat[] = [];
  for (const name of entries) {
    if (!name.endsWith('.ts')) continue;
    try {
      segments.push({
        name,
        mtimeMs: io.statSync(path.join(dir, name)).mtimeMs,
      });
    } catch {
      /* unstatable → skip (leave it on disk) */
    }
  }

  const toDelete = selectExpiredSegments({
    segments,
    referenced,
    windowMs: Math.max(0, windowSeconds) * 1000,
    now,
  });

  const deleted: string[] = [];
  for (const name of toDelete) {
    try {
      io.unlinkSync(path.join(dir, name));
      deleted.push(name);
    } catch {
      /* best-effort — a failed unlink just keeps the segment */
    }
  }
  return { deleted, kept: segments.length - deleted.length };
}

/** Filesystem/URL-safe room segment (mirrors HlsService.safe). */
export function safeRoomSlug(room: string): string {
  return room.replace(/[^a-zA-Z0-9_-]/g, '_');
}
