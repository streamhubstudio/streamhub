/**
 * Unit specs for the config-schema form model (pure).
 * Run with Node's built-in runner: `npm run test` → `node --test src/plugins/*.spec.ts`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInitialValues,
  coerceValue,
  defaultForField,
  pruneValues,
  validateValues,
} from './schema.ts'
import type { ConfigSchema } from './types.ts'

const schema: ConfigSchema = {
  fields: [
    { key: 'apiKey', type: 'secret', label: 'API key', required: true },
    { key: 'endpoint', type: 'url', label: 'Endpoint', default: 'https://x' },
    { key: 'threshold', type: 'number', label: 'Threshold', min: 0, max: 10 },
    { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
    {
      key: 'mode',
      type: 'select',
      label: 'Mode',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      default: 'a',
    },
  ],
}

test('defaultForField: declared default wins, boolean defaults false', () => {
  assert.equal(defaultForField(schema.fields[1]), 'https://x')
  assert.equal(defaultForField({ key: 'x', type: 'boolean', label: 'x' }), false)
  assert.equal(defaultForField({ key: 'x', type: 'string', label: 'x' }), undefined)
})

test('buildInitialValues: defaults overlaid by stored values, unknown keys dropped', () => {
  const init = buildInitialValues(schema, { threshold: 5, junk: 'nope' } as never)
  assert.deepEqual(init, {
    endpoint: 'https://x',
    threshold: 5,
    enabled: true,
    mode: 'a',
  })
  // required secret has no default → absent (not "")
  assert.equal('apiKey' in init, false)
  // unknown stored key must not leak through
  assert.equal('junk' in init, false)
})

test('buildInitialValues: no schema → empty bag', () => {
  assert.deepEqual(buildInitialValues(undefined, { a: 1 }), {})
})

test('coerceValue: numbers/booleans/empties', () => {
  const num = schema.fields[2]
  assert.equal(coerceValue(num, '7'), 7)
  assert.equal(coerceValue(num, ''), undefined)
  assert.ok(Number.isNaN(coerceValue(num, 'abc') as number))
  assert.equal(coerceValue(schema.fields[3], 'on' as never), true)
  assert.equal(coerceValue(schema.fields[0], ''), undefined)
  assert.equal(coerceValue(schema.fields[0], 'hi'), 'hi')
})

test('validateValues: required missing → error code', () => {
  const res = validateValues(schema, buildInitialValues(schema))
  assert.equal(res.valid, false)
  assert.equal(res.errors.apiKey, 'required')
})

test('validateValues: number range + select membership', () => {
  const base = { apiKey: 'k', endpoint: 'https://x', enabled: true, mode: 'a' }
  assert.equal(validateValues(schema, { ...base, threshold: 5 }).valid, true)
  assert.equal(validateValues(schema, { ...base, threshold: -1 }).errors.threshold, 'min')
  assert.equal(validateValues(schema, { ...base, threshold: 99 }).errors.threshold, 'max')
  assert.equal(validateValues(schema, { ...base, threshold: 'x' as never }).errors.threshold, 'nan')
  assert.equal(validateValues(schema, { ...base, mode: 'z' }).errors.mode, 'notInOptions')
})

test('validateValues: no schema is always valid', () => {
  assert.deepEqual(validateValues(undefined, {}), { valid: true, errors: {} })
})

test('pruneValues: strips undefined', () => {
  assert.deepEqual(pruneValues({ a: 1, b: undefined, c: 'x' }), { a: 1, c: 'x' })
})
