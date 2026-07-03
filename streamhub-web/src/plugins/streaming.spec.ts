/**
 * Unit specs for the Video Streaming plugin's pure helpers.
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STREAM_ROOM,
  isRtmpValid,
  resolveAudioOnly,
  resolveRoom,
  resolveRtmpUrl,
} from './streaming/logic.ts'

test('resolveRoom: trims, falls back to studio', () => {
  assert.equal(resolveRoom({ room: 'stage' }), 'stage')
  assert.equal(resolveRoom({ room: '   ' }), DEFAULT_STREAM_ROOM)
  assert.equal(resolveRoom(undefined), DEFAULT_STREAM_ROOM)
})

test('resolveRtmpUrl: trims, empty when unset', () => {
  assert.equal(resolveRtmpUrl({ defaultRtmpUrl: ' rtmp://a/b ' }), 'rtmp://a/b')
  assert.equal(resolveRtmpUrl({}), '')
  assert.equal(resolveRtmpUrl(undefined), '')
})

test('resolveAudioOnly: coerces to boolean', () => {
  assert.equal(resolveAudioOnly({ audioOnly: true }), true)
  assert.equal(resolveAudioOnly({ audioOnly: false }), false)
  assert.equal(resolveAudioOnly({}), false)
})

test('isRtmpValid: needs scheme + host + path', () => {
  assert.equal(isRtmpValid('rtmp://a.rtmp.youtube.com/live2/key'), true)
  assert.equal(isRtmpValid('rtmps://host/app/key'), true)
  assert.equal(isRtmpValid('rtmp://hostonly'), false)
  assert.equal(isRtmpValid('http://host/path'), false)
  assert.equal(isRtmpValid(''), false)
})
