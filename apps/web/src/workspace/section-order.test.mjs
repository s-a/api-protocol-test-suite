import assert from 'node:assert/strict'
import test from 'node:test'
import { moveSection, orderSections } from './section-order.ts'

const sections = ['a', 'b', 'c'].map(id => ({ id, name: id }))

test('local order ignores stale and repeated IDs and appends new sections', () => {
  assert.deepEqual(orderSections(sections, ['deleted', 'c', 'a', 'c']), [sections[2], sections[0], sections[1]])
  assert.deepEqual(sections.map(({ id }) => id), ['a', 'b', 'c'])
})

test('moves a section before or after the drop target without changing the input', () => {
  const order = ['a', 'b', 'c']
  assert.deepEqual(moveSection(order, 'c', 'a', false), ['c', 'a', 'b'])
  assert.deepEqual(moveSection(order, 'a', 'c', true), ['b', 'c', 'a'])
  assert.equal(moveSection(order, 'a', 'a', true), order)
  assert.equal(moveSection(order, 'a', 'deleted', true), order)
  assert.deepEqual(order, ['a', 'b', 'c'])
})
