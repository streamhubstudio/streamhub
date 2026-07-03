/**
 * Pure helpers for the deface face-obfuscation overlay.
 *
 * Framework-agnostic (no React, no DOM) so every branch is unit-tested with
 * Node's built-in runner — the overlay component (index.tsx) is a thin shell
 * around these (same pattern as the timestamp plugin's overlay.util.ts):
 *
 *   - settings resolution from the (sanitized public) plugin config,
 *   - live-payload parsing/clamping (worker → GET :id/live → here),
 *   - mask-scale expansion (deface `scale_bb` semantics, applied ONCE:
 *     payloads that declare `maskScale` are already expanded worker-side),
 *   - face TRACKS with hold + exponential smoothing, so masks don't flicker
 *     or teleport between low-FPS detector updates,
 *   - an empty-payload HYSTERESIS gate in front of the tracker: a detector
 *     that flaps between N faces and 0 faces on a static scene must not
 *     blink the masks — only a sustained empty streak releases held tracks,
 *   - letterbox/pillarbox/crop math for BOTH `object-fit: contain` and
 *     `object-fit: cover`, mapping normalized face coords (in video-frame
 *     space) to pixel rects inside the actual rendered `<video>` box,
 *   - mosaic grid / blur radius / border-radius mask geometry.
 */
import type { ConfigValues } from '../types.ts'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ReplaceWith = 'blur' | 'mosaic' | 'solid' | 'none'

export interface DefaceSettings {
  replacewith: ReplaceWith
  /** true = rectangles, false = ellipses (deface default). */
  boxes: boolean
  maskScale: number
  mosaicSize: number
  drawScores: boolean
  /** Worker sample FPS — drives the poll interval + staleness window. */
  fps: number
}

const REPLACE_WITH = new Set<ReplaceWith>(['blur', 'mosaic', 'solid', 'none'])

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Fold the raw persisted config bag into safe, defaulted overlay settings. */
export function resolveSettings(config: ConfigValues): DefaceSettings {
  const raw = typeof config.replacewith === 'string' ? config.replacewith : ''
  return {
    replacewith: REPLACE_WITH.has(raw as ReplaceWith)
      ? (raw as ReplaceWith)
      : 'blur',
    boxes: bool(config.boxes, false),
    maskScale: num(config.maskScale, 1.3, 1, 3),
    mosaicSize: num(config.mosaicSize, 20, 2, 200),
    drawScores: bool(config.drawScores, false),
    fps: num(config.fps, 2, 0.1, 30),
  }
}

// ---------------------------------------------------------------------------
// Live payload parsing
// ---------------------------------------------------------------------------

/** One face region in NORMALIZED (0–1) coords relative to the video frame. */
export interface Face {
  x: number
  y: number
  w: number
  h: number
  score: number
}

export interface ParsedPayload {
  faces: Face[]
  /** Present (>= 1) when the worker already applied the mask-scale expansion. */
  maskScale?: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/**
 * Parse + sanitize the worker payload from GET :id/live. Returns null when the
 * payload is not a deface face payload at all; malformed faces are dropped and
 * every coordinate is clamped into the unit square (a hostile/buggy payload
 * must never place masks outside the player or produce NaN CSS).
 */
export function parseLivePayload(raw: unknown): ParsedPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.faces)) return null
  const faces: Face[] = []
  for (const item of obj.faces) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const bbox = f.bbox
    if (!Array.isArray(bbox) || bbox.length < 4) continue
    const [x, y, w, h] = bbox.map(Number)
    if (![x, y, w, h].every(Number.isFinite)) continue
    const cx = clamp01(x)
    const cy = clamp01(y)
    const cw = Math.min(clamp01(w), 1 - cx)
    const ch = Math.min(clamp01(h), 1 - cy)
    if (cw <= 0 || ch <= 0) continue
    const score = Number.isFinite(Number(f.score)) ? clamp01(Number(f.score)) : 0
    faces.push({ x: cx, y: cy, w: cw, h: ch, score })
  }
  const ms = Number(obj.maskScale)
  return {
    faces,
    maskScale: Number.isFinite(ms) && ms >= 1 ? ms : undefined,
  }
}

/**
 * Grow a face box about its center by deface's `scale_bb` rule (each side
 * moves out by (scale - 1) × that dimension), clamped to the unit square.
 */
export function expandFace(face: Face, maskScale: number): Face {
  const s = Math.max(0, maskScale - 1)
  const x = clamp01(face.x - face.w * s)
  const y = clamp01(face.y - face.h * s)
  const x2 = clamp01(face.x + face.w * (1 + s))
  const y2 = clamp01(face.y + face.h * (1 + s))
  return { x, y, w: x2 - x, h: y2 - y, score: face.score }
}

/**
 * The faces to actually mask. The expansion is applied exactly ONCE: when the
 * payload declares `maskScale` the worker already expanded the boxes (StreamHub
 * deface-worker does), so they pass through; a payload without it (external
 * poster) is expanded client-side with the configured maskScale.
 */
export function effectiveFaces(
  parsed: ParsedPayload,
  settings: DefaceSettings,
): Face[] {
  if (parsed.maskScale !== undefined) return parsed.faces
  return parsed.faces.map((f) => expandFace(f, settings.maskScale))
}

// ---------------------------------------------------------------------------
// Freshness / polling policy
// ---------------------------------------------------------------------------

/** Poll the live endpoint about as fast as the worker samples, within reason. */
export function pollIntervalMs(fps: number): number {
  const period = 1000 / Math.max(0.1, fps)
  return Math.min(1000, Math.max(200, Math.round(period)))
}

/**
 * How old a payload may be before the overlay must clear its masks: stale
 * boxes are WRONG boxes (the face has moved), so ~3 worker periods, bounded.
 */
export function staleAfterMs(fps: number): number {
  const period = 1000 / Math.max(0.1, fps)
  return Math.min(6000, Math.max(2000, Math.round(3 * period)))
}

// ---------------------------------------------------------------------------
// Tracks: identity + hold + smoothing (anti-flicker between updates)
// ---------------------------------------------------------------------------

export interface Track {
  id: number
  /** Currently RENDERED box (smoothed). */
  cur: Face
  /** Latest detector box the render is easing towards. */
  target: Face
  /** ms timestamp of the last detector update that matched this track. */
  lastSeen: number
}

function center(f: Face): [number, number] {
  return [f.x + f.w / 2, f.y + f.h / 2]
}

/** IoU of two normalized boxes (0 when disjoint). */
export function faceIou(a: Face, b: Face): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  if (inter <= 0) return 0
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** Match quality: IoU first, else closeness of centers (for jumpy low FPS). */
function affinity(a: Face, b: Face): number {
  const overlap = faceIou(a, b)
  if (overlap > 0) return 1 + overlap
  const [ax, ay] = center(a)
  const [bx, by] = center(b)
  const dist = Math.hypot(ax - bx, ay - by)
  // Only consider "same face" when centers are within ~a face width.
  const reach = Math.max(a.w, a.h, b.w, b.h)
  return dist <= reach ? 1 - dist : 0
}

export interface TrackOptions {
  /** Keep an unmatched track alive this long (over-mask rather than flicker). */
  holdMs: number
}

let nextTrackId = 1
/** Test hook: make generated ids deterministic. */
export function resetTrackIds(): void {
  nextTrackId = 1
}

/**
 * Fold a fresh detector result into the current tracks:
 *   - each face claims its best-matching track (greedy, by affinity) so the
 *     mask KEEPS ITS IDENTITY and eases to the new position,
 *   - unclaimed faces spawn new tracks (appear immediately — never delay a
 *     privacy mask),
 *   - tracks with no face stay for `holdMs` (detector flicker must not unmask
 *     a face that is still there), then drop.
 * Pure: returns a NEW array; never mutates the inputs.
 */
export function updateTracks(
  tracks: readonly Track[],
  faces: readonly Face[],
  now: number,
  opts: TrackOptions,
): Track[] {
  const claimed = new Set<number>()
  const next: Track[] = []

  for (const face of faces) {
    let best: Track | null = null
    let bestScore = 0
    for (const t of tracks) {
      if (claimed.has(t.id)) continue
      const a = affinity(t.target, face)
      if (a > bestScore) {
        best = t
        bestScore = a
      }
    }
    if (best) {
      claimed.add(best.id)
      next.push({ ...best, target: face, lastSeen: now })
    } else {
      next.push({ id: nextTrackId++, cur: face, target: face, lastSeen: now })
    }
  }

  for (const t of tracks) {
    if (claimed.has(t.id)) continue
    if (now - t.lastSeen < opts.holdMs) next.push(t)
  }
  return next
}

// ---------------------------------------------------------------------------
// Empty-payload hysteresis (anti-flapping gate in front of the tracker)
// ---------------------------------------------------------------------------

/**
 * An empty detector payload is only trusted as "no faces here" after a
 * SUSTAINED streak — either this many consecutive empty updates...
 */
export const EMPTY_STREAK_HOLD_COUNT = 3
/** ...or an unbroken empty run lasting at least this many ms, whichever comes first. */
export const EMPTY_STREAK_HOLD_MS = 1500

export interface EmptyStreakState {
  /** Consecutive empty (zero-face) updates seen since the last non-empty one. */
  count: number
  /** ms timestamp of the first empty update in the current streak (null = no streak). */
  since: number | null
}

/** Fresh state: no empty streak in progress. */
export const INITIAL_EMPTY_STREAK: EmptyStreakState = { count: 0, since: null }

/**
 * Debounce empty detector payloads before they are allowed to age out
 * tracks. A single "0 faces" sample from a flappy detector (payload
 * alternating N faces ↔ 0 faces between samples on an otherwise static
 * scene) must NOT start releasing held masks — that's the flicker this
 * plugin exists to prevent. Only a sustained empty streak does:
 * `EMPTY_STREAK_HOLD_COUNT` consecutive empty updates, or an unbroken empty
 * run of `EMPTY_STREAK_HOLD_MS`, whichever is reached first.
 *
 * A non-empty payload resets the streak immediately and passes straight
 * through — a real re-appearance (or the detector recovering) is never
 * delayed; `updateTracks` re-matches/spawns those faces instantly, same as
 * always.
 *
 * Pure + clock-injected (`now` is a parameter, never read internally) so
 * streak timing is deterministic under node:test without fake timers.
 *
 * Returns:
 *   - `faces: null`   → streak not yet confirmed; caller should skip this
 *                        tick entirely (leave existing tracks untouched).
 *   - `faces: []`      → streak confirmed; caller should feed this through
 *                        `updateTracks` as usual (which applies its own
 *                        per-track `holdMs` grace on top — over-mask rather
 *                        than flicker).
 *   - `faces: <input>` → non-empty payload, streak reset, pass through.
 */
export function debounceEmpty(
  faces: readonly Face[],
  state: EmptyStreakState,
  now: number,
): { faces: readonly Face[] | null; state: EmptyStreakState } {
  if (faces.length > 0) {
    return { faces, state: INITIAL_EMPTY_STREAK }
  }
  const since = state.since ?? now
  const count = state.count + 1
  const next: EmptyStreakState = { count, since }
  const streakConfirmed =
    count >= EMPTY_STREAK_HOLD_COUNT || now - since >= EMPTY_STREAK_HOLD_MS
  return { faces: streakConfirmed ? [] : null, state: next }
}

/** Exponential-approach factor for a timestep (frame-rate independent). */
export function smoothingAlpha(dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return 1
  return 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const SETTLE_EPS = 0.0005

/**
 * Advance every track's rendered box towards its target. Returns the SAME
 * array instance when every track is already settled (lets a render loop
 * skip state updates when nothing moves).
 */
export function stepTracks(
  tracks: readonly Track[],
  dtMs: number,
  tauMs: number,
): Track[] {
  const alpha = smoothingAlpha(dtMs, tauMs)
  let moved = false
  const next = tracks.map((t) => {
    const dx = Math.abs(t.target.x - t.cur.x)
    const dy = Math.abs(t.target.y - t.cur.y)
    const dw = Math.abs(t.target.w - t.cur.w)
    const dh = Math.abs(t.target.h - t.cur.h)
    if (dx < SETTLE_EPS && dy < SETTLE_EPS && dw < SETTLE_EPS && dh < SETTLE_EPS) {
      if (t.cur === t.target) return t
      return { ...t, cur: t.target }
    }
    moved = true
    return {
      ...t,
      cur: {
        x: lerp(t.cur.x, t.target.x, alpha),
        y: lerp(t.cur.y, t.target.y, alpha),
        w: lerp(t.cur.w, t.target.w, alpha),
        h: lerp(t.cur.h, t.target.h, alpha),
        score: t.target.score,
      },
    }
  })
  if (!moved && next.every((t, i) => t === tracks[i])) {
    return tracks as Track[]
  }
  return next
}

// ---------------------------------------------------------------------------
// Render geometry
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type ObjectFit = 'contain' | 'cover'

/**
 * Map a CSS `object-fit` computed value to the two letterbox modes this
 * overlay understands. Anything else (`fill`, `none`, `scale-down`, an
 * empty string from an unstyled `<video>`, or a non-DOM test double) falls
 * back to `contain` — the conservative, never-crops assumption.
 */
export function resolveObjectFit(raw: string | null | undefined): ObjectFit {
  return raw === 'cover' ? 'cover' : 'contain'
}

/**
 * Where the video CONTENT actually sits within the `<video>` element's OWN
 * rendered box (`containerW`/`containerH` = that element's box, NOT some
 * ancestor's — see the `content` composition in index.tsx) under
 * `object-fit: contain` (letterbox/pillarbox, scale = min ratio, content
 * fits fully inside the box) or `object-fit: cover` (scale = max ratio,
 * content overflows the box and is cropped — offsets go negative on the
 * cropped axis, which is correct: that part of the frame isn't visible).
 * Unknown intrinsic size (0) → assume the content fills the box.
 */
export function videoContentRect(
  containerW: number,
  containerH: number,
  videoW: number,
  videoH: number,
  fit: ObjectFit = 'contain',
): Rect {
  if (containerW <= 0 || containerH <= 0) return { x: 0, y: 0, w: 0, h: 0 }
  if (videoW <= 0 || videoH <= 0) {
    return { x: 0, y: 0, w: containerW, h: containerH }
  }
  const scale =
    fit === 'cover'
      ? Math.max(containerW / videoW, containerH / videoH)
      : Math.min(containerW / videoW, containerH / videoH)
  const w = videoW * scale
  const h = videoH * scale
  return { x: (containerW - w) / 2, y: (containerH - h) / 2, w, h }
}

/** Normalized face box → pixel rect inside the (letterboxed) content rect. */
export function faceToPixels(face: Face, content: Rect): Rect {
  return {
    x: content.x + face.x * content.w,
    y: content.y + face.y * content.h,
    w: face.w * content.w,
    h: face.h * content.h,
  }
}

/**
 * Mosaic grid for a region: ~one cell per `mosaicSize` display pixels (deface
 * --mosaicsize), at least 1×1 — fewer cells = chunkier anonymization.
 */
export function mosaicGrid(
  wPx: number,
  hPx: number,
  mosaicSize: number,
): { cols: number; rows: number } {
  const size = Math.max(2, mosaicSize)
  return {
    cols: Math.max(1, Math.round(wPx / size)),
    rows: Math.max(1, Math.round(hPx / size)),
  }
}

/** Blur radius scaled to the face size so bigger faces stay unrecognizable. */
export function blurRadius(wPx: number): number {
  return Math.max(8, Math.round(wPx / 6))
}

/** CSS border-radius for the mask shape (ellipse unless boxes). */
export function maskBorderRadius(boxes: boolean): string {
  return boxes ? '6%' : '50%'
}

/** Score label text (e.g. 0.874 → "87%"). */
export function scoreLabel(score: number): string {
  return `${Math.round(clamp01(score) * 100)}%`
}
