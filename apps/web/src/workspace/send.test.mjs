import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareSend } from './send.ts'
import { defaultJwt } from '../../../server/jwt-settings.ts'

test('Send leaves dynamic GUID header values for the server to generate', () => {
  const request = { method: 'GET', url: 'https://example.test/', auth: { type: 'none' }, headers: [
    { key: 'X-Request-ID', value: '{{$guid}}', enabled: true },
    { key: 'X-Correlation-ID', value: '{{$randomUUID}}', enabled: true },
  ] }
  assert.deepEqual(prepareSend(request, {}).headers, [['X-Request-ID', '{{$guid}}'], ['X-Correlation-ID', '{{$randomUUID}}']])
})

test('Send resolves enabled variables and inherited authorization without changing the draft', () => {
  const request = { method: 'POST', url: '{{baseUrl}}probe', body: '{"key":"{{id}}"}', auth: { type: 'inherit' }, headers: [
    { key: 'X-ID', value: '{{id}}', enabled: true }, { key: 'X-Disabled', value: '{{missing}}', enabled: false },
  ] }
  const source = { type: 'bearer', token: '{{token}}' }
  assert.deepEqual(prepareSend(request, { baseUrl: 'https://example.test/', id: '1', token: 'sample' }, source), {
    method: 'POST', url: 'https://example.test/probe', body: '{"key":"1"}', headers: [['X-ID', '1']],
    authorization: { type: 'bearer', token: 'sample' },
  })
  assert.equal(request.url, '{{baseUrl}}probe')
  assert.throws(() => prepareSend(request, {}, source), /Unresolved variables: baseUrl, id, token/)
})

test('Send adds a raw JSON content type and respects a manually enabled header', () => {
  const request = { method: 'POST', url: 'https://example.test/', auth: { type: 'none' }, body: '{}', bodyFormat: 'json', headers: [] }
  assert.deepEqual(prepareSend(request, {}).headers, [['Content-Type', 'application/json']])
  request.headers = [{ key: 'content-type', value: 'application/vnd.test+json', enabled: true }]
  assert.deepEqual(prepareSend(request, {}).headers, [['content-type', 'application/vnd.test+json']])
})

test('Send resolves inherited JWT settings and leaves signing to the server', () => {
  const request = { method: 'GET', url: 'https://example.test/', auth: { type: 'inherit' }, headers: [] }
  const jwt = { ...defaultJwt, secretRef: '{{local-key}}', payload: '{"sub":"{{subject}}"}' }
  assert.deepEqual(prepareSend(request, { subject: 'example-user' }, jwt), {
    method: 'GET', url: request.url, headers: [], body: undefined,
    jwt: { ...jwt, secretRef: 'local-key', payload: '{"sub":"example-user"}' },
  })
})
