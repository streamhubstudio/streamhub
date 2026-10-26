/**
 * HLS media-playlist parsing + poll-to-poll diffing — PURE (string in,
 * plain objects out). The worker re-reads each room's index.m3u8 every
 * sampling cycle and diffs it against the previous poll to detect:
 *
 *   - stalls           (the playlist stopped advancing),
 *   - dropped segments (media-sequence jumped past what we saw — segments
 *                       rotated out of the window unseen),
 *   - discontinuities  (#EXT-X-DISCONTINUITY tags attached to NEW segments),
 *   - measured bitrate (new segment bytes / new segment seconds — byte sizes
 *                       are stat()ed by the caller; this module only does the
 *                       sequence arithmetic).
 */

/**
 * Parse a media playlist.
 * @param {string} text
 * @returns {{
 *   mediaSequence: number,
 *   targetDuration: number|null,
 *   endlist: boolean,
 *   segments: { uri: string, duration: number, discontinuity: boolean, seq: number }[],
 * }}
 */
export function parsePlaylist(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let mediaSequence = 0;
  let targetDuration = null;
  let endlist = false;
  const segments = [];
  let pendingDuration = null;
  let pendingDiscontinuity = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const n = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
      if (Number.isFinite(n)) mediaSequence = n;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const n = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (Number.isFinite(n)) targetDuration = n;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      // Matches #EXT-X-DISCONTINUITY (not -SEQUENCE, filtered below).
      if (!line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
        pendingDiscontinuity = true;
      }
    } else if (line.startsWith('#EXTINF:')) {
      const n = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      pendingDuration = Number.isFinite(n) ? n : 0;
    } else if (line === '#EXT-X-ENDLIST') {
      endlist = true;
    } else if (!line.startsWith('#')) {
      segments.push({
        uri: line,
        duration: pendingDuration ?? 0,
        discontinuity: pendingDiscontinuity,
        seq: mediaSequence + segments.length,
      });
      pendingDuration = null;
      pendingDiscontinuity = false;
    }
  }
  return { mediaSequence, targetDuration, endlist, segments };
}

/**
 * Diff two consecutive polls of the same playlist.
 *
 * Sequence model: a playlist window covers [mediaSequence,
 * mediaSequence + segments.length). Between two polls:
 *   - advanced        ⇔ the window's exclusive END moved forward;
 *   - newSegments     = segments with seq ≥ the previous end (things we had
 *                       never seen);
 *   - droppedSegments = how far the new window's START jumped PAST the
 *                       previous end — segments produced and rotated out
 *                       without ever appearing in a poll (gap ⇒ we lost
 *                       sight of real media, a discontinuity signal);
 *   - newDiscontinuityTags = #EXT-X-DISCONTINUITY markers on new segments.
 *
 * @param {ReturnType<typeof parsePlaylist>|null} prev  previous poll (null = first).
 * @param {ReturnType<typeof parsePlaylist>} curr       current poll.
 */
export function diffPlaylist(prev, curr) {
  const currEnd = curr.mediaSequence + curr.segments.length;
  if (!prev) {
    return {
      advanced: curr.segments.length > 0,
      newSegments: curr.segments.slice(),
      droppedSegments: 0,
      newDiscontinuityTags: curr.segments.filter((s) => s.discontinuity).length,
    };
  }
  const prevEnd = prev.mediaSequence + prev.segments.length;
  const advanced = currEnd > prevEnd;
  const newSegments = curr.segments.filter((s) => s.seq >= prevEnd);
  // The window start jumping beyond everything we ever saw = unseen media.
  const droppedSegments = Math.max(0, curr.mediaSequence - prevEnd);
  const newDiscontinuityTags = newSegments.filter((s) => s.discontinuity).length;
  return { advanced, newSegments, droppedSegments, newDiscontinuityTags };
}

/**
 * Measured delivery bitrate over the NEW segments of one poll.
 * @param {{ bytes: number, duration: number }[]} newSegs  byte size + EXTINF
 *   seconds per new segment (caller stat()s the files).
 * @returns {number|null} kbps, or null when nothing new / no duration.
 */
export function measuredKbps(newSegs) {
  let bytes = 0;
  let seconds = 0;
  for (const s of newSegs ?? []) {
    if (!s || !Number.isFinite(s.bytes) || !Number.isFinite(s.duration)) continue;
    bytes += Math.max(0, s.bytes);
    seconds += Math.max(0, s.duration);
  }
  if (seconds <= 0 || bytes <= 0) return null;
  return Math.round((bytes * 8) / seconds / 1000);
}
