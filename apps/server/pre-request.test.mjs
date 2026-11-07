import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPreRequest } from './pre-request.mjs'
import { generators } from './postman-runtime.mjs'
import { generateDynamicValue } from './postman-variables.mjs'

test('uses every dynamic generator published by the installed Postman Collection SDK', () => {
  assert.ok(Object.keys(generators).length > 100)
  for (const name of Object.keys(generators)) assert.equal(typeof generateDynamicValue(name), 'string', name)
  assert.equal(generateDynamicValue('$unknownTestVariable'), undefined)
})

test('resolves the complete dynamic variable catalog inside Postman scripts', async () => {
  const names = Object.keys(generators)
  const script = `for (const name of ${JSON.stringify(names)}) {
    pm.variables.set(name, pm.variables.replaceIn("{{" + name + "}}"));
  }`
  const { variables } = await runPreRequest([script], { method: 'GET', headers: [] }, {})
  for (const name of names) {
    assert.equal(typeof variables[name], 'string', name)
    assert.notEqual(variables[name], `{{${name}}}`, name)
  }
})

test('runs JavaScript in scope order and generates a new GUID before sending', async () => {
  const scripts = [
    'pm.variables.set("name", "X-Request-ID")',
    'pm.request.headers.upsert({ key: pm.variables.get("name"), value: pm.variables.replaceIn("{{$guid}}") })',
  ]
  const request = { method: 'GET', headers: [['x-request-id', 'old']] }
  const { headers: first } = await runPreRequest(scripts, request, {})
  const { headers: second } = await runPreRequest(scripts, request, {})
  assert.equal(first.length, 1)
  assert.match(first[0][1], /^[0-9a-f-]{14}4[0-9a-f-]{21}$/)
  assert.notEqual(first[0][1], second[0][1])
  assert.deepEqual(request.headers, [['x-request-id', 'old']])
})

test('stops runaway scripts and keeps Node globals outside the sandbox', async () => {
  const request = { method: 'GET', headers: [] }
  await assert.rejects(runPreRequest(['while (true) {}'], request, {}), /timed out/)
  await assert.rejects(runPreRequest(['process.env'], request, {}), /script failed/)
})
