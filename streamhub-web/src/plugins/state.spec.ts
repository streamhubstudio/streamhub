/**
 * Unit specs for the catalog merge (registry × backend install state).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogCategories,
  findView,
  mergeCatalog,
  openTargetFor,
  partitionByKind,
  pickPlayerProvider,
  resolveSection,
  sectionsOf,
  studioAppPath,
} from './state.ts'
import type {
  InstalledPlugin,
  PlayerComponent,
  PluginView,
  RegisteredPlugin,
} from './types.ts'

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

// --- kind / exportable / storage merge (Studio Apps) ------------------------

test('mergeCatalog: kind defaults to "plugin" when neither side declares it', () => {
  const [v] = mergeCatalog([reg({ id: 'timestamp' })], [])
  assert.equal(v.kind, 'plugin')
  assert.equal(v.exportable, false)
  assert.equal(v.storage, null)
})

test('mergeCatalog: frontend kind is used when there is no backend record', () => {
  const [v] = mergeCatalog([reg({ id: 'lpr', kind: 'app' })], [])
  assert.equal(v.kind, 'app')
})

test('mergeCatalog: backend kind WINS over the frontend module (precedence like version)', () => {
  // Frontend says plugin, backend manifest says app → backend wins.
  const [v] = mergeCatalog(
    [reg({ id: 'x', kind: 'plugin' })],
    [{ id: 'x', installed: true, kind: 'app' }],
  )
  assert.equal(v.kind, 'app')
})

test('mergeCatalog: backend kind wins the other direction too (app frontend, plugin backend)', () => {
  const [v] = mergeCatalog(
    [reg({ id: 'x', kind: 'app' })],
    [{ id: 'x', installed: true, kind: 'plugin' }],
  )
  assert.equal(v.kind, 'plugin')
})

test('mergeCatalog: frontend kind survives when the backend omits kind', () => {
  const [v] = mergeCatalog(
    [reg({ id: 'lpr', kind: 'app' })],
    [{ id: 'lpr', installed: true }], // no kind field
  )
  assert.equal(v.kind, 'app')
})

test('mergeCatalog: exportable + storage are taken from the backend manifest', () => {
  const [v] = mergeCatalog(
    [reg({ id: 'lpr', kind: 'app' })],
    [{ id: 'lpr', installed: true, exportable: true, storage: { db: 'lpr.db' }, needsWorker: true }],
  )
  assert.equal(v.exportable, true)
  assert.deepEqual(v.storage, { db: 'lpr.db' })
  assert.equal(v.needsWorker, true)
})

// --- edge capability merge (drives the "Edge" marketplace badge) -------------

test('mergeCatalog: edge defaults to false when neither side declares it', () => {
  const [v] = mergeCatalog([reg({ id: 'watermark' })], [])
  assert.equal(v.edge, false)
})

test('mergeCatalog: frontend edge flag is used with no backend record', () => {
  const [v] = mergeCatalog([reg({ id: 'occupancy', kind: 'app', edge: true })], [])
  assert.equal(v.edge, true)
})

test('mergeCatalog: backend edge WINS over the frontend module', () => {
  const [on] = mergeCatalog(
    [reg({ id: 'x', edge: false })],
    [{ id: 'x', installed: true, edge: true }],
  )
  assert.equal(on.edge, true)
  const [off] = mergeCatalog(
    [reg({ id: 'y', edge: true })],
    [{ id: 'y', installed: true, edge: false }],
  )
  assert.equal(off.edge, false)
})

// --- partitionByKind (the Apps / Plugins shelf split) -----------------------

function view(id: string, kind: 'app' | 'plugin'): PluginView {
  return mergeCatalog([reg({ id, kind })], [])[0]
}

test('partitionByKind: splits apps from plugins, preserving order', () => {
  const views = mergeCatalog(
    [
      reg({ id: 'a', name: 'Alpha', kind: 'app', category: 'x' }),
      reg({ id: 'b', name: 'Bravo', kind: 'plugin', category: 'x' }),
      reg({ id: 'c', name: 'Charlie', kind: 'app', category: 'x' }),
    ],
    [],
  )
  const { apps, plugins } = partitionByKind(views)
  assert.deepEqual(apps.map((v) => v.id), ['a', 'c'])
  assert.deepEqual(plugins.map((v) => v.id), ['b'])
})

test('partitionByKind: default-kind rows land in the plugins shelf', () => {
  const { apps, plugins } = partitionByKind([view('p', 'plugin')])
  assert.equal(apps.length, 0)
  assert.equal(plugins.length, 1)
})

// --- openTargetFor (route-vs-modal decision) --------------------------------

test('openTargetFor: an app opens as a page', () => {
  assert.equal(openTargetFor(view('lpr', 'app')), 'page')
})

test('openTargetFor: a plugin opens in the modal', () => {
  assert.equal(openTargetFor(view('timestamp', 'plugin')), 'modal')
})

// --- pickPlayerProvider (the HLS/VOD swap selector) ------------------------

const Player: PlayerComponent = () => null

test('pickPlayerProvider: null when no player-slot plugin exists', () => {
  const views = mergeCatalog(
    [reg({ id: 'chat', ui: 'app-tab' })],
    [{ id: 'chat', installed: true, enabled: true }],
  )
  assert.equal(pickPlayerProvider(views), null)
})

test('pickPlayerProvider: null when the provider is installed but NOT enabled', () => {
  const views = mergeCatalog(
    [reg({ id: 'vidstack', ui: 'player', PlayerComponent: Player })],
    [{ id: 'vidstack', installed: true, enabled: false }],
  )
  assert.equal(pickPlayerProvider(views), null)
})

test('pickPlayerProvider: null when active but the module ships no PlayerComponent', () => {
  const views = mergeCatalog(
    [reg({ id: 'vidstack', ui: 'player' })], // no PlayerComponent
    [{ id: 'vidstack', installed: true, enabled: true }],
  )
  assert.equal(pickPlayerProvider(views), null)
})

test('pickPlayerProvider: null for a backend-only provider (no frontend registration)', () => {
  const views = mergeCatalog(
    [],
    [{ id: 'vidstack', installed: true, active: true }],
  )
  assert.equal(pickPlayerProvider(views), null)
})

test('pickPlayerProvider: returns the active, registered provider', () => {
  const views = mergeCatalog(
    [reg({ id: 'vidstack', name: 'Vidstack', ui: 'player', PlayerComponent: Player })],
    [{ id: 'vidstack', installed: true, enabled: true, config: { theme: 'dark' } }],
  )
  const chosen = pickPlayerProvider(views)
  assert.equal(chosen?.id, 'vidstack')
  assert.equal(chosen?.registered?.PlayerComponent, Player)
})

test('pickPlayerProvider: first match wins when two providers are active', () => {
  const views = mergeCatalog(
    [
      reg({ id: 'zplayer', name: 'Zed', ui: 'player', PlayerComponent: Player }),
      reg({ id: 'aplayer', name: 'Ace', ui: 'player', PlayerComponent: Player }),
    ],
    [
      { id: 'zplayer', installed: true, enabled: true },
      { id: 'aplayer', installed: true, enabled: true },
    ],
  )
  // Catalog is sorted by category then name → 'Ace' (aplayer) precedes 'Zed'.
  assert.equal(pickPlayerProvider(views)?.id, 'aplayer')
})

// --- studioAppPath / sectionsOf / resolveSection (deep-link routing) --------

test('studioAppPath: section-less path stays back-compatible', () => {
  assert.equal(studioAppPath('live app', 'streamflow'), '/apps/live%20app/studio/streamflow')
})

test('studioAppPath: appends + encodes the section segment', () => {
  assert.equal(
    studioAppPath('live', 'streamflow', 'editor'),
    '/apps/live/studio/streamflow/editor',
  )
})

test('sectionsOf: returns the module-declared sections (empty when none)', () => {
  const withSecs = mergeCatalog(
    [reg({ id: 'streamflow', kind: 'app', sections: [{ id: 'workflows', labelKey: 'k' }] })],
    [],
  )[0]
  assert.deepEqual(sectionsOf(withSecs).map((s) => s.id), ['workflows'])
  const none = mergeCatalog([reg({ id: 'timestamp' })], [])[0]
  assert.deepEqual(sectionsOf(none), [])
})

test('resolveSection: absent segment → default section, no redirect', () => {
  const secs = [{ id: 'overview', labelKey: 'a' }, { id: 'events', labelKey: 'b' }]
  assert.deepEqual(resolveSection(secs, undefined), { section: 'overview', redirect: false })
})

test('resolveSection: known segment → itself, no redirect', () => {
  const secs = [{ id: 'overview', labelKey: 'a' }, { id: 'events', labelKey: 'b' }]
  assert.deepEqual(resolveSection(secs, 'events'), { section: 'events', redirect: false })
})

test('resolveSection: unknown segment → default + redirect (no crash)', () => {
  const secs = [{ id: 'overview', labelKey: 'a' }, { id: 'events', labelKey: 'b' }]
  assert.deepEqual(resolveSection(secs, 'bogus'), { section: 'overview', redirect: true })
})

test('resolveSection: no declared sections → null, never redirects', () => {
  assert.deepEqual(resolveSection([], 'anything'), { section: null, redirect: false })
  assert.deepEqual(resolveSection([], undefined), { section: null, redirect: false })
})
