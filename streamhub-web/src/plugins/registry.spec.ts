/**
 * Unit specs for the plugin registry (pure normalization + collisions).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistry, idFromSource, normalizeModule } from './registry.ts'
import type { PluginModule } from './types.ts'

const good: PluginModule = {
  id: 'chat',
  name: 'Chat',
  ui: 'app-tab',
  category: 'engagement',
}

test('idFromSource: derives folder name', () => {
  assert.equal(idFromSource('./chat/index.ts'), 'chat')
  assert.equal(idFromSource('../plugins/audit-cam/index.tsx'), 'audit-cam')
})

test('normalizeModule: accepts { default } wrapper and bare module', () => {
  const a = normalizeModule({ default: good }, './chat/index.ts')
  assert.equal(a.plugin?.id, 'chat')
  assert.equal(a.plugin?.category, 'engagement')
  const b = normalizeModule(good, './chat/index.ts')
  assert.equal(b.plugin?.id, 'chat')
})

test('normalizeModule: carries the manifest version through unchanged', () => {
  const { plugin } = normalizeModule(
    { default: { ...good, version: '1.2.3' } },
    './chat/index.ts',
  )
  assert.equal(plugin?.version, '1.2.3')
})

test('normalizeModule: carries declared sections through for the launcher/deep links', () => {
  const sections = [
    { id: 'workflows', labelKey: 'streamflow:section.workflows' },
    { id: 'editor', labelKey: 'streamflow:section.editor' },
  ]
  const { plugin } = normalizeModule(
    { default: { ...good, sections } },
    './streamflow/index.ts',
  )
  assert.deepEqual(plugin?.sections, sections)
})

test('normalizeModule: a version-less module stays valid (version undefined)', () => {
  const { plugin } = normalizeModule({ default: good }, './chat/index.ts')
  assert.equal(plugin?.id, 'chat')
  assert.equal(plugin?.version, undefined)
})

test('buildRegistry: preserves each plugin version in the registry', () => {
  const { registry } = buildRegistry({
    './a/index.ts': { default: { ...good, version: '0.1.0' } },
    './b/index.ts': { default: { id: 'b', name: 'B', ui: 'panel', version: '2.0.0' } },
  })
  assert.equal(registry.get('chat')?.version, '0.1.0')
  assert.equal(registry.get('b')?.version, '2.0.0')
})

test('normalizeModule: id falls back to folder, category defaults to general', () => {
  const { plugin } = normalizeModule(
    { default: { name: 'X', ui: 'panel' } },
    './widgets/index.ts',
  )
  assert.equal(plugin?.id, 'widgets')
  assert.equal(plugin?.category, 'general')
  assert.equal(plugin?.description, '')
})

test('normalizeModule: rejects missing name / bad ui', () => {
  assert.equal(normalizeModule({ default: { id: 'a', ui: 'app-tab' } }, 's').plugin, null)
  assert.equal(
    normalizeModule({ default: { id: 'a', name: 'A', ui: 'nope' } }, 's').plugin,
    null,
  )
  assert.equal(normalizeModule(null, 's').plugin, null)
})

test('normalizeModule: accepts the `player` slot (media-player provider)', () => {
  const { plugin } = normalizeModule(
    { default: { id: 'vidstack', name: 'Vidstack', ui: 'player' } },
    './vidstack/index.tsx',
  )
  assert.equal(plugin?.id, 'vidstack')
  assert.equal(plugin?.ui, 'player')
})

test('buildRegistry: sorts, dedupes by id with a warning, keeps first', () => {
  const { registry, warnings } = buildRegistry({
    './b/index.ts': { default: { id: 'b', name: 'B', ui: 'panel' } },
    './a/index.ts': { default: good },
    './dupe/index.ts': { default: { id: 'chat', name: 'Chat 2', ui: 'panel' } },
    './broken/index.ts': { default: { name: 'no ui' } },
  })
  assert.equal(registry.size, 2)
  assert.equal(registry.get('chat')?.name, 'Chat') // first (./a) wins over ./dupe
  assert.ok(warnings.some((w) => w.includes('duplicate id "chat"')))
  assert.ok(warnings.some((w) => w.includes('./broken/index.ts')))
})

test('buildRegistry: empty discovery → empty registry (no plugins yet)', () => {
  const { registry, warnings } = buildRegistry({})
  assert.equal(registry.size, 0)
  assert.deepEqual(warnings, [])
})

test('buildRegistry: registers a vendored plugin that has no in-tree twin', () => {
  const { registry } = buildRegistry({
    '../plugins-vendor/radar/index.tsx': {
      default: { id: 'radar', name: 'Radar', ui: 'app-tab' },
    },
  })
  assert.equal(registry.get('radar')?.name, 'Radar')
  assert.equal(registry.get('radar')?.source, '../plugins-vendor/radar/index.tsx')
})

test('buildRegistry: in-tree WINS over a vendored id, whatever the glob order', () => {
  // The vendored path sorts BEFORE the in-tree one ("../" < "./"), so it is
  // processed first — the in-tree copy must still win and warn about the shadow.
  const { registry, warnings } = buildRegistry({
    '../plugins-vendor/lpr/index.tsx': {
      default: { id: 'lpr', name: 'Vendored LPR', ui: 'app-tab' },
    },
    './lpr/index.tsx': { default: { id: 'lpr', name: 'In-tree LPR', ui: 'app-tab' } },
  })
  assert.equal(registry.get('lpr')?.name, 'In-tree LPR')
  assert.equal(registry.get('lpr')?.source, './lpr/index.tsx')
  assert.ok(warnings.some((w) => w.includes('shadowed by in-tree')))
})
