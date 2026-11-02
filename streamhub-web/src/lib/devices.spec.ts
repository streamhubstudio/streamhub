import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channelStateTone, linkableChannels, normalizePairingCode } from './devices.ts'

test('pairing codes normalize like the core (case, dashes, spaces)', () => {
  assert.equal(normalizePairingCode('k7q4-m2xp'), 'K7Q4M2XP')
  assert.equal(normalizePairingCode(' K7Q4 M2XP '), 'K7Q4M2XP')
  assert.equal(normalizePairingCode('K7Q4.M2XP'), 'K7Q4M2XP')
  for (const bad of ['', 'K7Q4M2X', 'K7Q4M2XPZ', 'K7Q4M2X0', 'K7Q4M2XI', 'K7Q4M2X%']) {
    assert.equal(normalizePairingCode(bad), null, bad)
  }
})

test('channel state tones', () => {
  assert.equal(channelStateTone('live'), 'green')
  assert.equal(channelStateTone('error'), 'red')
  assert.equal(channelStateTone('reconnecting'), 'amber')
  assert.equal(channelStateTone(undefined), 'slate')
})

test('linkable channels merge announced + linked, numeric order', () => {
  const got = linkableChannels([{ id: '10' }, { id: '2', name: 'SDI 2' }], [{ id: '1', name: 'old' }, { id: '2' }])
  assert.deepEqual(got.map((c) => c.id), ['1', '2', '10'])
  assert.equal(got[1].name, 'SDI 2')
  assert.deepEqual(linkableChannels(undefined, []), [])
})
