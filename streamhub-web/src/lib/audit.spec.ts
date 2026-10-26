/**
 * Unit specs for the audit / security-posture pure helpers.
 * Run with: `npm test` → node --test over src/lib/*.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  auditResultTone,
  buildAuditQuery,
  clampLimit,
  clampOffset,
  computeSummary,
  postureStateTone,
} from './audit.ts'
import type { ComplianceControl } from '../api/types.ts'

test('buildAuditQuery: empty input still carries default paging', () => {
  assert.equal(buildAuditQuery().toString(), 'limit=50&offset=0')
  assert.equal(buildAuditQuery({}).toString(), 'limit=50&offset=0')
})

test('buildAuditQuery: trims text filters and drops empties', () => {
  const sp = buildAuditQuery({ action: '  auth. ', actor: '', result: '', from: '', to: '' })
  assert.equal(sp.get('action'), 'auth.')
  assert.equal(sp.get('actor'), null)
  assert.equal(sp.get('result'), null)
  assert.equal(sp.get('from'), null)
  assert.equal(sp.get('to'), null)
})

test('buildAuditQuery: serialises all filters + paging', () => {
  const sp = buildAuditQuery({
    action: 'token.create',
    actor: 'sk_abc',
    result: 'deny',
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-05T00:00:00.000Z',
    limit: 100,
    offset: 200,
  })
  assert.equal(sp.get('action'), 'token.create')
  assert.equal(sp.get('actor'), 'sk_abc')
  assert.equal(sp.get('result'), 'deny')
  assert.equal(sp.get('from'), '2026-07-01T00:00:00.000Z')
  assert.equal(sp.get('to'), '2026-07-05T00:00:00.000Z')
  assert.equal(sp.get('limit'), '100')
  assert.equal(sp.get('offset'), '200')
})

test('buildAuditQuery: clamps oversized limit to 500', () => {
  assert.equal(buildAuditQuery({ limit: 5000 }).get('limit'), '500')
  assert.equal(buildAuditQuery({ limit: AUDIT_MAX_LIMIT }).get('limit'), '500')
})

test('clampLimit: defaults, floors and clamps', () => {
  assert.equal(clampLimit(undefined), AUDIT_DEFAULT_LIMIT)
  assert.equal(clampLimit(null), AUDIT_DEFAULT_LIMIT)
  assert.equal(clampLimit(0), AUDIT_DEFAULT_LIMIT)
  assert.equal(clampLimit(-10), AUDIT_DEFAULT_LIMIT)
  assert.equal(clampLimit(Number.NaN), AUDIT_DEFAULT_LIMIT)
  assert.equal(clampLimit(49.9), 49)
  assert.equal(clampLimit(501), 500)
})

test('clampOffset: non-negative integer, defaults to 0', () => {
  assert.equal(clampOffset(undefined), 0)
  assert.equal(clampOffset(-5), 0)
  assert.equal(clampOffset(Number.NaN), 0)
  assert.equal(clampOffset(40.7), 40)
})

test('postureStateTone: active/partial/off/unknown + fallback', () => {
  assert.equal(postureStateTone('active'), 'green')
  assert.equal(postureStateTone('partial'), 'amber')
  assert.equal(postureStateTone('off'), 'red')
  assert.equal(postureStateTone('unknown'), 'slate')
  assert.equal(postureStateTone('weird'), 'slate')
  assert.equal(postureStateTone(undefined), 'slate')
})

test('auditResultTone: success/failure/deny + fallback', () => {
  assert.equal(auditResultTone('success'), 'green')
  assert.equal(auditResultTone('failure'), 'amber')
  assert.equal(auditResultTone('deny'), 'red')
  assert.equal(auditResultTone('other'), 'slate')
  assert.equal(auditResultTone(undefined), 'slate')
})

test('computeSummary: counts by state, unknown fallback, empty input', () => {
  assert.deepEqual(computeSummary(undefined), { active: 0, partial: 0, off: 0, unknown: 0 })
  const controls = [
    { id: 'a', name: 'A', iso: '8.15', state: 'active', detail: '' },
    { id: 'b', name: 'B', iso: '8.16', state: 'active', detail: '' },
    { id: 'c', name: 'C', iso: '8.20', state: 'partial', detail: '' },
    { id: 'd', name: 'D', iso: '8.21', state: 'off', detail: '' },
    // A state the frontend doesn't recognise folds into `unknown`.
    { id: 'e', name: 'E', iso: '8.22', state: 'bogus', detail: '' },
  ] as unknown as ComplianceControl[]
  assert.deepEqual(computeSummary(controls), { active: 2, partial: 1, off: 1, unknown: 1 })
})
