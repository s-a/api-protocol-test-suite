import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectionFromPath, selectionPath } from './routes.ts'

const workspace = {
  collections: [
    { id: 'default', items: [] },
    {
      id: 'API / v1',
      items: [{ id: '..', type: 'folder', auth: { type: 'inherit' }, items: [{ id: 'check?x=#', type: 'request' }] }],
    },
  ],
  environments: [{ id: 'Büro' }],
}

test('workspace URLs restore each sidebar entry after browser URL parsing', () => {
  const selections = [
    { kind: 'collection', collectionId: 'API / v1' },
    { kind: 'item', collectionId: 'API / v1', itemId: '..' },
    { kind: 'item', collectionId: 'API / v1', itemId: 'check?x=#' },
    { kind: 'environment', environmentId: 'Büro' },
  ]

  for (const selection of selections) {
    const { pathname } = new URL(selectionPath(selection), 'http://localhost')
    assert.deepEqual(selectionFromPath(workspace, pathname), selection)
  }
})

test('stale or invalid workspace routes fall back to an existing entry', () => {
  const itemPath = selectionPath({ kind: 'item', collectionId: 'API / v1', itemId: 'deleted' })
  assert.deepEqual(selectionFromPath(workspace, itemPath), { kind: 'collection', collectionId: 'API / v1' })
  assert.deepEqual(selectionFromPath(workspace, '/environments/~%ZZ'), { kind: 'collection', collectionId: 'default' })
  assert.equal(selectionFromPath({ collections: [], environments: [] }, '/collections/~deleted'), null)
})
