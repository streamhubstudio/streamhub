/**
 * Unit specs for the Timestamp CCTV overlay helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COLOR,
  DEFAULT_FORMAT,
  DEFAULT_POSITION,
  formatTimestamp,
  overlayName,
  positionClasses,
  resolveFormat,
  resolvePosition,
  resolveSettings,
  sanitizeColor,
  shouldShowName,
} from './overlay.util.ts'

// A fixed local time: 2026-07-01 09:07:05 and an afternoon 14:30:00.
const morning = new Date(2026, 6, 1, 9, 7, 5)
const afternoon = new Date(2026, 6, 1, 14, 30, 0)
const midnight = new Date(2026, 6, 1, 0, 0, 0)
const noon = new Date(2026, 6, 1, 12, 0, 0)

test('formatTimestamp: datetime-24h pads all parts', () => {
  assert.equal(formatTimestamp(morning, 'datetime-24h'), '2026-07-01 09:07:05')
  assert.equal(formatTimestamp(afternoon, 'datetime-24h'), '2026-07-01 14:30:00')
})

test('formatTimestamp: time-only variants', () => {
  assert.equal(formatTimestamp(afternoon, 'time-24h'), '14:30:00')
  assert.equal(formatTimestamp(afternoon, 'time-12h'), '02:30:00 PM')
  assert.equal(formatTimestamp(morning, 'time-12h'), '09:07:05 AM')
})

test('formatTimestamp: 12h edge cases (midnight/noon map to 12)', () => {
  assert.equal(formatTimestamp(midnight, 'time-12h'), '12:00:00 AM')
  assert.equal(formatTimestamp(noon, 'time-12h'), '12:00:00 PM')
  assert.equal(formatTimestamp(midnight, 'datetime-12h'), '2026-07-01 12:00:00 AM')
})

test('formatTimestamp: US date order', () => {
  assert.equal(formatTimestamp(morning, 'date-us'), '07/01/2026 09:07:05')
})

test('formatTimestamp: unknown format falls back to the default shape', () => {
  assert.equal(
    formatTimestamp(morning, 'nope' as never),
    formatTimestamp(morning, DEFAULT_FORMAT),
  )
})

test('resolveFormat / resolvePosition: narrow to known ids, else default', () => {
  assert.equal(resolveFormat('time-12h'), 'time-12h')
  assert.equal(resolveFormat('bogus'), DEFAULT_FORMAT)
  assert.equal(resolveFormat(undefined), DEFAULT_FORMAT)
  assert.equal(resolvePosition('top-left'), 'top-left')
  assert.equal(resolvePosition(42), DEFAULT_POSITION)
})

test('sanitizeColor: accepts #rgb/#rrggbb (with or without #), else default', () => {
  assert.equal(sanitizeColor('#ffffff'), '#ffffff')
  assert.equal(sanitizeColor('00E5FF'), '#00e5ff')
  assert.equal(sanitizeColor('#FFF'), '#fff')
  assert.equal(sanitizeColor('  #AbCdEf '), '#abcdef')
  assert.equal(sanitizeColor('red'), DEFAULT_COLOR)
  assert.equal(sanitizeColor('#12'), DEFAULT_COLOR)
  assert.equal(sanitizeColor('javascript:alert(1)'), DEFAULT_COLOR)
  assert.equal(sanitizeColor(undefined), DEFAULT_COLOR)
})

test('positionClasses: each corner maps to Tailwind anchors', () => {
  assert.equal(positionClasses('top-left'), 'top-0 left-0')
  assert.equal(positionClasses('top-right'), 'top-0 right-0')
  assert.equal(positionClasses('bottom-left'), 'bottom-0 left-0')
  assert.equal(positionClasses('bottom-right'), 'bottom-0 right-0')
})

test('overlayName: prefers room, falls back to app, undefined when empty', () => {
  assert.equal(overlayName({ room: 'cam-01', app: 'live' }), 'cam-01')
  assert.equal(overlayName({ app: 'live' }), 'live')
  assert.equal(overlayName({ room: '  ', app: '' }), undefined)
  assert.equal(overlayName({}), undefined)
})

test('shouldShowName: default ON, only explicit false hides', () => {
  assert.equal(shouldShowName({}), true)
  assert.equal(shouldShowName({ showName: true }), true)
  assert.equal(shouldShowName({ showName: false }), false)
})

test('resolveSettings: folds a raw config bag into safe defaults', () => {
  assert.deepEqual(resolveSettings({}), {
    format: DEFAULT_FORMAT,
    position: DEFAULT_POSITION,
    color: DEFAULT_COLOR,
    showName: true,
  })
  assert.deepEqual(
    resolveSettings({
      format: 'time-24h',
      position: 'top-left',
      color: 'ffffff',
      showName: false,
    }),
    {
      format: 'time-24h',
      position: 'top-left',
      color: '#ffffff',
      showName: false,
    },
  )
  // Hostile values are sanitised, not trusted.
  assert.deepEqual(
    resolveSettings({ format: 'x', position: 'y', color: 'nope' }),
    {
      format: DEFAULT_FORMAT,
      position: DEFAULT_POSITION,
      color: DEFAULT_COLOR,
      showName: true,
    },
  )
})
