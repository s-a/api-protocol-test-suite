import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewVariables } from './variables.ts'

test('substitutes active environment values and reports unique missing variables', () => {
  assert.deepEqual(previewVariables('{{baseUrl}}api/{{tenant}}?id={{id}}&other={{id}}', {
    baseUrl: 'https://api.example.test/',
    tenant: '42',
  }), {
    value: 'https://api.example.test/api/42?id={{id}}&other={{id}}',
    unresolved: ['id'],
  })
})

test('does not resolve references through inherited object properties or expand values recursively', () => {
  assert.deepEqual(previewVariables('{{toString}} {{path}} {{empty}}', { path: '{{id}}', empty: '' }), {
    value: '{{toString}} {{id}} ',
    unresolved: ['toString'],
  })
})
