import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { login, startServer } from './test-support/server.mjs'
import { hashPassword, updateAccounts } from './accounts.mjs'

test('GET /api/health returns the server status', { timeout: 5000 }, async (t) => {
  const { address, request: fetch } = await startServer(t)
  const response = await fetch(`${address}/api/health`, { signal: t.signal })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
})

test('an account can use only one app tab across separate sign-ins', { timeout: 10000 }, async t => {
  const { address, request, accountsFile } = await startServer(t)
  const signedIn = await login(address)
  assert.equal(signedIn.status, 303)
  const cookie = signedIn.headers.get('Set-Cookie').split(';')[0]
  const path = address + '/api/app-tab'
  const tab = (method, id, extra = {}) => ({
    method, headers: { 'App-Tab-Id': id.repeat(32), ...extra }, signal: t.signal,
  })
  const firstTab = await request(path, tab('PUT', 'a'))
  assert.equal(firstTab.status, 204)
  const firstAccountId = firstTab.headers.get('App-Account-Id')
  assert.match(firstAccountId, /^[a-f0-9]{32}$/)
  assert.equal((await request(path, tab('PUT', 'b'))).status, 409)
  assert.equal((await fetch(path, tab('PUT', 'c', { Cookie: cookie }))).status, 409)
  assert.equal((await fetch(path, tab('DELETE', 'c', { Cookie: cookie }))).status, 204)
  assert.equal((await request(path, tab('PUT', 'b'))).status, 409)
  assert.equal((await request(path, tab('DELETE', 'a'))).status, 204)
  assert.equal((await fetch(path, tab('PUT', 'c', { Cookie: cookie }))).status, 204)
  assert.equal((await request(path, tab('PUT', 'a'))).status, 409)
  const other = { username: 'other', password: 'other account test password' }
  const otherAccount = await hashPassword(other.username, other.password)
  await updateAccounts(accounts => [...accounts, otherAccount], accountsFile)
  const otherLogin = await login(address, other)
  assert.equal(otherLogin.status, 303)
  const otherCookie = otherLogin.headers.get('Set-Cookie').split(';')[0]
  const otherTab = await fetch(path, tab('PUT', 'd', { Cookie: otherCookie }))
  assert.equal(otherTab.status, 204)
  assert.match(otherTab.headers.get('App-Account-Id'), /^[a-f0-9]{32}$/)
  assert.notEqual(otherTab.headers.get('App-Account-Id'), firstAccountId)
  assert.equal((await request(path, tab('POST', 'b'))).status, 204)
  assert.equal((await fetch(path, tab('PATCH', 'c', { Cookie: cookie }))).status, 409)
  assert.equal((await fetch(path, tab('DELETE', 'c', { Cookie: cookie }))).status, 204)
  const health = address + '/api/health'
  assert.equal((await fetch(health, tab('GET', 'c', { Cookie: cookie }))).status, 409)
  assert.equal((await request(health, tab('GET', 'b'))).status, 200)
  assert.equal((await fetch(path, tab('PATCH', 'd', { Cookie: otherCookie }))).status, 204)
  assert.equal((await request(path, tab('DELETE', 'b'))).status, 204)
  assert.equal((await fetch(path, tab('PATCH', 'c', { Cookie: cookie }))).status, 409)
})

test('the standalone TLS command creates a certificate accepted by the HTTPS server and client', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-tls-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'server.mjs')
  await copyFile(new URL('./server.mjs', import.meta.url), cli)
  await copyFile(new URL('./generate-tls-certificate.mjs', import.meta.url), join(directory, 'generate-tls-certificate.mjs'))

  const generate = (...args) => spawnSync(process.execPath, [cli, 'generate-tls-certificate', ...args], {
    cwd: directory, encoding: 'utf8',
  })
  const result = generate()
  assert.equal(result.status, 0, result.stderr)
  const certFile = join(directory, 'data', 'tls', 'cert.pem')
  const keyFile = join(directory, 'data', 'tls', 'key.pem')
  const cert = await readFile(certFile)
  const certificate = new X509Certificate(cert)
  assert.equal(certificate.checkHost('localhost', { subject: 'never' }), 'localhost')
  assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1')
  assert.equal(certificate.checkIP('::1'), '::1')
  assert.ok(certificate.checkPrivateKey(createPrivateKey(await readFile(keyFile))))
  assert.ok(certificate.verify(certificate.publicKey))
  const duplicate = generate()
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /Output directory already exists/)
  assert.deepEqual(await readFile(certFile), cert)

  const tlsEnv = { TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile }
  const { address } = await startServer(t, { ...tlsEnv, HTTPS_ENABLED: 'true' }, false)
  assert.match(address, /^https:\/\//)
  const request = get(`${address}/login`, { ca: cert, signal: t.signal })
  const [response] = await once(request, 'response')
  assert.equal(response.statusCode, 200)
  let body = ''
  for await (const chunk of response) body += chunk
  assert.match(body, /Sign in/)

  const legacy = await startServer(t, tlsEnv, false)
  assert.match(legacy.address, /^https:\/\//)
})

test('HTTPS_ENABLED=false serves HTTP even when TLS paths are set', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-http-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { address } = await startServer(t, {
    HTTPS_ENABLED: 'false',
    TLS_CERT_FILE: join(directory, 'unused-cert.pem'),
    TLS_KEY_FILE: join(directory, 'unused-key.pem'),
  }, false)
  assert.match(address, /^http:\/\//)
  const response = await fetch(`${address}/login`, { signal: t.signal })
  assert.equal(response.status, 200)
})

test('Send forwards a request and returns the upstream status, headers and body', { timeout: 10000 }, async (t) => {
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    response.writeHead(422, { 'Content-Type': 'application/json', 'X-Test': 'upstream' })
    response.end(JSON.stringify({ method: request.method, authorization: request.headers.authorization,
      requestId: request.headers['x-request-id'], body: Buffer.concat(chunks).toString() }))
  })
  upstream.listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => upstream.close(resolve)))
  await once(upstream, 'listening')
  const { address, request: fetch, targets, targetsFile } = await startServer(t)
  const payload = {
    url: `http://127.0.0.1:${upstream.address().port}/echo`, method: 'POST',
    headers: [['Authorization', 'Bearer example'], ['X-Request-ID', '{{$guid}}']], body: '{"test":true}',
  }
  const send = (data, headers = {}) => fetch(`${address}/api/requests/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data), signal: t.signal,
  })
  const origin = new URL(payload.url).origin
  const blocked = await send(payload)
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).code, 'target_not_allowed')
  await assert.rejects(targets('add', 'invalid', `${origin}/echo`), /Enter an HTTP or HTTPS origin/)
  await targets('add', 'echo', origin)
  assert.equal((await targets('list')).stdout.trim(), `echo\t${origin}`)
  const response = await send(payload)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.status, 422)
  assert.deepEqual(result.sentRequest, { method: payload.method, url: payload.url, body: payload.body })
  assert.ok(result.headers.some(([key, value]) => key === 'x-test' && value === 'upstream'))
  const { requestId, ...echo } = JSON.parse(result.body)
  assert.deepEqual(echo, { method: 'POST', authorization: 'Bearer example', body: payload.body })
  const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
  assert.match(requestId, uuidV4)
  assert.ok(result.sentHeaders.some(([name, value]) => name === 'x-request-id' && value === requestId))
  assert.ok(result.sentHeaders.some(([name, value]) => name === 'authorization' && value !== 'Bearer example'))
  const repeatedResult = await (await send(payload)).json()
  const repeated = JSON.parse(repeatedResult.body)
  assert.ok(repeatedResult.sentHeaders.some(([name, value]) => name === 'x-request-id' && value === repeated.requestId))
  assert.match(repeated.requestId, uuidV4)
  assert.notEqual(repeated.requestId, requestId)
  const scripted = await send({ ...payload, url: `${payload.url}/{{part}}`, body: '{"id":"{{runId}}"}',
    headers: [['X-Run-ID', '{{runId}}']], scriptVariables: { part: 'old' },
    scripts: [`pm.variables.set("part", "new"); pm.variables.set("runId", crypto.randomUUID());
      const check = await pm.sendRequest(${JSON.stringify(payload.url)});
      pm.request.headers.upsert({ key: "X-Script-Status", value: String(check.code) });`],
    postScripts: ['pm.test("Status", () => pm.response.to.have.status(422));'] })
  assert.equal(scripted.status, 200)
  const scriptResult = await scripted.json()
  const generated = scriptResult.sentHeaders.find(([name]) => name === 'x-run-id')[1]
  assert.match(generated, uuidV4)
  assert.deepEqual(scriptResult.sentRequest, {
    method: 'POST', url: `${payload.url}/new`, body: `{"id":"${generated}"}`,
  })
  assert.equal(JSON.parse(JSON.parse(scriptResult.body).body).id, generated)
  assert.ok(scriptResult.sentHeaders.some(([key, value]) => key === 'x-script-status' && value === '422'))
  assert.deepEqual(scriptResult.postResponse?.assertions, [{ name: 'Status', passed: true, skipped: false }])
  assert.equal((await send({ ...payload, url: 'file:///test' })).status, 400)
  assert.equal((await send(payload, { Origin: 'https://unrelated.example' })).status, 403)
  const scriptBlocked = await send({ ...payload, scripts: ['await pm.sendRequest("http://localhost:1/");'] })
  assert.equal(scriptBlocked.status, 403)
  assert.equal((await scriptBlocked.json()).code, 'target_not_allowed')
  await targets('update', 'echo', 'https://example.test')
  assert.equal((await send(payload)).status, 403)
  assert.equal((await targets('list')).stdout.trim(), 'echo\thttps://example.test:443')
  await targets('remove', 'echo')
  assert.equal((await targets('list')).stdout, '')
  await writeFile(targetsFile, '{')
  const invalidConfig = await send(payload)
  assert.equal(invalidConfig.status, 500)
  assert.equal((await invalidConfig.json()).code, 'target_configuration_error')
})

test('stores a JWT key separately and reveals it only through the explicit key route', { timeout: 10000 }, async (t) => {
  const { address, request: fetch } = await startServer(t)
  const entry = { reference: 'fixture-key', key: 'test-key-value', origin: 'https://example.test', algorithm: 'HS256' }
  const call = (route, method, payload, origin = address) => fetch(`${address}/api/jwt-keys${route}`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: t.signal,
  })
  const saved = await call('', 'PUT', entry)
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), { origin: entry.origin, algorithm: entry.algorithm })
  const revealed = await call('/reveal', 'POST', { reference: entry.reference })
  assert.equal(revealed.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await revealed.json(), { origin: entry.origin, algorithm: entry.algorithm, key: entry.key })
  assert.equal((await call('/reveal', 'POST', { reference: entry.reference }, 'https://unrelated.example')).status, 403)
  const workspace = await (await fetch(`${address}/api/workspace`, { signal: t.signal })).text()
  assert.ok(!workspace.includes(entry.key))
})

test('profiles persist multiple logins and reject outdated writes', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-profiles-test-'))
  try {
    const env = { USER_DATA_DIR: join(directory, 'users'), ACCOUNTS_FILE: join(directory, 'accounts.json') }
    const first = await startServer(t, env)
    const url = `${first.address}/api/profiles`
    const response = await first.request(url, { signal: t.signal })
    assert.equal(response.status, 200)
    const profiles = await response.json()
    assert.deepEqual(profiles, { revision: 0, connections: [] })

    profiles.connections.push({
      id: 'example-api',
      name: 'Example API',
      baseUrl: 'https://api.example.test/',
      authProfiles: [
        { id: 'basic', name: 'Testkunde A', type: 'basic', usernameVariable: 'TEST_USER', secretVariable: 'TEST_PASSWORD' },
        { id: 'bearer', name: 'Testkunde B', type: 'bearer', secretVariable: 'TEST_TOKEN' },
        {
          id: 'legacy-profile', name: 'Testkunde C', type: 'merchant-jwt',
          merchantId: 'example-merchant', pointOfUseId: 'example-pos', secretVariable: 'TEST_SIGNING_KEY',
        },
      ],
    })
    const update = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profiles),
      signal: t.signal,
    }
    const saved = await first.request(url, update)
    assert.equal(saved.status, 200)
    assert.equal((await first.request(url, update)).status, 409)
    await first.stop()

    const second = await startServer(t, env)
    const restored = await second.request(`${second.address}/api/profiles`, { signal: t.signal })
    assert.equal(restored.status, 200)
    assert.deepEqual(await restored.json(), { ...profiles, revision: profiles.revision + 1 })
    await second.stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function saveWorkspace(fetch, url, workspace, signal) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workspace),
    signal,
  })
}

test('workspace edits and the active environment survive a server restart', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-workspace-test-'))
  try {
    const env = { USER_DATA_DIR: join(directory, 'users'), ACCOUNTS_FILE: join(directory, 'accounts.json') }
    const first = await startServer(t, env)
    const url = `${first.address}/api/workspace`
    const response = await first.request(url, { signal: t.signal })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const workspace = await response.json()
    assert.deepEqual(workspace, { collections: [], environments: [], activeEnvironmentId: null })

    workspace.collections.push({
      id: 'example-api',
      name: 'Example API',
      auth: { type: 'bearer', token: '{{token}}' },
      items: [{
        id: 'examples',
        type: 'folder',
        name: 'Examples',
        auth: { type: 'inherit' },
        items: [{
          id: 'create-message',
          type: 'request',
          name: 'Create message',
          url: '{{baseUrl}}/messages',
          method: 'POST',
          auth: { type: 'basic', username: '{{user}}', password: '{{password}}' },
          headers: [{ id: 'content-type', key: 'Content-Type', value: 'application/json', enabled: true }],
          body: '  { "message": "{{message}}" }\n',
          bodyFormat: 'json',
        }],
      }],
    })
    workspace.environments.push({
      id: 'example-environment',
      name: 'Examples',
      variables: [
        { id: 'base-url', key: 'baseUrl', value: 'https://api.example.test', enabled: true },
        { id: 'message', key: 'message', value: 'hello', enabled: false },
      ],
    })
    workspace.activeEnvironmentId = 'example-environment'

    const writes = await Promise.all([
      saveWorkspace(first.request, url, workspace, t.signal),
      saveWorkspace(first.request, url, workspace, t.signal),
    ])
    assert.deepEqual(writes.map((write) => write.status), [200, 200])
    await first.stop()

    const second = await startServer(t, env)
    const restored = await second.request(`${second.address}/api/workspace`, { signal: t.signal })
    assert.equal(restored.status, 200)
    assert.deepEqual(await restored.json(), workspace)

    const head = await second.request(`${second.address}/api/workspace`, { method: 'HEAD', signal: t.signal })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    await second.stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('workspace rejects invalid edits without changing stored data', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'api-workspace-test-'))
  try {
    const env = { USER_DATA_DIR: join(directory, 'users') }
    const { address, stop, request: fetch } = await startServer(t, env)
    const url = `${address}/api/workspace`
    const original = await (await fetch(url, { signal: t.signal })).json()
    const collection = { id: 'example', name: 'Example', auth: { type: 'none' }, items: [] }
    const invalidUpdates = [
      { ...original, activeEnvironmentId: 'missing' },
      { ...original, collections: [collection, collection] },
      {
        ...original,
        collections: [{ ...collection, auth: { type: 'unsupported' } }],
      },
    ]
    for (const update of invalidUpdates) {
      const response = await saveWorkspace(fetch, url, update, t.signal)
      assert.equal(response.status, 400)
      assert.equal(typeof (await response.json()).error, 'string')
    }
    assert.equal((await fetch(url, { method: 'PUT', body: '{}', signal: t.signal })).status, 415)
    assert.deepEqual(await (await fetch(url, { signal: t.signal })).json(), original)
    await stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
