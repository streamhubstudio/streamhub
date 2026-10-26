/**
 * node:test — primary + backup (failover) RTMP key helpers.
 *
 * Locks the Ingress tab's dual-key rendering: a create response with a backup
 * splits into two credential sets (both point at the SAME room ⇒ one player),
 * a legacy single-key response still yields a primary, and a listed row's role
 * badge reads from the backend `role` annotation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasBackupKey, ingressKeyPair, ingressRole } from './ingressBackup.ts'

test('ingressKeyPair: backup response → primary + backup sets', () => {
  const pair = ingressKeyPair({
    primaryStreamKey: 'key1',
    primary_rtmp_url: 'rtmp://h:1935/live/key1',
    primary_rtmps_url: 'rtmps://h:1936/live/key1',
    backupStreamKey: 'key2',
    backup_rtmp_url: 'rtmp://h:1935/live/key2',
    backup_rtmps_url: 'rtmps://h:1936/live/key2',
  })
  assert.deepEqual(pair.primary, {
    streamKey: 'key1',
    rtmpUrl: 'rtmp://h:1935/live/key1',
    rtmpsUrl: 'rtmps://h:1936/live/key1',
    password: undefined,
  })
  assert.ok(pair.backup)
  assert.equal(pair.backup?.streamKey, 'key2')
  assert.equal(pair.backup?.rtmpUrl, 'rtmp://h:1935/live/key2')
  assert.equal(hasBackupKey({ backupStreamKey: 'key2' }), true)
})

test('ingressKeyPair: legacy single-key response → primary only, no backup', () => {
  const pair = ingressKeyPair({
    stream_key: 'abc',
    rtmp_url: 'rtmp://h:1935/live/abc',
  })
  assert.equal(pair.primary.streamKey, 'abc')
  assert.equal(pair.primary.rtmpUrl, 'rtmp://h:1935/live/abc')
  assert.equal(pair.backup, undefined)
  assert.equal(hasBackupKey(pair.primary), false)
})

test('ingressKeyPair: carries per-key passwords when present', () => {
  const pair = ingressKeyPair({
    stream_key: 'abc',
    stream_password: 'p-primary',
    backup_stream_key: 'def',
    backup_stream_password: 'p-backup',
  })
  assert.equal(pair.primary.password, 'p-primary')
  assert.equal(pair.backup?.password, 'p-backup')
  assert.equal(pair.backup?.streamKey, 'def')
})

test('ingressKeyPair: tolerant of null/empty input', () => {
  for (const empty of [null, undefined, {}]) {
    const pair = ingressKeyPair(empty)
    assert.equal(pair.primary.streamKey, undefined)
    assert.equal(pair.primary.rtmpUrl, undefined)
    assert.equal(pair.backup, undefined)
  }
  assert.equal(hasBackupKey(null), false)
})

test('ingressRole: reads the backend role annotation', () => {
  assert.equal(ingressRole({ role: 'primary' }), 'primary')
  assert.equal(ingressRole({ role: 'backup' }), 'backup')
  assert.equal(ingressRole({ role: 'weird' }), undefined)
  assert.equal(ingressRole({}), undefined)
  assert.equal(ingressRole(null), undefined)
})
