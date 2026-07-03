/**
 * Unit specs for the YOLO plugin's pure COCO class helpers (config
 * (de)serialization). No React/DOM — run under node:test with the other
 * src/plugins/*.spec.ts files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COCO_CLASSES,
  parseClasses,
  serializeClasses,
  toggleClass,
} from './yolo/classes.ts'

test('there are 80 COCO classes in canonical order', () => {
  assert.equal(COCO_CLASSES.length, 80)
  assert.equal(COCO_CLASSES[0], 'person')
  assert.equal(COCO_CLASSES[2], 'car')
  assert.equal(COCO_CLASSES[COCO_CLASSES.length - 1], 'toothbrush')
})

test('parseClasses cleans, lowercases, de-dupes and drops unknowns', () => {
  assert.deepEqual(parseClasses('person, Car ,person,unicorn'), ['person', 'car'])
  assert.deepEqual(parseClasses(''), [])
  assert.deepEqual(parseClasses(undefined), [])
  assert.deepEqual(parseClasses(null), [])
})

test('serializeClasses preserves canonical COCO order regardless of input order', () => {
  // car (id 2) comes before dog (id 16) before person? person is id 0.
  assert.equal(serializeClasses(['dog', 'car', 'person']), 'person,car,dog')
  assert.equal(serializeClasses([]), '')
  // unknowns dropped
  assert.equal(serializeClasses(['unicorn', 'cat']), 'cat')
})

test('toggleClass adds then removes a class, staying ordered', () => {
  let csv = ''
  csv = toggleClass(csv, 'car')
  assert.equal(csv, 'car')
  csv = toggleClass(csv, 'person')
  assert.equal(csv, 'person,car') // canonical order
  csv = toggleClass(csv, 'car')
  assert.equal(csv, 'person')
  // toggling an unknown is a no-op
  assert.equal(toggleClass('person', 'unicorn'), 'person')
})
