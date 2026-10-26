/**
 * MPEG-TS continuity-counter analysis — PURE (Buffer in, counters out).
 *
 * An MPEG-TS segment is a run of 188-byte packets, each starting with the
 * 0x47 sync byte. Per PID, the 4-bit continuity counter (low nibble of byte
 * 3) increments by one for every packet CARRYING PAYLOAD; a skip means
 * packets were lost or the mux glitched — exactly the "packet loss /
 * discontinuity" signal the mission asks for, and invisible to playlist-level
 * checks. The adaptation field's discontinuity_indicator legitimately resets
 * the counter, so it is honored, as are duplicate packets (the spec allows
 * one identical repeat with the same CC).
 *
 * The caller bounds the read (a few MB of the newest segment) — this module
 * never touches the filesystem.
 */

export const TS_PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
const NULL_PID = 0x1fff;

/**
 * Analyze a TS buffer.
 * @param {Buffer|Uint8Array} buf
 * @returns {{
 *   packets: number,        // TS packets inspected
 *   ccErrors: number,       // continuity-counter skips (≈ lost packets)
 *   syncLosses: number,     // times the 0x47 sync was lost (resynced by scan)
 *   pids: number,           // distinct non-null PIDs seen
 * }}
 */
export function analyzeTsContinuity(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(0);
  /** @type {Map<number, number>} last CC per PID */
  const lastCc = new Map();
  let packets = 0;
  let ccErrors = 0;
  let syncLosses = 0;

  let i = 0;
  while (i + TS_PACKET_SIZE <= b.length) {
    if (b[i] !== SYNC_BYTE) {
      // Lost sync: scan forward to the next plausible packet boundary.
      syncLosses++;
      let j = i + 1;
      while (j + TS_PACKET_SIZE <= b.length && b[j] !== SYNC_BYTE) j++;
      i = j;
      continue;
    }
    packets++;
    const pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2];
    const afc = (b[i + 3] >> 4) & 0x3;
    const cc = b[i + 3] & 0x0f;
    const hasPayload = (afc & 0x1) === 1;
    const hasAdaptation = (afc & 0x2) === 2;

    // discontinuity_indicator: adaptation field present, non-zero length,
    // top bit of the flags byte.
    let discontinuityFlag = false;
    if (hasAdaptation) {
      const afLen = b[i + 4];
      if (afLen > 0) discontinuityFlag = (b[i + 5] & 0x80) !== 0;
    }

    if (pid !== NULL_PID) {
      const prev = lastCc.get(pid);
      if (hasPayload) {
        if (prev !== undefined && !discontinuityFlag) {
          const expected = (prev + 1) & 0x0f;
          // A duplicate (same CC as last) is legal once — not an error.
          if (cc !== expected && cc !== prev) ccErrors++;
        }
        lastCc.set(pid, cc);
      }
      // Packets without payload do not increment CC — leave state as-is.
    }
    i += TS_PACKET_SIZE;
  }

  return { packets, ccErrors, syncLosses, pids: lastCc.size };
}

/** True when a segment file name looks like raw MPEG-TS (CC analysis applies). */
export function isTsSegment(uri) {
  return /\.ts(\?.*)?$/i.test(String(uri ?? ''));
}
