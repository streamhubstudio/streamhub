/**
 * Unit specs for the Radio plugin's pure helpers.
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RADIO_ROOM,
  buildEmbed,
  buildListenerUrl,
  resolveRoom,
} from './radio/logic.ts'

test('resolveRoom: trims, falls back to default', () => {
  assert.equal(resolveRoom({ room: 'lounge' }), 'lounge')
  assert.equal(resolveRoom({ room: '  night  ' }), 'night')
  assert.equal(resolveRoom({ room: '' }), DEFAULT_RADIO_ROOM)
  assert.equal(resolveRoom({}), DEFAULT_RADIO_ROOM)
  assert.equal(resolveRoom(undefined), DEFAULT_RADIO_ROOM)
  assert.equal(resolveRoom({ room: 123 as never }), DEFAULT_RADIO_ROOM)
})

test('buildListenerUrl: encodes app + room', () => {
  assert.equal(
    buildListenerUrl('https://x.io', 'my app', 'the/room'),
    'https://x.io/samples/my%20app/audio-radio.html?room=the%2Froom',
  )
})

test('buildEmbed: wraps the listener url in an autoplay iframe', () => {
  const url = 'https://x.io/samples/a/audio-radio.html?room=radio'
  const embed = buildEmbed(url)
  assert.ok(embed.includes(`src="${url}"`))
  assert.ok(embed.includes('allow="autoplay"'))
  assert.ok(embed.startsWith('<iframe'))
})
