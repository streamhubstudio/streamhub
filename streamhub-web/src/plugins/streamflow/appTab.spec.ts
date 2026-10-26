/**
 * streamflow appTab — the PURE in-app-tab visibility predicate under node:test.
 *
 * Locks the load-bearing bit: streamflow gets its own AppDetail tab ONLY when it
 * is installed + active, ships a frontend app-tab surface, and is the streamflow
 * plugin — never for an inactive / backend-only / wrong-ui / other plugin.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hasStreamflowTab, streamflowTabView } from './appTab.ts'
import type { PluginView } from '../types.ts'

function view(over: Partial<PluginView>): PluginView {
  return {
    id: 'streamflow',
    name: 'Streamflow',
    description: '',
    category: 'tool',
    ui: 'app-tab',
    kind: 'app',
    edge: false,
    storage: null,
    exportable: false,
    hasFrontend: true,
    hasBackend: true,
    installed: true,
    active: true,
    config: {},
    ...over,
  } as PluginView
}

describe('streamflowTabView', () => {
  it('returns the active streamflow app-tab view', () => {
    const v = view({})
    assert.equal(streamflowTabView([v]), v)
    assert.equal(hasStreamflowTab([v]), true)
  })

  it('hides when not active / not frontend / wrong ui / not installed', () => {
    assert.equal(hasStreamflowTab([view({ active: false })]), false)
    assert.equal(hasStreamflowTab([view({ hasFrontend: false })]), false)
    assert.equal(hasStreamflowTab([view({ ui: 'panel' })]), false)
    assert.equal(hasStreamflowTab([view({ installed: false, active: false })]), false)
  })

  it('ignores other plugins', () => {
    assert.equal(hasStreamflowTab([view({ id: 'fleet' })]), false)
    assert.equal(hasStreamflowTab([]), false)
  })
})
