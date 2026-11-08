import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { startServer } from './test-support/server.mjs'
import { prepareSend } from '../web/src/workspace/send.ts'

test('downloads a collection ZIP and imports a copy through the workspace API', { timeout: 15000 }, async (t) => {
  const { address: base, request: fetch } = await startServer(t)
  const request = (path, options) => fetch(`${base}${path}`, {
    ...options, headers: { 'App-Tab-Id': 'a'.repeat(32), ...options?.headers }, signal: t.signal,
  })
  assert.equal((await request('/api/app-tab', { method: 'PUT' })).status, 204)

  const workspace = await (await request('/api/workspace')).json()
  const source = {
    id: 'example-api', name: 'Example API', auth: { type: 'none' }, items: [{
      id: 'status', name: 'Status', type: 'request', method: 'GET',
      url: '{{baseUrl}}/status', auth: { type: 'inherit' }, headers: [],
    }],
  }
  const seeded = await request('/api/workspace', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...workspace, collections: [source] }),
  })
  assert.equal(seeded.status, 200)
  const original = await seeded.json()
  const exported = await request(`/api/collections/${encodeURIComponent(source.id)}/export`)
  assert.equal(exported.status, 200)
  assert.equal(exported.headers.get('content-type'), 'application/zip')
  assert.match(exported.headers.get('content-disposition'), /^attachment;/)
  const zip = await exported.arrayBuffer()

  const rejected = await request('/api/collections/import', {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: 'not a ZIP',
  })
  assert.equal(rejected.status, 400)

  const imported = await request('/api/collections/import', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', 'Workspace-Section': 'root' }, body: zip,
  })
  assert.equal(imported.status, 201)
  const result = await imported.json()
  assert.equal(result.collections.length, original.collections.length + 1)
  const copy = result.collections.at(-1)
  assert.notEqual(copy.id, source.id)
  assert.equal(copy.name, source.name)
  assert.equal(copy.items[0].url, source.items[0].url)
  assert.equal(copy.exchange?.files, undefined)
  assert.equal((await request('/api/collections/missing/export')).status, 404)

  copy.items[0].url = '{{baseUrl}}/health'
  const saved = await request('/api/workspace', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result),
  })
  assert.equal(saved.status, 200)
  const updatedZip = await request(`/api/collections/${encodeURIComponent(copy.id)}/export`)
  assert.equal(updatedZip.status, 200)
  const archive = unzipSync(new Uint8Array(await updatedZip.arrayBuffer()))
  const rootName = Object.keys(archive)[0].split('/')[0]
  const files = Object.entries(archive).filter(([path]) => !path.endsWith('/')).map(([path, content]) => ({
    path: path.slice(rootName.length + 1), content: Buffer.from(content).toString('base64'),
  }))
  const resource = { path: '.resources/retained.bin', content: 'AP8=' }
  files.push(resource)
  const importedDirectory = await request('/api/collections/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootName, files }),
  })
  assert.equal(importedDirectory.status, 201)
  const directoryCopy = (await importedDirectory.json()).collections.at(-1)
  assert.equal(directoryCopy.items[0].url, copy.items[0].url)
  assert.ok(directoryCopy.exchange.warnings.some(warning => warning.includes(resource.path)))
  const directoryExport = await request(`/api/collections/${directoryCopy.id}/export`)
  assert.equal(directoryExport.status, 200)
  const retainedArchive = unzipSync(new Uint8Array(await directoryExport.arrayBuffer()))
  assert.equal(Buffer.from(retainedArchive[`${rootName}/${resource.path}`]).toString('base64'), resource.content)
})

test('imports a collection with its environment without replacing existing variables', { timeout: 15000 }, async (t) => {
  const { address, request: fetch } = await startServer(t)
  const request = (path, options) => fetch(address + path, { ...options, signal: t.signal })
  const variables = [
    { id: 'base-url', key: 'baseUrl', value: 'https://example.invalid', enabled: true },
    { id: 'disabled', key: 'unused', value: '', enabled: false },
  ]
  const collection = { id: 'source', name: 'Example', auth: { type: 'none' }, items: [] }
  const save = data => request('/api/workspace', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  assert.equal((await save({ collections: [collection], activeEnvironmentId: 'source-env',
    environments: [{ id: 'source-env', name: 'Example Environment', variables }],
  })).status, 200)
  const exported = await request('/api/collections/source/export')
  assert.equal(exported.status, 200)
  const zip = await exported.arrayBuffer()
  const existing = { id: 'existing', name: 'Example Environment', variables: [
    { ...variables[0], value: 'https://other.example.invalid' },
  ] }
  assert.equal((await save({ collections: [], activeEnvironmentId: existing.id, environments: [existing] })).status, 200)

  const upload = () => request('/api/collections/import', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', 'Workspace-Section': 'root' }, body: zip,
  })
  for (const count of [1, 2]) {
    assert.equal((await upload()).status, 201)
    const result = await (await request('/api/workspace')).json()
    const [original, imported] = result.environments
    assert.equal(result.environments.length, 2)
    assert.deepEqual(original, existing)
    assert.equal(imported.name, existing.name)
    assert.deepEqual(imported.variables.map(({ key, value, enabled }) => ({ key, value, enabled })),
      variables.map(({ key, value, enabled }) => ({ key, value, enabled })))
    const section = result.sections.find(({ environmentId }) => environmentId === imported.id)
    assert.equal(section.collectionIds.length, count)
    assert.deepEqual(section.collectionIds, result.collections.map(({ id }) => id))
  }
})

test('sends imported SOAP XML using collection variables in the URL, headers, body and scripts', { timeout: 15000 }, async (t) => {
  const soapNamespace = 'http://www.w3.org/2003/05/soap-envelope'
  const envelope = content => `<soap:Envelope xmlns:soap="${soapNamespace}"><soap:Body>${content}</soap:Body></soap:Envelope>`
  const soapResponse = envelope('<ReadExampleItemsResponse xmlns="urn:example:catalog"/>')
  const mediaType = 'application/soap+xml; charset=utf-8'
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const matches = request.method === 'POST' && request.url === '/soap/example-catalog' &&
      request.headers['content-type'] === `${mediaType}; action="urn:example:catalog/ReadExampleItems"` &&
      body === envelope('<ReadExampleItems xmlns="urn:example:catalog"><Scope>environment</Scope></ReadExampleItems>')
    response.writeHead(matches ? 200 : 400, { 'Content-Type': mediaType })
    response.end(soapResponse)
  })
  upstream.listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  await once(upstream, 'listening')
  const { address, request, targets } = await startServer(t)
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`
  await targets('add', 'example-catalog', baseUrl)
  const definition = strToU8(`$kind: collection
name: ExampleCatalog
variables:
  - { key: baseUrl, value: '${baseUrl}' }
  - { key: action, value: 'urn:example:catalog/ReadExampleItems' }
  - { key: scope, value: collection }
  - { key: action, value: 'urn:disabled', disabled: true }
`)
  const zip = zipSync({
    'ExampleCatalog/.resources/definition.yaml': definition,
    'ExampleCatalog/ReadExampleItems.request.yaml': strToU8(`$kind: http-request
name: ReadExampleItems
url: '{{baseUrl}}/soap/example-catalog'
method: POST
headers:
  - key: Content-Type
    value: '${mediaType}; action="{{action}}"'
body:
  type: xml
  content: '${envelope('<ReadExampleItems xmlns="urn:example:catalog"><Scope>{{scope}}</Scope></ReadExampleItems>')}'
`),
  })
  const imported = await request(`${address}/api/collections/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip, signal: t.signal,
  })
  assert.equal(imported.status, 201)
  const collection = (await imported.json()).collections.at(-1)
  const variables = collection.exchange.variables
  assert.deepEqual(variables, { baseUrl, action: 'urn:example:catalog/ReadExampleItems', scope: 'collection' })
  const environment = { scope: 'environment' }
  const [item] = collection.items
  assert.equal(item.bodyFormat, 'xml')
  for (const withScripts of [false, true]) {
    const payload = prepareSend(item, { ...variables, ...environment }, undefined, withScripts)
    const sent = await request(`${address}/api/requests/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: t.signal,
      body: JSON.stringify({ ...payload, ...(withScripts && {
        scriptVariables: environment, collectionVariables: variables,
        scripts: ['pm.collectionVariables.set("probe", "from pre-request"); pm.variables.set("local", "local value");'],
        postScripts: [`pm.test("SOAP XML and variable scopes", () => {
          pm.expect(pm.collectionVariables.get("probe")).to.equal("from pre-request");
          pm.expect(pm.collectionVariables.get("scope")).to.equal("collection");
          pm.expect(pm.variables.get("scope")).to.equal("environment");
          pm.expect(pm.variables.get("local")).to.equal("local value");
          pm.expect(xml2Json(pm.response.text())["soap:Envelope"]["soap:Body"]).to.have.property("ReadExampleItemsResponse");
        });`],
      }) }),
    })
    assert.equal(sent.status, 200)
    const result = await sent.json()
    assert.equal(result.status, 200)
    assert.equal(result.body, soapResponse)
    if (withScripts) assert.equal(result.postResponse?.assertions?.[0]?.passed, true, JSON.stringify(result.postResponse))
  }
  const exported = await request(`${address}/api/collections/${collection.id}/export`, { signal: t.signal })
  assert.equal(exported.status, 200)
  const archive = unzipSync(new Uint8Array(await exported.arrayBuffer()))
  assert.deepEqual(archive['ExampleCatalog/.resources/definition.yaml'], definition)
})
