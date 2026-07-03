/**
 * Unit specs for the pure config-preset helpers.
 * Run with Node's built-in runner: `npm run test` → `node --test src/**\/*.spec.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePresetDiff, presetResultKey } from './presets.ts'

test('parsePresetDiff: empty / nullish diff means no change', () => {
  assert.deepEqual(parsePresetDiff(''), { added: 0, removed: 0, changed: false })
  assert.deepEqual(parsePresetDiff(undefined), { added: 0, removed: 0, changed: false })
  assert.deepEqual(parsePresetDiff(null), { added: 0, removed: 0, changed: false })
})

test('parsePresetDiff: counts +/- lines and ignores context lines', () => {
  const diff = [
    '  name: live',
    '- transcoding:',
    '-   enabled: false',
    '+ transcoding:',
    '+   enabled: true',
    '+   vod_adaptive: true',
    '  features:',
  ].join('\n')
  assert.deepEqual(parsePresetDiff(diff), { added: 3, removed: 2, changed: true })
})

test('parsePresetDiff: a diff with only additions still reads as changed', () => {
  const diff = ['+ distribution:', '+   mode: cdn'].join('\n')
  const stat = parsePresetDiff(diff)
  assert.equal(stat.added, 2)
  assert.equal(stat.removed, 0)
  assert.equal(stat.changed, true)
})

test('presetResultKey: maps the apply outcome to a stable i18n key', () => {
  assert.equal(presetResultKey({ changed: false, reloaded: true }), 'noChange')
  assert.equal(presetResultKey({ changed: true, reloaded: true }), 'appliedReloaded')
  assert.equal(presetResultKey({ changed: true, reloaded: false }), 'appliedWritten')
})
