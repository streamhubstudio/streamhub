/**
 * Unit specs for the shared byte formatter (pure).
 * Run with Node's built-in runner: `npm run test` → `node --test src/**\/*.spec.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from './bytes.ts'

test('formatBytes: empty / invalid inputs render the placeholder', () => {
  assert.equal(formatBytes(undefined), '—')
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(0), '—')
  assert.equal(formatBytes(-100), '—')
  assert.equal(formatBytes(Number.NaN), '—')
  // custom placeholder is honoured
  assert.equal(formatBytes(0, '0 B'), '0 B')
})

test('formatBytes: bytes below 1 KB show as whole bytes', () => {
  assert.equal(formatBytes(1), '1 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1023), '1023 B')
})

test('formatBytes: scales to binary units (1024-based)', () => {
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(5 * 1024 * 1024 * 1024), '5.0 GB')
  assert.equal(formatBytes(1024 ** 4), '1.0 TB')
})

test('formatBytes: drops the decimal at or above 100 of a unit', () => {
  assert.equal(formatBytes(100 * 1024), '100 KB')
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB')
})

test('formatBytes: caps at the largest unit (PB)', () => {
  assert.equal(formatBytes(1024 ** 5), '1.0 PB')
  // Beyond PB it keeps scaling within PB rather than inventing a unit.
  assert.equal(formatBytes(1024 ** 6), '1024 PB')
})
