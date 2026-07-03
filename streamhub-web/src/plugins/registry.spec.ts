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
