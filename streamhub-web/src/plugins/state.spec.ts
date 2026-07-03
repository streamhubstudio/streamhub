/**
 * Unit specs for the catalog merge (registry × backend install state).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogCategories, findView, mergeCatalog } from './state.ts'
import type { InstalledPlugin, RegisteredPlugin } from './types.ts'

function reg(p: Partial<RegisteredPlugin> & { id: string }): RegisteredPlugin {
  return {
    name: p.id,
    ui: 'app-tab',
    category: 'general',
    description: '',
    source: `./${p.id}/index.ts`,
    ...p,
  }
}

test('mergeCatalog: frontend-only plugin is not installed', () => {
  const views = mergeCatalog([reg({ id: 'chat', name: 'Chat' })], [])
  assert.equal(views.length, 1)
  assert.equal(views[0].hasFrontend, true)
  assert.equal(views[0].hasBackend, false)
  assert.equal(views[0].installed, false)
  assert.equal(views[0].active, false)
})

test('mergeCatalog: merges backend state (active/enabled alias, config)', () => {
  const registered = [
    reg({
      id: 'chat',
      name: 'Chat',
      configSchema: { fields: [{ key: 'title', type: 'string', label: 'T', default: 'Hi' }] },
    }),
  ]
  const installed: InstalledPlugin[] = [
    { id: 'chat', installed: true, enabled: true, config: { title: 'Live' } },
  ]
  const [v] = mergeCatalog(registered, installed)
  assert.equal(v.installed, true)
  assert.equal(v.active, true) // via `enabled`
  assert.equal(v.config.title, 'Live') // stored overrides default
})

test('mergeCatalog: installed:false is registered but not installed', () => {
  const [v] = mergeCatalog(
    [reg({ id: 'x' })],
    [{ id: 'x', installed: false, active: true }],
  )
  assert.equal(v.installed, false)
  assert.equal(v.active, false) // inactive because not installed
})

test('mergeCatalog: backend-only plugin still shows with its metadata', () => {
  const [v] = mergeCatalog(
    [],
    [{ id: 'ghost', name: 'Ghost', description: 'server side', category: 'ops', installed: true }],
  )
  assert.equal(v.hasFrontend, false)
  assert.equal(v.hasBackend, true)
  assert.equal(v.name, 'Ghost')
  assert.equal(v.category, 'ops')
  assert.equal(v.registered, undefined)
})

test('mergeCatalog: sorted by category then name; categories + findView helpers', () => {
  const views = mergeCatalog(
    [
      reg({ id: 'z', name: 'Zeta', category: 'analytics' }),
      reg({ id: 'a', name: 'Alpha', category: 'analytics' }),
      reg({ id: 'm', name: 'Mid', category: 'engagement' }),
    ],
    [],
  )
  assert.deepEqual(views.map((v) => v.id), ['a', 'z', 'm'])
  assert.deepEqual(catalogCategories(views), ['analytics', 'engagement'])
  assert.equal(findView(views, 'm')?.name, 'Mid')
  assert.equal(findView(views, 'nope'), undefined)
})
