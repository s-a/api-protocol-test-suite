import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findItem, updateItems } from './tree.ts'

const request = { id: 'request', name: 'Probe', type: 'request', auth: { type: 'inherit' } }
const folder = { id: 'folder', name: 'Child', type: 'folder', auth: { type: 'inherit' }, items: [request] }
const parent = { id: 'parent', name: 'Parent', type: 'folder', auth: { type: 'bearer', token: 'token' }, items: [folder] }
const items = [parent]

test('finds nested items and reports the closest explicit authorization source', () => {
  assert.deepEqual(findItem(items, request.id), { item: request, authorizationSource: parent })
  assert.deepEqual(findItem(items, parent.id), { item: parent, authorizationSource: undefined })
  assert.equal(findItem(items, 'missing'), undefined)
})

test('edits and removes nested items without mutating the original tree', () => {
  const renamed = { ...request, name: 'New probe' }
  assert.deepEqual(updateItems(items, request.id, renamed), [{ ...parent, items: [{ ...folder, items: [renamed] }] }])
  assert.deepEqual(updateItems(items, folder.id), [{ ...parent, items: [] }])
  assert.deepEqual(items, [parent])
})
