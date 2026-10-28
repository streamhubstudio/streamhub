/**
 * Unit specs for the in-app changelog model + the safe markdown parser that
 * renders it (About / Build panel). Pure — `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions,
  findRelease,
  normalizeVersion,
  parseChangelog,
  versionOf,
} from './changelog.ts'
import { inlineText, isSafeHref, parseInline, parseMarkdown, type Block } from './markdown.ts'

const MD = `# Changelog

All notable changes to StreamHub.

## 3.0.0

### Changed
- Go core.

## Unreleased
- wip

## 3.1.0

### Changed — no Node left in the product
- **Stream-health worker in Go**: \`streamhub-core health-worker\`
  replaces the Node worker.
  - nested detail

## 3.0.0-rc.1
- release candidate

\`\`\`
## 9.9.9 inside a fence is not a release
\`\`\`
`

test('versionOf: plain, v-prefixed, dated and linked headings', () => {
  assert.equal(versionOf('3.1.0'), '3.1.0')
  assert.equal(versionOf('v2.24.0'), '2.24.0')
  assert.equal(versionOf('3.1.0 — 2026-10-27'), '3.1.0')
  assert.equal(versionOf('[3.0.0-rc.1](https://x)'), '3.0.0-rc.1')
  assert.equal(versionOf('Unreleased'), null)
})

test('compareVersions: numeric, not lexicographic; pre-release < release', () => {
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0)
  assert.ok(compareVersions('3.0.0-rc.1', '3.0.0') < 0)
  assert.equal(compareVersions('3.1.0', '3.1.0'), 0)
})

test('parseChangelog: newest first, named sections on top, fences ignored', () => {
  const log = parseChangelog(MD)
  assert.deepEqual(
    log.releases.map((r) => r.version),
    ['Unreleased', '3.1.0', '3.0.0', '3.0.0-rc.1'],
  )
  assert.equal(log.preamble, 'All notable changes to StreamHub.')
  const rc = log.releases.at(-1)!
  assert.match(rc.body, /## 9\.9\.9 inside a fence/)
  assert.equal(log.releases[0].semver, false)
})

test('parseChangelog: empty / missing input', () => {
  assert.deepEqual(parseChangelog(''), { preamble: '', releases: [] })
  // @ts-expect-error — defensive against a null payload
  assert.deepEqual(parseChangelog(null).releases, [])
})

test('findRelease: matches the running version, tolerating a v prefix', () => {
  const log = parseChangelog(MD)
  assert.equal(findRelease(log, 'v3.1.0')?.version, '3.1.0')
  assert.equal(findRelease(log, ' 3.0.0\n')?.version, '3.0.0')
  assert.equal(findRelease(log, '9.9.9'), undefined)
  assert.equal(findRelease(log, undefined), undefined)
  assert.equal(normalizeVersion(' v1.2.3 '), '1.2.3')
})

test('parseMarkdown: headings, nested lists, continuation lines, code', () => {
  const body = parseChangelog(MD).releases.find((r) => r.version === '3.1.0')!.body
  const blocks = parseMarkdown(body)
  assert.equal(blocks[0].t, 'heading')
  const list = blocks[1] as Extract<Block, { t: 'list' }>
  assert.equal(list.t, 'list')
  assert.equal(list.items.length, 1)
  const text = inlineText(list.items[0].c)
  assert.equal(text, 'Stream-health worker in Go: streamhub-core health-worker replaces the Node worker.')
  assert.equal(list.items[0].c[0].t, 'strong')
  const nested = list.items[0].children[0] as Extract<Block, { t: 'list' }>
  assert.equal(nested.t, 'list')
  assert.equal(inlineText(nested.items[0].c), 'nested detail')

  const fenced = parseMarkdown('```sh\necho <b>hi</b>\n```')
  assert.deepEqual(fenced, [{ t: 'code', lang: 'sh', v: 'echo <b>hi</b>' }])
})

test('parseMarkdown: list items separated by blank lines stay one list', () => {
  const blocks = parseMarkdown('- a\n\n- b\n\nafter')
  assert.equal(blocks.length, 2)
  assert.equal((blocks[0] as Extract<Block, { t: 'list' }>).items.length, 2)
  assert.equal(blocks[1].t, 'para')
})

test('parseInline: raw HTML stays text; unsafe links lose their href', () => {
  assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [
    { t: 'text', v: '<img src=x onerror=alert(1)>' },
  ])
  const unsafe = parseInline('[click](javascript:alert)')
  assert.ok(unsafe.every((n) => n.t !== 'link'))
  const safe = parseInline('[docs](https://streamhub.studio/docs)')
  assert.deepEqual(safe, [{ t: 'link', href: 'https://streamhub.studio/docs', c: [{ t: 'text', v: 'docs' }] }])
  assert.equal(isSafeHref('data:text/html,x'), false)
  assert.equal(isSafeHref('//evil.example'), false)
  assert.equal(isSafeHref('#anchor'), true)
  assert.equal(isSafeHref('streamhub-docs/api/README.md'), true)
})

test('parseInline: snake_case and lone asterisks are literal', () => {
  assert.equal(inlineText(parseInline('PLUGIN_NODE and HEALTH_WORKER_DIR')), 'PLUGIN_NODE and HEALTH_WORKER_DIR')
  assert.ok(parseInline('PLUGIN_NODE and HEALTH_WORKER_DIR').every((n) => n.t === 'text'))
  assert.deepEqual(parseInline('2 * 3'), [{ t: 'text', v: '2 * 3' }])
  assert.deepEqual(parseInline('*em* _em_')[0], { t: 'em', c: [{ t: 'text', v: 'em' }] })
})
