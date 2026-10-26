/**
 * Unit specs for the Scheduled Live overlay helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ACCENT,
  DEFAULT_HEADLINE,
  SCHEDULED_LIVE_TOPIC,
  computePhase,
  formatOffsetLabel,
  formatRemaining,
  isAgendaPush,
  pickActiveEvent,
  resolveAutoHideMs,
  resolveSettings,
  sanitizeColor,
  utcMsToZonedParts,
  zonedWallTimeToUtcMs,
  type ScheduledEvent,
} from './overlay.util.ts'

// A helper to build an event with sane defaults.
function evt(partial: Partial<ScheduledEvent> & { startAt: number }): ScheduledEvent {
  return {
    id: partial.id ?? 1,
    room: partial.room ?? null,
    title: partial.title ?? null,
    timezone: partial.timezone ?? 'UTC',
    message: partial.message ?? null,
    enabled: partial.enabled ?? true,
    startAt: partial.startAt,
  }
}

// ---------------------------------------------------------------------------
// zonedWallTimeToUtcMs — timezone math
// ---------------------------------------------------------------------------

test('zonedWallTimeToUtcMs: UTC wall time is itself', () => {
  const ms = zonedWallTimeToUtcMs(
    { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
    'UTC',
  )
  assert.equal(ms, Date.UTC(2026, 6, 1, 12, 0, 0))
})

test('zonedWallTimeToUtcMs: Buenos Aires is a fixed -03 (no DST)', () => {
  // 12:00 local in BA == 15:00 UTC.
  const ms = zonedWallTimeToUtcMs(
    { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
    'America/Argentina/Buenos_Aires',
  )
  assert.equal(ms, Date.UTC(2026, 6, 1, 15, 0, 0))

  // Same offset in January — BA never shifts.
  const jan = zonedWallTimeToUtcMs(
    { year: 2026, month: 1, day: 1, hour: 12, minute: 0 },
    'America/Argentina/Buenos_Aires',
  )
  assert.equal(jan, Date.UTC(2026, 0, 1, 15, 0, 0))
})

test('zonedWallTimeToUtcMs: New York handles DST (summer -04 vs winter -05)', () => {
  const summer = zonedWallTimeToUtcMs(
    { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
    'America/New_York',
  )
  const winter = zonedWallTimeToUtcMs(
    { year: 2026, month: 1, day: 1, hour: 12, minute: 0 },
    'America/New_York',
  )
  // 12:00 EDT == 16:00 UTC ; 12:00 EST == 17:00 UTC.
  assert.equal(summer, Date.UTC(2026, 6, 1, 16, 0, 0))
  assert.equal(winter, Date.UTC(2026, 0, 1, 17, 0, 0))

  // The whole point: the effective offset differs by exactly one hour → DST is
  // being applied (not a fixed offset).
  const summerOffset = summer - Date.UTC(2026, 6, 1, 12, 0, 0)
  const winterOffset = winter - Date.UTC(2026, 0, 1, 12, 0, 0)
  assert.notEqual(summerOffset, winterOffset)
  assert.equal(winterOffset - summerOffset, 60 * 60 * 1000)
})

test('utcMsToZonedParts round-trips a picked wall time', () => {
  const wall = { year: 2026, month: 7, day: 1, hour: 9, minute: 30, second: 0 }
  const tz = 'America/Argentina/Buenos_Aires'
  const parts = utcMsToZonedParts(zonedWallTimeToUtcMs(wall, tz), tz)
  assert.deepEqual(parts, wall)
})

// ---------------------------------------------------------------------------
// formatOffsetLabel
// ---------------------------------------------------------------------------

test('formatOffsetLabel: GMT±HH labels', () => {
  const t = Date.UTC(2026, 6, 1, 0, 0, 0)
  assert.equal(formatOffsetLabel('UTC', t), 'GMT+00')
  assert.equal(formatOffsetLabel('America/Argentina/Buenos_Aires', t), 'GMT-03')
  assert.equal(formatOffsetLabel('America/New_York', Date.UTC(2026, 6, 1, 12, 0, 0)), 'GMT-04')
  assert.equal(formatOffsetLabel('America/New_York', Date.UTC(2026, 0, 1, 12, 0, 0)), 'GMT-05')
})

// ---------------------------------------------------------------------------
// pickActiveEvent
// ---------------------------------------------------------------------------

test('pickActiveEvent: returns the soonest future event', () => {
  const now = 1_000_000
  const events = [
    evt({ id: 1, startAt: now + 5000 }),
    evt({ id: 2, startAt: now + 1000 }),
    evt({ id: 3, startAt: now + 9000 }),
  ]
  assert.equal(pickActiveEvent(events, undefined, now)?.id, 2)
})

test('pickActiveEvent: reveal window has precedence over a later countdown', () => {
  const now = 1_000_000
  const events = [
    evt({ id: 1, startAt: now - 2000 }), // started 2s ago (within a 5s reveal)
    evt({ id: 2, startAt: now + 8000 }), // future
  ]
  assert.equal(pickActiveEvent(events, undefined, now, 5000)?.id, 1)
  // With no reveal window, only the future one qualifies.
  assert.equal(pickActiveEvent(events, undefined, now, 0)?.id, 2)
})

test('pickActiveEvent: ignores disabled events and other rooms', () => {
  const now = 1_000_000
  const events = [
    evt({ id: 1, startAt: now + 1000, enabled: false }),
    evt({ id: 2, startAt: now + 2000, room: 'room2' }),
    evt({ id: 3, startAt: now + 3000, room: 'room1' }),
    evt({ id: 4, startAt: now + 4000, room: null }), // global
  ]
  // For room1: skip disabled(1) + room2(2) → soonest of room1(3)/global(4) = 3.
  assert.equal(pickActiveEvent(events, 'room1', now)?.id, 3)
})

test('pickActiveEvent: nothing upcoming → undefined', () => {
  const now = 1_000_000
  assert.equal(pickActiveEvent([evt({ startAt: now - 10000 })], undefined, now), undefined)
  assert.equal(pickActiveEvent([], undefined, now), undefined)
})

// ---------------------------------------------------------------------------
// computePhase — the three-phase machine
// ---------------------------------------------------------------------------

test('computePhase: countdown → reveal → idle across the boundary', () => {
  const start = 2_000_000
  const autoHide = 5000
  const events = [evt({ id: 7, startAt: start })]

  const before = computePhase(events, undefined, start - 10_000, autoHide)
  assert.equal(before.phase, 'countdown')
  assert.equal(before.event?.id, 7)
  assert.equal(before.remainingMs, 10_000)

  // Exactly at start → reveal.
  const atStart = computePhase(events, undefined, start, autoHide)
  assert.equal(atStart.phase, 'reveal')
  assert.equal(atStart.remainingMs, autoHide)

  const midReveal = computePhase(events, undefined, start + 2000, autoHide)
  assert.equal(midReveal.phase, 'reveal')
  assert.equal(midReveal.remainingMs, 3000)

  // Past the reveal window → idle (stream fully visible).
  const after = computePhase(events, undefined, start + autoHide, autoHide)
  assert.equal(after.phase, 'idle')
  assert.equal(after.event, undefined)
})

test('computePhase: no events → idle', () => {
  const res = computePhase([], undefined, 5_000_000, 5000)
  assert.deepEqual(res, { phase: 'idle', event: undefined, remainingMs: 0 })
})

// ---------------------------------------------------------------------------
// formatRemaining boundaries
// ---------------------------------------------------------------------------

test('formatRemaining: breaks a duration into DD/HH/MM/SS', () => {
  const ms = ((1 * 24 + 2) * 60 * 60 + 3 * 60 + 4) * 1000 // 1d 2h 3m 4s
  assert.deepEqual(formatRemaining(ms), { days: 1, hours: 2, minutes: 3, seconds: 4 })
})

test('formatRemaining: zero and negative clamp to all-zero', () => {
  assert.deepEqual(formatRemaining(0), { days: 0, hours: 0, minutes: 0, seconds: 0 })
  assert.deepEqual(formatRemaining(-5000), { days: 0, hours: 0, minutes: 0, seconds: 0 })
})

test('formatRemaining: 59s and the 60s rollover', () => {
  assert.deepEqual(formatRemaining(59_000), { days: 0, hours: 0, minutes: 0, seconds: 59 })
  assert.deepEqual(formatRemaining(60_000), { days: 0, hours: 0, minutes: 1, seconds: 0 })
})

// ---------------------------------------------------------------------------
// config resolution
// ---------------------------------------------------------------------------

test('sanitizeColor: accepts hex, else the accent default', () => {
  assert.equal(sanitizeColor('#2f7bff'), '#2f7bff')
  assert.equal(sanitizeColor('FFF'), '#fff')
  assert.equal(sanitizeColor('nope'), DEFAULT_ACCENT)
  assert.equal(sanitizeColor(undefined), DEFAULT_ACCENT)
})

test('resolveAutoHideMs: default 5s, clamped to 0..60', () => {
  assert.equal(resolveAutoHideMs(undefined), 5000)
  assert.equal(resolveAutoHideMs(10), 10_000)
  assert.equal(resolveAutoHideMs(0), 0)
  assert.equal(resolveAutoHideMs(120), 60_000)
  assert.equal(resolveAutoHideMs(-3), 0)
})

test('resolveSettings: folds a raw config bag into safe defaults', () => {
  assert.deepEqual(resolveSettings({}), {
    mode: 'cover',
    accent: DEFAULT_ACCENT,
    headline: DEFAULT_HEADLINE,
    revealAnimation: 'fade',
    muteUntilStart: true,
    showViewerLocalTime: true,
    autoHideMs: 5000,
  })
  assert.deepEqual(
    resolveSettings({
      mode: 'badge',
      accent: '00ff00',
      headline: 'Ya arranca',
      revealAnimation: 'zoom',
      muteUntilStart: false,
      showViewerLocalTime: false,
      autoHideAfterStartSec: 3,
    }),
    {
      mode: 'badge',
      accent: '#00ff00',
      headline: 'Ya arranca',
      revealAnimation: 'zoom',
      muteUntilStart: false,
      showViewerLocalTime: false,
      autoHideMs: 3000,
    },
  )
  // Hostile / unknown values fall back.
  assert.equal(resolveSettings({ mode: 'x', revealAnimation: 'spin' }).mode, 'cover')
  assert.equal(resolveSettings({ revealAnimation: 'spin' }).revealAnimation, 'fade')
})

// ---------------------------------------------------------------------------
// isAgendaPush — real-time data-channel push detection
// ---------------------------------------------------------------------------

test('isAgendaPush: accepts an agenda-updated payload as string or bytes', () => {
  const payload = JSON.stringify({
    type: 'agenda-updated',
    app: 'live',
    room: 'show',
    at: '2026-07-06T12:00:00.000Z',
  })
  assert.equal(isAgendaPush(payload), true)
  assert.equal(isAgendaPush(new TextEncoder().encode(payload)), true)
})

test('isAgendaPush: rejects foreign types, malformed JSON and non-objects', () => {
  assert.equal(isAgendaPush(JSON.stringify({ type: 'chat', body: 'hola' })), false)
  assert.equal(isAgendaPush(JSON.stringify({ noType: true })), false)
  assert.equal(isAgendaPush('not json at all'), false)
  assert.equal(isAgendaPush(''), false)
  assert.equal(isAgendaPush(JSON.stringify(null)), false)
  assert.equal(isAgendaPush(JSON.stringify('agenda-updated')), false)
  // Hostile bytes never throw.
  assert.equal(isAgendaPush(new Uint8Array([0xff, 0xfe, 0x00])), false)
})

test('SCHEDULED_LIVE_TOPIC is the stable wire topic', () => {
  assert.equal(SCHEDULED_LIVE_TOPIC, 'scheduled-live')
})
