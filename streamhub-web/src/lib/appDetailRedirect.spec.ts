/**
 * Legacy tab deep-link redirect (Tokens/Integraciones/Logs moved into
 * Config → System): the mapping is the single source the AppDetail component
 * uses both to RESOLVE an old `?tab=` value onto the config tab and to REWRITE
 * the URL to its canonical `?tab=config&section=system&sub=<id>` form. Locks
 * that (a) exactly the three relocated tabs redirect, (b) none of them is a
 * top-level tab anymore, and (c) genuinely-unknown values are NOT captured
 * (they keep falling through to the plugins deep-link path).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_SUBNAV_REDIRECT, isBuiltinTab } from './appDetailTabs.ts'

test('exactly tokens/integraciones/logs redirect into Config → System', () => {
  assert.deepEqual(
    Object.keys(LEGACY_SUBNAV_REDIRECT).sort(),
    ['integraciones', 'logs', 'tokens'],
  )
  for (const [legacy, sub] of Object.entries(LEGACY_SUBNAV_REDIRECT)) {
    assert.equal(sub, legacy) // sub ids mirror the old tab ids 1:1
  }
})

test('the relocated ids are no longer top-level tabs', () => {
  for (const id of Object.keys(LEGACY_SUBNAV_REDIRECT)) {
    assert.equal(isBuiltinTab(id), false)
  }
})

test('unknown values are not captured by the legacy map (plugin deep links intact)', () => {
  assert.equal(LEGACY_SUBNAV_REDIRECT['radio'], undefined)
  assert.equal(LEGACY_SUBNAV_REDIRECT['streamflow'], undefined)
  assert.equal(isBuiltinTab('config'), true)
})
