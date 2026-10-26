/**
 * node:test — the Live view's dual-player selector logic.
 *
 * Locks down:
 *  - the selector only appears when an app player provider (Vidstack) is active,
 *    and defaults to the provider; with none, video.js is the only player;
 *  - each choice maps to the right <HlsPlayer forcePlayer> value;
 *  - each choice yields a copy-embed-code snippet: the provider is the /embed
 *    <iframe> (full widget), video.js is the self-contained playlist embed — and
 *    NEITHER snippet leaks a bearer/JWT secret.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  embedSnippetFor,
  forcePlayerFor,
  playerSelector,
} from './playerSelect.ts'

test('playerSelector: shown + provider-default only when a provider is active', () => {
  assert.deepEqual(playerSelector(true), {
    show: true,
    choices: ['provider', 'builtin'],
    initial: 'provider',
  })
  assert.deepEqual(playerSelector(false), {
    show: false,
    choices: ['builtin'],
    initial: 'builtin',
  })
})

test('forcePlayerFor: choice maps 1:1 to the HlsPlayer forcePlayer prop', () => {
  assert.equal(forcePlayerFor('provider'), 'provider')
  assert.equal(forcePlayerFor('builtin'), 'builtin')
})

test('embedSnippetFor: provider → /embed iframe, builtin → self-contained video.js', () => {
  const urls = {
    embedUrl: 'https://s.example/embed/live/ch1',
    playlistUrl: 'https://s.example/hls/live/ch1/index.m3u8',
  }

  const provider = embedSnippetFor('provider', urls)
  assert.ok(provider.startsWith('<iframe'))
  assert.ok(provider.includes('src="https://s.example/embed/live/ch1"'))

  const builtin = embedSnippetFor('builtin', urls)
  assert.ok(builtin.includes('type="application/x-mpegURL"'))
  assert.ok(builtin.includes(urls.playlistUrl))
  assert.ok(builtin.includes("videojs('streamhub-hls')"))
})

test('embedSnippetFor: no snippet ever carries a bearer / session secret', () => {
  const urls = {
    embedUrl: 'https://s.example/embed/live/ch1',
    playlistUrl: 'https://s.example/hls/live/ch1/index.m3u8',
  }
  for (const choice of ['provider', 'builtin'] as const) {
    const snippet = embedSnippetFor(choice, urls)
    assert.doesNotMatch(snippet, /sk_/)
    assert.doesNotMatch(snippet, /Bearer/i)
    assert.doesNotMatch(snippet, /eyJ/) // JWT header prefix
  }
})
