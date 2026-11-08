import assert from 'node:assert/strict'
import test from 'node:test'
import { searchWorkspace } from './search.ts'

const workspace = {
  sections: [{ id: 's', name: 'Billing', collectionIds: ['c'], environmentId: 'e' }],
  collections: [{ id: 'c', name: 'Payments', auth: { type: 'none' }, items: [
    { id: 'f', name: 'Accounts', type: 'folder', auth: { type: 'inherit' }, items: [
      { id: 'r', name: 'Get customer', type: 'request', auth: { type: 'inherit' }, method: 'GET',
        url: 'https://example.org/customer', headers: [{ id: 'h', key: 'X-Region', value: 'north', enabled: true }],
        body: '{"reference":"order-123"}', preRequest: 'const marker = "special-script"' },
    ] },
  ] }],
  environments: [{ id: 'e', name: 'Staging', variables: [{ id: 'v', key: 'serviceEndpoint', value: 'private-value', enabled: true }] }],
  activeEnvironmentId: 'e',
}

test('searches nested request content and provides a navigable path', () => {
  for (const query of ['order-123', 'X-Region north', 'special-script', 'example.org']) {
    const [result] = searchWorkspace(workspace, query)
    assert.deepEqual(result.selection, { kind: 'item', collectionId: 'c', itemId: 'r' })
    assert.equal(result.path, 'Billing / Payments / Accounts')
  }
})

test('finds approximate names and environment values without exposing matching content', () => {
  assert.equal(searchWorkspace(workspace, 'custmer')[0].name, 'Get customer')
  const [result] = searchWorkspace(workspace, 'private-value')
  assert.deepEqual(result.selection, { kind: 'environment', environmentId: 'e' })
  assert.equal(JSON.stringify(result).includes('private-value'), false)
  assert.deepEqual(searchWorkspace(workspace, '   '), [])
  assert.deepEqual(searchWorkspace(workspace, 'nonexistent-value'), [])
})
