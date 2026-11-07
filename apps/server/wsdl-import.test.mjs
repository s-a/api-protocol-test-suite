import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { parse } from 'yaml'
import { prepareSend } from '../web/src/workspace/send.ts'
import { startServer } from './test-support/server.mjs'

const schema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:example">
  <xs:element name="Echo" type="xs:string"/>
  <xs:element name="EchoResponse" type="xs:string"/>
</xs:schema>`

function wsdl11(endpoint) {
  return `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:example"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" targetNamespace="urn:example">
  <types>${schema}</types>
  <message name="EchoInput"><part name="parameters" element="tns:Echo"/></message>
  <message name="EchoOutput"><part name="parameters" element="tns:EchoResponse"/></message>
  <portType name="EchoPort"><operation name="Echo">
    <input message="tns:EchoInput"/><output message="tns:EchoOutput"/>
  </operation></portType>
  <binding name="EchoBinding" type="tns:EchoPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Echo">
      <soap:operation soapAction="urn:example:Echo"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="EchoService"><port name="EchoEndpoint" binding="tns:EchoBinding">
    <soap:address location="${endpoint}"/>
  </port></service>
</definitions>`
}

function wsdl20(endpoint) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<description xmlns="http://www.w3.org/ns/wsdl" xmlns:tns="urn:example"
    xmlns:wsoap="http://www.w3.org/ns/wsdl/soap" targetNamespace="urn:example">
  <types>${schema}</types>
  <interface name="EchoPort"><operation name="Echo" pattern="http://www.w3.org/ns/wsdl/in-out">
    <input element="tns:Echo"/><output element="tns:EchoResponse"/>
  </operation></interface>
  <binding name="EchoBinding" interface="tns:EchoPort" type="http://www.w3.org/ns/wsdl/soap"
      wsoap:protocol="http://www.w3.org/2003/05/soap/bindings/HTTP/">
    <operation ref="tns:Echo" wsoap:action="urn:example:Echo"/>
  </binding>
  <service name="EchoService" interface="tns:EchoPort">
    <endpoint name="EchoEndpoint" binding="tns:EchoBinding" address="${endpoint}"/>
  </service>
</description>`
}

test('imports WSDL by URL and file and exports SOAP requests with their examples', { timeout: 15000 }, async (t) => {
  const upstream = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/echo?WSDL' }).end()
    } else if (request.url === '/blocked-redirect') {
      response.writeHead(302, { Location: 'http://localhost:1/echo?WSDL' }).end()
    } else {
      response.writeHead(200, { 'Content-Type': 'text/xml' }).end(wsdl11(endpoint))
    }
  })
  upstream.listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  await once(upstream, 'listening')
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`
  const endpoint = `${baseUrl}/echo`
  const { address, request, targets } = await startServer(t)
  const importUrl = url => request(`${address}/api/collections/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: t.signal,
  })
  const blocked = await importUrl(`${baseUrl}/redirect`)
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).code, 'target_not_allowed')
  await targets('add', 'wsdl', baseUrl)
  const blockedRedirect = await importUrl(`${baseUrl}/blocked-redirect`)
  assert.equal(blockedRedirect.status, 403)
  assert.equal((await blockedRedirect.json()).code, 'target_not_allowed')

  const imports = [
    { type: 'application/json', body: JSON.stringify({ url: `${baseUrl}/redirect` }),
      headers: [['Content-Type', 'text/xml; charset=utf-8'], ['SOAPAction', '"urn:example:Echo"']],
      namespace: 'http://schemas.xmlsoap.org/soap/envelope/' },
    { type: 'application/wsdl+xml', body: Buffer.from(`\ufeff${wsdl20(endpoint)}`, 'utf16le'),
      headers: [['Content-Type', 'application/soap+xml; charset=utf-8; action="urn:example:Echo"']],
      namespace: 'http://www.w3.org/2003/05/soap-envelope' },
  ]
  for (const { type, body, headers, namespace } of imports) {
    const response = await request(`${address}/api/collections/import`, {
      method: 'POST', headers: { 'Content-Type': type }, body, signal: t.signal,
    })
    assert.equal(response.status, 201)
    const collection = (await response.json()).collections.at(-1)
    assert.equal(collection.name, 'EchoService')
    assert.deepEqual(collection.exchange.variables, { EchoEndpointBaseUrl: baseUrl })
    const [item] = collection.items
    assert.equal(item.name, 'Echo')
    assert.equal(item.bodyFormat, 'xml')
    const send = prepareSend(item, collection.exchange.variables)
    assert.equal(send.url, endpoint)
    assert.equal(send.method, 'POST')
    assert.deepEqual(send.headers, headers)
    assert.ok(send.body.includes(namespace))
    const exported = await request(`${address}/api/collections/${collection.id}/export`, { signal: t.signal })
    assert.equal(exported.status, 200)
    const files = unzipSync(new Uint8Array(await exported.arrayBuffer()))
    const example = parse(Buffer.from(files['EchoService/Echo.resources/examples/1.example.yaml']).toString())
    assert.equal(example.$kind, 'http-example')
    assert.deepEqual(example.request.headers, headers.map(([key, value]) => ({ key, value })))
    assert.equal(example.response.statusCode, 200)
    assert.ok(example.response.body.content.includes(namespace))
  }
})

test('rejects invalid and external WSDL inputs before saving a collection', { timeout: 15000 }, async (t) => {
  const { address, request } = await startServer(t)
  const wsdl = wsdl11('http://localhost/echo')
  const attempts = [
    ['application/wsdl+xml', '<definitions', 400, /Invalid WSDL XML/],
    ['application/xml', wsdl.replace('<types>', '<import namespace="urn:external" location="other.wsdl"/><types>'),
      400, /self-contained WSDL/],
    ['text/xml', `<!DOCTYPE definitions>${wsdl}`, 400, /DTD/],
    ['application/wsdl+xml', Buffer.alloc(2 * 1024 * 1024 + 1), 413, /exceeds 2 MiB/],
    ['application/json', JSON.stringify({ url: 'file:///echo.wsdl' }), 400, /HTTP or HTTPS/],
  ]
  for (const [type, body, status, message] of attempts) {
    const response = await request(`${address}/api/collections/import`, {
      method: 'POST', headers: { 'Content-Type': type }, body, signal: t.signal,
    })
    assert.equal(response.status, status)
    assert.match((await response.json()).error, message)
  }
  const response = await request(`${address}/api/workspace`, { signal: t.signal })
  const workspace = await response.json()
  assert.deepEqual(workspace.collections, [])
})
