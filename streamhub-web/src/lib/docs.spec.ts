/**
 * Unit specs for the section → docs-page map behind <DocsHint/>. Runs under
 * node:test. Locks down:
 *  - docsUrl() builds an absolute URL on the public docs site;
 *  - every mapped path is a clean relative slug (no leading '/', no '.md',
 *    no trailing '/') so slugs mirror the streamhub-docs/ file tree;
 *  - every mapped page really exists in streamhub-docs/ (the docs site is a
 *    mirror of that folder — a dangling link here means a 404 in the UI).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOCS_PATHS, docsUrl, type DocsSection } from './docs.ts'
import { DOCS_URL } from './links.ts'

const SECTIONS = Object.keys(DOCS_PATHS) as DocsSection[]

test('docsUrl: absolute URL on the docs site for every section', () => {
  assert.ok(SECTIONS.length > 0)
  for (const section of SECTIONS) {
    const url = docsUrl(section)
    assert.equal(url, `${DOCS_URL}/${DOCS_PATHS[section]}`)
    assert.ok(
      url.startsWith('https://streamhub.studio/docs/'),
      `${section}: ${url}`,
    )
  }
})

test('paths are clean relative slugs (mirror of the docs file tree)', () => {
  for (const section of SECTIONS) {
    const path = DOCS_PATHS[section]
    assert.ok(path.length > 0, `${section}: empty`)
    assert.ok(!path.startsWith('/'), `${section}: leading slash`)
    assert.ok(!path.endsWith('/'), `${section}: trailing slash`)
    assert.ok(!path.endsWith('.md'), `${section}: .md suffix leaks`)
    assert.ok(!path.includes('..'), `${section}: path traversal`)
  }
})

test('every mapped page exists in streamhub-docs/ (no dangling help links)', (t) => {
  // The repo layout: streamhub-web/ and streamhub-docs/ are siblings. When the
  // web package is checked out standalone there is nothing to verify against.
  const docsRoot = resolve(import.meta.dirname, '..', '..', '..', 'streamhub-docs')
  if (!existsSync(resolve(docsRoot, 'architecture'))) {
    t.skip('streamhub-docs/ pages not present (published at https://streamhub.studio/docs)')
    return
  }
  for (const section of SECTIONS) {
    const file = join(docsRoot, `${DOCS_PATHS[section]}.md`)
    assert.ok(existsSync(file), `${section} → missing docs page: ${file}`)
  }
})
