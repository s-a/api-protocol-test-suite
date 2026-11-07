import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, unzipSync } from 'fflate'
import { parse } from 'yaml'
import { exportPostmanZip, importPostmanCollection, importPostmanZip, PostmanExchangeError } from './postman.mjs'
import { defaultJwt } from './jwt-settings.ts'

const definition = 'Sample/.resources/definition.yaml'
const requestPath = 'Sample/Health/Probe.request.yaml'
const examplePath = 'Sample/Health/.resources/Probe.resources/examples/200.example.yaml'
const otherRequest = 'Sample/Health/Stream.request.yaml'
const assets = {
  [definition]: '$kind: collection\nname: Sample\nauth: {type: noauth}\nvariables: [{key: name, value: Sample}]\n',
  'Sample/Health/.resources/definition.yaml': '$kind: collection\norder: 4000\n',
  [requestPath]: '$kind: http-request\nmethod: POST\nurl: "{{baseUrl}}/status"\nheaders: [{key: X-Test, value: Test, disabled: true, description: Example}]\nbody: {type: json, content: "{}"}\nauth: {type: bearer, credentials: [{key: token, value: "{{token}}"}]}\nexamples: ./.resources/Probe.resources/examples/\nscripts: [{type: beforeRequest, code: "pm.variables.set(\'key\', \'value\')"}]\n',
  [examplePath]: '$kind: http-example\nresponse: {body: {type: text, content: OK}}\n',
  [otherRequest]: '$kind: websocket-request\nurl: wss://example.com\n',
  'Sample/Health/.resources/Probe.resources/payload.bin': Buffer.from([0, 128, 255]),
}

function archive(files) {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content)])))
}

test('exports JWT settings using Postman credentials and a variable reference', () => {
  const auth = { ...defaultJwt, secretRef: 'server-key', base64: true, payload: '{"sub":"{{user}}"}' }
  const bytes = exportPostmanZip({ name: 'JWT', auth, items: [] })
  const definition = parse(Buffer.from(unzipSync(bytes)['JWT/.resources/definition.yaml']).toString())
  assert.equal(definition.auth.type, 'jwt')
  const credentials = Object.fromEntries(definition.auth.credentials.map(({ key, value }) => [key, value]))
  assert.equal(credentials.secret, '{{server-key}}')
  assert.equal(credentials.isSecretBase64Encoded, true)
  assert.deepEqual(importPostmanZip(bytes).auth, { ...auth, secretRef: '{{server-key}}' })
})

test('imports a v3 directory and retains opaque Postman resources after supported edits', () => {
  const collection = importPostmanZip(archive(assets))
  const [folder] = collection.items
  const [request] = folder.items
  assert.equal(collection.name, 'Sample')
  assert.equal(folder.name, 'Health')
  assert.deepEqual(folder.auth, { type: 'inherit' })
  assert.deepEqual(request.auth, { type: 'bearer', token: '{{token}}' })
  assert.equal(request.body, '{}')
  assert.equal(request.bodyFormat, 'json')
  assert.equal(request.headers[0].enabled, false)
  assert.ok(collection.exchange.warnings.some(warning => warning.includes('websocket-request')))
  assert.ok(collection.exchange.warnings.some(warning => warning.includes('variables')))

  request.name = 'Probe renamed'
  request.url = '{{baseUrl}}/health'
  request.headers[0].value = 'Changed'
  request.body = '{"a": 1}'
  const exported = unzipSync(exportPostmanZip(collection))
  assert.equal(Buffer.from(exported[definition]).toString(), assets[definition])
  assert.equal(Buffer.from(exported[examplePath]).toString(), assets[examplePath])
  assert.equal(Buffer.from(exported[otherRequest]).toString(), assets[otherRequest])
  assert.deepEqual(Buffer.from(exported['Sample/Health/.resources/Probe.resources/payload.bin']), assets['Sample/Health/.resources/Probe.resources/payload.bin'])
  const yaml = parse(Buffer.from(exported[requestPath]).toString())
  assert.equal(yaml.name, request.name)
  assert.equal(yaml.url, request.url)
  assert.equal(yaml.body.type, 'json')
  assert.equal(yaml.body.content, request.body)
  assert.deepEqual(yaml.headers, [{ key: 'X-Test', value: 'Changed', disabled: true, description: 'Example' }])
  assert.equal(yaml.examples, './.resources/Probe.resources/examples/')
  assert.deepEqual(yaml.scripts, parse(assets[requestPath]).scripts)
})

test('writes new scopes and requests in the current filesystem format', () => {
  const collection = {
    name: 'My/API', auth: { type: 'basic', username: 'user', password: '{{password}}' }, items: [
      { type: 'folder', name: 'Folder', auth: { type: 'inherit' }, items: [
        { type: 'request', name: 'New', method: 'POST', url: '{{url}}', body: '', bodyFormat: 'json', headers: [], auth: { type: 'none' } },
        { type: 'request', name: 'new', method: 'GET', url: '{{url}}', headers: [], auth: { type: 'inherit' } },
      ] },
    ],
  }
  const zip = exportPostmanZip(collection)
  const files = unzipSync(zip)
  assert.ok(files['My-API/Folder/.resources/definition.yaml'])
  assert.ok(files['My-API/Folder/New.request.yaml'])
  assert.ok(files['My-API/Folder/new-2.request.yaml'])
  const imported = importPostmanZip(zip)
  assert.equal(imported.name, collection.name)
  assert.deepEqual(imported.auth, collection.auth)
  assert.equal(imported.items[0].items[0].body, '')
  assert.equal(imported.items[0].items[0].bodyFormat, 'json')
  assert.equal(imported.items[0].items[1].name, 'new')
})

test('retains unsupported authorization and body content on unrelated edits', () => {
  const source = '$kind: http-request\nmethod: POST\nurl: https://example.test\nbody: {type: urlencoded, content: [{key: a, value: b}]}\nauth: {type: apikey, credentials: [{key: key, value: abc}]}\n'
  const collection = importPostmanCollection([
    { path: 'Test.request.yml', content: Buffer.from(source).toString('base64') },
  ], 'Example')
  const [request] = collection.items
  request.name = 'Renamed'
  const files = unzipSync(exportPostmanZip(collection))
  const yaml = parse(Buffer.from(files['Example/Test.request.yaml']).toString())
  assert.deepEqual(yaml.body, parse(source).body)
  assert.deepEqual(yaml.auth, parse(source).auth)
  assert.ok(collection.exchange.warnings.some(warning => warning.includes('urlencoded')))
  assert.ok(collection.exchange.warnings.some(warning => warning.includes('apikey')))
  request.body = 'Changed'
  assert.throws(() => exportPostmanZip(collection), /preserved from Postman/)
})

test('synchronizes changed URL queries and preserves associated Postman metadata', () => {
  const source = `$kind: http-request
url: https://example.test?a=one
queryParams:
  - {key: a, value: one, description: Input}
  - {key: hidden, value: none, disabled: true}
`
  const collection = importPostmanZip(archive({ 'Example/Query.request.yaml': source }))
  const [request] = collection.items
  assert.equal(request.method, 'GET')
  request.url = 'https://example.test?a=two&switch'
  const files = unzipSync(exportPostmanZip(collection))
  const yaml = parse(Buffer.from(files['Example/Query.request.yaml']).toString())
  assert.equal(yaml.method, undefined)
  assert.deepEqual(yaml.queryParams, [
    { key: 'a', value: 'two', description: 'Input' },
    { key: 'switch', value: null },
    { key: 'hidden', value: 'none', disabled: true },
  ])
  request.url = 'https://example.test?unrelated=new'
  assert.throws(() => exportPostmanZip(collection), /would remove query parameter metadata/)
})

test('removes assets owned by a deleted imported request and keeps its unsupported sibling', () => {
  const collection = importPostmanZip(archive(assets))
  collection.items[0].items = []
  const files = unzipSync(exportPostmanZip(collection))
  assert.ok(files[definition])
  assert.ok(files[otherRequest])
  assert.equal(files[requestPath], undefined)
  assert.equal(files[examplePath], undefined)
})

test('rejects legacy collection exports and unsafe or ambiguous archive paths', () => {
  for (const files of [
    { 'old.json': '{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[]}' },
    { ...assets, '../outside': 'no' },
    { ...assets, 'Sample/Health/PROBE.request.yaml': assets[requestPath] },
    { ...assets, 'Sample/health/A.request.yaml': assets[requestPath] },
    { ...assets, 'Sample/Health/Probe.request.yml': assets[requestPath] },
  ]) {
    assert.throws(() => importPostmanZip(archive(files)), PostmanExchangeError)
  }
})
