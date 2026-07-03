/**
 * Unit specs for the deface overlay helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  debounceEmpty,
  effectiveFaces,
  expandFace,
  faceIou,
  faceToPixels,
  blurRadius,
  EMPTY_STREAK_HOLD_COUNT,
  EMPTY_STREAK_HOLD_MS,
  INITIAL_EMPTY_STREAK,
  maskBorderRadius,
  mosaicGrid,
  parseLivePayload,
  pollIntervalMs,
  resetTrackIds,
  resolveObjectFit,
  resolveSettings,
  scoreLabel,
  smoothingAlpha,
  staleAfterMs,
  stepTracks,
  updateTracks,
  videoContentRect,
  type EmptyStreakState,
  type Face,
  type Rect,
} from './overlay.util.ts'

const face = (x: number, y: number, w: number, h: number, score = 0.9): Face => ({
  x,
  y,
  w,
  h,
  score,
})

beforeEach(() => resetTrackIds())

// --- settings ----------------------------------------------------------------

test('resolveSettings: defaults mirror the backend schema', () => {
  assert.deepEqual(resolveSettings({}), {
    replacewith: 'blur',
    boxes: false,
    maskScale: 1.3,
    mosaicSize: 20,
    drawScores: false,
    fps: 2,
  })
})

test('resolveSettings: accepts valid values incl. string booleans, clamps numbers', () => {
  const s = resolveSettings({
    replacewith: 'mosaic',
    boxes: 'true',
    maskScale: 99,
    mosaicSize: 1,
    drawScores: true,
    fps: 0,
  })
  assert.equal(s.replacewith, 'mosaic')
  assert.equal(s.boxes, true)
  assert.equal(s.maskScale, 3) // clamped to schema max
  assert.equal(s.mosaicSize, 2) // clamped to schema min
  assert.equal(s.drawScores, true)
  assert.equal(s.fps, 0.1)
})

test('resolveSettings: garbage falls back to safe defaults', () => {
  const s = resolveSettings({ replacewith: 'acid', maskScale: 'NaNish', boxes: 'yep' })
  assert.equal(s.replacewith, 'blur')
  assert.equal(s.maskScale, 1.3)
  assert.equal(s.boxes, false)
})

// --- payload parsing -----------------------------------------------------------

test('parseLivePayload: accepts the worker shape and clamps coords', () => {
  const parsed = parseLivePayload({
    app: 'live',
    room: 'main',
    ts: 1,
    maskScale: 1.3,
    faces: [
      { bbox: [0.1, 0.2, 0.3, 0.4], score: 0.87 },
      { bbox: [0.9, 0.9, 0.5, 0.5], score: 2 }, // overflows → clamped to unit square
    ],
  })
  assert.ok(parsed)
  assert.equal(parsed.maskScale, 1.3)
  assert.deepEqual(parsed.faces[0], { x: 0.1, y: 0.2, w: 0.3, h: 0.4, score: 0.87 })
  const f1 = parsed.faces[1]
  assert.ok(f1.x + f1.w <= 1 && f1.y + f1.h <= 1)
  assert.equal(f1.score, 1) // score clamped
})

test('parseLivePayload: drops malformed faces, rejects non-payloads', () => {
  assert.equal(parseLivePayload(null), null)
  assert.equal(parseLivePayload('nope'), null)
  assert.equal(parseLivePayload({ notFaces: [] }), null)
  const parsed = parseLivePayload({
    faces: [
      null,
      { bbox: 'x' },
      { bbox: [0.1, 0.1] },
      { bbox: [0.1, 0.1, NaN, 0.2], score: 0.5 },
      { bbox: [0.5, 0.5, 0, 0.2], score: 0.5 }, // zero width → dropped
      { bbox: [0.2, 0.2, 0.2, 0.2] }, // missing score → 0
    ],
  })
  assert.ok(parsed)
  assert.equal(parsed.faces.length, 1)
  assert.equal(parsed.faces[0].score, 0)
  assert.equal(parsed.maskScale, undefined)
})

// --- mask-scale expansion (applied exactly once) ---------------------------------

test('expandFace: deface scale_bb semantics, clamped to the unit square', () => {
  // w=0.2,h=0.2 at (0.4,0.4); scale 1.5 → each side moves out by 0.1
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`)
  const out = expandFace(face(0.4, 0.4, 0.2, 0.2), 1.5)
  close(out.x, 0.3)
  close(out.y, 0.3)
  close(out.w, 0.4)
  close(out.h, 0.4)
  assert.equal(out.score, 0.9)
  // scale 1.0 → unchanged (within fp noise)
  const same = expandFace(face(0.4, 0.4, 0.2, 0.2), 1)
  close(same.x, 0.4)
  close(same.y, 0.4)
  close(same.w, 0.2)
  close(same.h, 0.2)
  // near the edge → clamped
  const edge = expandFace(face(0, 0, 0.2, 0.2), 2)
  assert.equal(edge.x, 0)
  assert.equal(edge.y, 0)
})

test('effectiveFaces: pre-expanded payloads pass through; others expand client-side', () => {
  const settings = resolveSettings({ maskScale: 2 })
  const f = face(0.4, 0.4, 0.2, 0.2)
  // Worker declared maskScale → already expanded → untouched.
  assert.deepEqual(effectiveFaces({ faces: [f], maskScale: 1.3 }, settings), [f])
  // No maskScale in payload (external poster) → expanded with config value.
  const [expanded] = effectiveFaces({ faces: [f] }, settings)
  assert.ok(expanded.w > f.w && expanded.h > f.h)
})

// --- polling policy ---------------------------------------------------------------

test('pollIntervalMs / staleAfterMs: follow fps within bounds', () => {
  assert.equal(pollIntervalMs(2), 500)
  assert.equal(pollIntervalMs(30), 200) // floor
  assert.equal(pollIntervalMs(0.2), 1000) // ceiling
  assert.equal(staleAfterMs(2), 2000) // 3 periods, floored at 2s
  assert.equal(staleAfterMs(1), 3000)
  assert.equal(staleAfterMs(0.1), 6000) // capped
})

// --- tracks: identity, hold, smoothing ----------------------------------------------

test('updateTracks: new faces appear immediately as tracks', () => {
  const tracks = updateTracks([], [face(0.1, 0.1, 0.2, 0.2)], 1000, { holdMs: 900 })
  assert.equal(tracks.length, 1)
  assert.deepEqual(tracks[0].cur, tracks[0].target)
})

test('updateTracks: a moved face keeps its track identity (eases, not teleports)', () => {
  const t0 = updateTracks([], [face(0.1, 0.1, 0.2, 0.2)], 0, { holdMs: 900 })
  const moved = face(0.15, 0.12, 0.2, 0.2)
  const t1 = updateTracks(t0, [moved], 500, { holdMs: 900 })
  assert.equal(t1.length, 1)
  assert.equal(t1[0].id, t0[0].id)
  assert.deepEqual(t1[0].target, moved) // target updated…
  assert.deepEqual(t1[0].cur, t0[0].cur) // …but the rendered box hasn't jumped
})

test('updateTracks: unmatched tracks are HELD (privacy) then dropped', () => {
  const t0 = updateTracks([], [face(0.1, 0.1, 0.2, 0.2)], 0, { holdMs: 900 })
  const held = updateTracks(t0, [], 500, { holdMs: 900 })
  assert.equal(held.length, 1) // detector flicker → keep masking
  const dropped = updateTracks(held, [], 1000, { holdMs: 900 })
  assert.equal(dropped.length, 0)
})

test('updateTracks: two faces match their nearest tracks (greedy affinity)', () => {
  const a = face(0.1, 0.1, 0.2, 0.2)
  const b = face(0.7, 0.7, 0.2, 0.2)
  const t0 = updateTracks([], [a, b], 0, { holdMs: 900 })
  // Slightly moved, delivered in swapped order.
  const a2 = face(0.12, 0.1, 0.2, 0.2)
  const b2 = face(0.68, 0.72, 0.2, 0.2)
  const t1 = updateTracks(t0, [b2, a2], 500, { holdMs: 900 })
  const byId = new Map(t1.map((t) => [t.id, t.target]))
  assert.deepEqual(byId.get(t0[0].id), a2)
  assert.deepEqual(byId.get(t0[1].id), b2)
})

test('updateTracks: far-away face becomes a NEW track, old one holds', () => {
  const t0 = updateTracks([], [face(0.1, 0.1, 0.1, 0.1)], 0, { holdMs: 900 })
  const t1 = updateTracks(t0, [face(0.8, 0.8, 0.1, 0.1)], 100, { holdMs: 900 })
  assert.equal(t1.length, 2)
  assert.notEqual(t1[0].id, t0[0].id)
})

test('faceIou: overlap math', () => {
  assert.equal(faceIou(face(0, 0, 0.5, 0.5), face(0, 0, 0.5, 0.5)), 1)
  assert.equal(faceIou(face(0, 0, 0.2, 0.2), face(0.5, 0.5, 0.2, 0.2)), 0)
})

test('smoothingAlpha: frame-rate independent exponential approach', () => {
  assert.equal(smoothingAlpha(0, 150), 0)
  assert.equal(smoothingAlpha(100, 0), 1)
  const a16 = smoothingAlpha(16, 150)
  const a32 = smoothingAlpha(32, 150)
  assert.ok(a16 > 0 && a16 < a32 && a32 < 1)
  // Two 16ms steps ≈ one 32ms step (compounding property of exp smoothing).
  const twoSteps = 1 - (1 - a16) * (1 - a16)
  assert.ok(Math.abs(twoSteps - a32) < 1e-9)
})

test('stepTracks: eases towards the target and settles exactly', () => {
  let tracks = updateTracks([], [face(0.1, 0.1, 0.2, 0.2)], 0, { holdMs: 900 })
  // Overlapping move → SAME track, new target.
  tracks = updateTracks(tracks, [face(0.2, 0.18, 0.2, 0.2)], 100, { holdMs: 900 })
  assert.equal(tracks.length, 1)
  const before = tracks[0].cur.x
  tracks = stepTracks(tracks, 50, 150)
  assert.ok(tracks[0].cur.x > before && tracks[0].cur.x < 0.2)
  // Run long enough → snaps onto the target and then returns the SAME array.
  for (let i = 0; i < 60; i++) tracks = stepTracks(tracks, 100, 150)
  assert.deepEqual(tracks[0].cur, tracks[0].target)
  const settled = stepTracks(tracks, 16, 150)
  assert.equal(settled, tracks)
})

// --- empty-payload hysteresis (anti-flapping) ----------------------------------------
//
// Regression coverage for: on a static stream the worker's payload alternated
// 3 faces ↔ 0 faces between samples, and the old "hold unmatched tracks for
// holdMs" easing wasn't a strong enough gate — a single empty sample could
// still start the countdown towards unmasking. debounceEmpty sits in FRONT of
// updateTracks and only lets a genuinely sustained empty streak through.

test('debounceEmpty: a lone empty payload is suppressed (faces: null), not cleared', () => {
  const r = debounceEmpty([], INITIAL_EMPTY_STREAK, 0)
  assert.equal(r.faces, null)
  assert.deepEqual(r.state, { count: 1, since: 0 })
})

test('debounceEmpty: empty-empty-empty clears — the streak only confirms on the Nth empty', () => {
  let state: EmptyStreakState = INITIAL_EMPTY_STREAK
  const results: (readonly Face[] | null)[] = []
  // Three consecutive empty updates, 500ms apart (well under EMPTY_STREAK_HOLD_MS).
  for (let i = 0; i < EMPTY_STREAK_HOLD_COUNT; i++) {
    const r = debounceEmpty([], state, i * 500)
    state = r.state
    results.push(r.faces)
  }
  // Every empty before the Nth is suppressed…
  assert.deepEqual(results.slice(0, -1), Array(EMPTY_STREAK_HOLD_COUNT - 1).fill(null))
  // …only the Nth (count reaches EMPTY_STREAK_HOLD_COUNT) confirms the streak.
  assert.deepEqual(results[results.length - 1], [])
  assert.equal(state.count, EMPTY_STREAK_HOLD_COUNT)
})

test('debounceEmpty: empty-detect keeps + rematches — a real detection resets the streak instantly', () => {
  const f = face(0.3, 0.3, 0.2, 0.2)
  const afterOneEmpty = debounceEmpty([], INITIAL_EMPTY_STREAK, 0)
  assert.equal(afterOneEmpty.faces, null) // held, not cleared
  const detect = debounceEmpty([f], afterOneEmpty.state, 200)
  assert.deepEqual(detect.faces, [f]) // passes straight through, unchanged
  assert.deepEqual(detect.state, INITIAL_EMPTY_STREAK) // streak fully reset
  // A subsequent lone empty starts a brand-new streak (count 1), proving the
  // previous near-miss didn't linger.
  const next = debounceEmpty([], detect.state, 400)
  assert.deepEqual(next.state, { count: 1, since: 400 })
})

test('debounceEmpty: timestamp-based streak — an unbroken empty run releases at EMPTY_STREAK_HOLD_MS even under the count threshold', () => {
  // Two empty updates, but far apart in time: the count threshold (3) is
  // never reached, yet the elapsed-time threshold fires on the 2nd call.
  // `now` is an explicit parameter (no Date.now()/performance.now() inside
  // debounceEmpty) precisely so streak timing is deterministic here without
  // fake timers — an injectable clock by construction.
  const first = debounceEmpty([], INITIAL_EMPTY_STREAK, 1_000)
  assert.equal(first.faces, null)
  assert.equal(first.state.count, 1)
  const second = debounceEmpty([], first.state, 1_000 + EMPTY_STREAK_HOLD_MS)
  assert.equal(second.state.count, 2) // count threshold (3) not reached…
  assert.deepEqual(second.faces, []) // …but the time threshold released it
})

test('debounceEmpty: released streak keeps reporting faces: [] until the next real detection', () => {
  let state: EmptyStreakState = INITIAL_EMPTY_STREAK
  for (let i = 0; i < EMPTY_STREAK_HOLD_COUNT; i++) {
    state = debounceEmpty([], state, i * 500).state
  }
  const again = debounceEmpty([], state, 10_000)
  assert.deepEqual(again.faces, []) // still confirmed-empty, not re-suppressed
})

test('integration: debounceEmpty + updateTracks — flapping 3-faces/0-faces payloads never blink the rendered tracks', () => {
  const holdMs = 3000
  const faces3 = [
    face(0.1, 0.1, 0.1, 0.1),
    face(0.5, 0.5, 0.1, 0.1),
    face(0.8, 0.2, 0.1, 0.1),
  ]
  let streak: EmptyStreakState = INITIAL_EMPTY_STREAK
  let tracks: ReturnType<typeof updateTracks> = []
  const feed = (faces: Face[], now: number) => {
    const r = debounceEmpty(faces, streak, now)
    streak = r.state
    if (r.faces === null) return // suppressed — tracks left exactly as-is
    tracks = updateTracks(tracks, r.faces, now, { holdMs })
  }

  feed(faces3, 0) // detector sees 3 faces
  assert.equal(tracks.length, 3)
  // Detector flaps to 0 faces, then back to 3, repeatedly — the reported bug.
  for (let i = 1; i <= 4; i++) {
    feed([], i * 1000 - 500) // empty sample
    assert.equal(tracks.length, 3, `flap ${i}: masks must not blink on a single empty`)
    feed(faces3, i * 1000) // detector recovers
    assert.equal(tracks.length, 3, `flap ${i}: recovered faces keep the same 3 tracks`)
  }

  // Now the faces are genuinely gone for a sustained run: 3 consecutive
  // empty samples (streak confirms), then long enough past holdMs to drop.
  feed([], 5000)
  feed([], 5500)
  feed([], 6000) // 3rd consecutive empty → streak confirmed → reaches updateTracks
  assert.equal(tracks.length, 3) // still within holdMs of the last real sighting (4000)
  feed([], 7100) // now - lastSeen(4000) > holdMs(3000) → finally released
  assert.equal(tracks.length, 0)
})

// --- render geometry ------------------------------------------------------------------

const closeRect = (a: Rect, b: Rect, eps = 1e-6) => {
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    assert.ok(Math.abs(a[k] - b[k]) < eps, `${k}: ${a[k]} !~ ${b[k]} (${JSON.stringify(a)})`)
  }
}

// Table-driven: containerW×H (the <video> element's OWN rendered box) ×
// videoW×H (intrinsic) × fit → the exact content rect. Covers identity,
// letterbox (top/bottom bars), pillarbox (left/right bars), unknown size,
// and `cover` (crops instead of bars — offsets go negative).
const CONTENT_RECT_CASES: { name: string; args: Parameters<typeof videoContentRect>; want: Rect }[] = [
  {
    name: 'contain: 16:9 video in a 16:9 element → identity, no bars',
    args: [1280, 720, 1920, 1080, 'contain'],
    want: { x: 0, y: 0, w: 1280, h: 720 },
  },
  {
    name: 'contain: 16:9 video in a 4:3 element → letterboxed top/bottom',
    args: [800, 600, 1920, 1080, 'contain'],
    want: { x: 0, y: 75, w: 800, h: 450 },
  },
  {
    name: 'contain: 9:16 video in a 16:9 element → pillarboxed left/right',
    args: [1280, 720, 1080, 1920, 'contain'],
    want: { x: 437.5, y: 0, w: 405, h: 720 },
  },
  {
    name: 'contain: default fit param behaves like contain (back-compat)',
    args: [800, 600, 1920, 1080],
    want: { x: 0, y: 75, w: 800, h: 450 },
  },
  {
    name: 'cover: 16:9 video in a 16:9 element → identity (aspect matches, no crop)',
    args: [1280, 720, 1920, 1080, 'cover'],
    want: { x: 0, y: 0, w: 1280, h: 720 },
  },
  {
    name: 'cover: 16:9 video in a 4:3 element → cropped left/right (negative x offset)',
    args: [800, 600, 1920, 1080, 'cover'],
    want: { x: -400 / 3, y: 0, w: 800 + 800 / 3, h: 600 },
  },
  {
    name: 'cover: 9:16 video in a 16:9 element → cropped top/bottom (negative y offset)',
    args: [1280, 720, 1080, 1920, 'cover'],
    want: { x: 0, y: -7000 / 9, h: 1280 * (1920 / 1080), w: 1280 },
  },
  {
    name: 'unknown intrinsic size (0) → content fills the element box regardless of fit',
    args: [800, 450, 0, 0, 'cover'],
    want: { x: 0, y: 0, w: 800, h: 450 },
  },
  {
    name: 'zero-size container → degenerate empty rect',
    args: [0, 0, 1920, 1080, 'contain'],
    want: { x: 0, y: 0, w: 0, h: 0 },
  },
]

for (const c of CONTENT_RECT_CASES) {
  test(`videoContentRect: ${c.name}`, () => {
    closeRect(videoContentRect(...c.args), c.want)
  })
}

// Table-driven: mapping normalized face boxes at the corners + center of the
// VIDEO FRAME through a letterboxed content rect (contain, 16:9-in-4:3 from
// the table above: { x: 0, y: 75, w: 800, h: 450 }) into exact CSS pixels.
const LETTERBOXED_CONTENT: Rect = { x: 0, y: 75, w: 800, h: 450 }
const CORNER_FACE_CASES: { name: string; f: Face; want: Rect }[] = [
  { name: 'top-left corner', f: face(0, 0, 0.1, 0.1), want: { x: 0, y: 75, w: 80, h: 45 } },
  { name: 'top-right corner', f: face(0.9, 0, 0.1, 0.1), want: { x: 720, y: 75, w: 80, h: 45 } },
  { name: 'bottom-left corner', f: face(0, 0.9, 0.1, 0.1), want: { x: 0, y: 480, w: 80, h: 45 } },
  { name: 'bottom-right corner', f: face(0.9, 0.9, 0.1, 0.1), want: { x: 720, y: 480, w: 80, h: 45 } },
  { name: 'center', f: face(0.45, 0.45, 0.1, 0.1), want: { x: 360, y: 277.5, w: 80, h: 45 } },
]

for (const c of CORNER_FACE_CASES) {
  test(`faceToPixels: ${c.name} of a letterboxed video frame`, () => {
    closeRect(faceToPixels(c.f, LETTERBOXED_CONTENT), c.want)
  })
}

test('faceToPixels: maps normalized coords into the content rect', () => {
  const content = { x: 0, y: 100, w: 1000, h: 562.5 }
  assert.deepEqual(faceToPixels(face(0.1, 0.2, 0.3, 0.4), content), {
    x: 100,
    y: 100 + 112.5,
    w: 300,
    h: 225,
  })
})

test('resolveObjectFit: only "cover" maps to cover, everything else falls back to contain', () => {
  assert.equal(resolveObjectFit('cover'), 'cover')
  assert.equal(resolveObjectFit('contain'), 'contain')
  assert.equal(resolveObjectFit('fill'), 'contain')
  assert.equal(resolveObjectFit('none'), 'contain')
  assert.equal(resolveObjectFit('scale-down'), 'contain')
  assert.equal(resolveObjectFit(''), 'contain')
  assert.equal(resolveObjectFit(null), 'contain')
  assert.equal(resolveObjectFit(undefined), 'contain')
})

// Regression: the reported bug. The overlay used to feed the OVERLAY ROOT's
// box (a sibling of the video stage, mounted at the player-frame level) into
// the object-fit math as if it were the <video> element's own box. Real
// layouts (e.g. StreamHub's own VideoStage) pad/center the <video> inside
// that root, so the two boxes differ — but because both are centered on the
// same point, the discrepancy is ZERO at the frame center and grows towards
// the edges: exactly "matched the center face, offset the outer two faces".
test('regression: composing the video-element box (not the root/frame box) fixes center-only-correct alignment', () => {
  // Root ("Frame"): 1280×720. Actual <video> box ("Tile"): 800/975*720? no —
  // just a smaller, centered, same-aspect box inset by CSS padding: 1200×675,
  // offset (40, 22.5) from the root's top-left. Intrinsic 1920×1080 (16:9,
  // matches the Tile's own aspect exactly) rendered with object-fit: cover —
  // StreamHub's real camera-tile CSS (VideoStage.tsx uses `object-cover`).
  const rootBox = { left: 0, top: 0, width: 1280, height: 720 }
  const videoBox = { left: 40, top: 22.5, width: 1200, height: 675 }
  const fit = resolveObjectFit('cover')
  const inner = videoContentRect(videoBox.width, videoBox.height, 1920, 1080, fit)
  const content: Rect = {
    x: videoBox.left - rootBox.left + inner.x,
    y: videoBox.top - rootBox.top + inner.y,
    w: inner.w,
    h: inner.h,
  }
  // Aspect matches exactly → cover doesn't crop → content fills the Tile.
  closeRect(content, { x: 40, y: 22.5, w: 1200, h: 675 })

  // The OLD buggy mapping: treat the root box as if it were the content box
  // directly (no video-element offset, contain-only, ignores the real fit).
  const buggyContent = videoContentRect(rootBox.width, rootBox.height, 1920, 1080)
  // Root is also 16:9 (aspect-video), matching the video's intrinsic aspect,
  // so the buggy "contain" pass produces NO letterbox bars either — it just
  // silently assumes the content fills the whole root, 40px too far out.
  closeRect(buggyContent, { x: 0, y: 0, w: 1280, h: 720 })

  const centerFace = face(0.5, 0.5, 0.02, 0.02)
  const edgeFace = face(0, 0.5, 0.02, 0.02) // left edge of the video frame

  const centerFixed = faceToPixels(centerFace, content)
  const centerBuggy = faceToPixels(centerFace, buggyContent)
  // Center face: fixed and buggy mapping AGREE — this is why the bug looked
  // like a match in the middle of the frame during live validation.
  assert.ok(Math.abs(centerFixed.x - centerBuggy.x) < 1e-9)
  assert.ok(Math.abs(centerFixed.y - centerBuggy.y) < 1e-9)

  const edgeFixed = faceToPixels(edgeFace, content)
  const edgeBuggy = faceToPixels(edgeFace, buggyContent)
  // Left-edge face: the buggy mapping lands 40px further left than the
  // correct one — the exact CSS padding inset the old code never accounted
  // for. This is the "offset on the outer faces" from the bug report.
  closeRect(edgeFixed, { x: 40, y: 22.5 + 0.5 * 675, w: 0.02 * 1200, h: 0.02 * 675 })
  assert.ok(Math.abs(edgeFixed.x - edgeBuggy.x - 40) < 1e-9)
})

test('mosaicGrid: one cell per mosaicSize px, floor of 1x1', () => {
  assert.deepEqual(mosaicGrid(100, 60, 20), { cols: 5, rows: 3 })
  assert.deepEqual(mosaicGrid(10, 10, 20), { cols: 1, rows: 1 })
  assert.deepEqual(mosaicGrid(100, 100, 0), { cols: 50, rows: 50 }) // size floored at 2
})

test('blurRadius / maskBorderRadius / scoreLabel', () => {
  assert.equal(blurRadius(30), 8) // floor
  assert.equal(blurRadius(300), 50)
  assert.equal(maskBorderRadius(false), '50%')
  assert.equal(maskBorderRadius(true), '6%')
  assert.equal(scoreLabel(0.874), '87%')
  assert.equal(scoreLabel(7), '100%')
})
