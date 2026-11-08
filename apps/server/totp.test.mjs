import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import jsQR from 'jsqr'
import pngjs from 'pngjs'
import { hashPassword, readAccounts, updateAccounts } from './accounts.mjs'
import { sealPassword } from './storage-crypto.mjs'
import { entrypoint, password, startServer, username } from './test-support/server.mjs'
import { matchingTotpStep } from './totp.mjs'

const stepTime = 30_000
const clock = 1_800_000_000_000
const credentials = { username, password }
const other = { username: 'another', password: 'another integration password' }
const totpPath = '/login/totp'

async function fixture(t, accounts = [credentials]) {
  const directory = await mkdtemp(join(tmpdir(), 'api-totp-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = {
    ACCOUNTS_FILE: join(directory, 'accounts.json'), ENCRYPTION_KEYS_DIR: join(directory, 'keys'),
    USER_DATA_DIR: join(directory, 'users'), WORKSPACE_ENCRYPTION_ENABLED: 'false',
  }
  const records = await Promise.all(accounts.map(account => hashPassword(account.username, account.password)))
  await updateAccounts(() => records, env.ACCOUNTS_FILE)
  function start({ enabled = true, step = 0, ...settings } = {}) {
    const preload = `import { Socket } from 'node:net';
      Socket.prototype.connect = () => { throw new Error('Outbound network unavailable'); };
      Date.now = () => ${clock + step * stepTime}`
    return startServer(t, { ...env, TOTP_ENABLED: String(enabled), ...settings }, false,
      ['--import', 'data:text/javascript,' + encodeURIComponent(preload)])
  }
  function cli(args, options = {}) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], {
      encoding: 'utf8', ...options, env: { ...process.env, ...env, TOTP_ENABLED: 'false' },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  return { directory, start, cli, env }
}

async function tlsFetch(url, { headers, method, body, ca }) {
  const request = httpsRequest(url, { headers: Object.fromEntries(headers), method, ca })
  request.end(body?.toString())
  const [response] = await once(request, 'response')
  const result = []
  for await (const chunk of response) result.push(chunk)
  const fields = new Headers()
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    fields.append(response.rawHeaders[index], response.rawHeaders[index + 1])
  }
  return new Response(Buffer.concat(result), { status: response.statusCode, headers: fields })
}

function client(address, ca) {
  function send(path, { cookie, form } = {}) {
    const headers = new Headers()
    if (cookie) headers.set('Cookie', cookie)
    const options = { headers, redirect: 'manual' }
    if (form) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded')
      options.method = 'POST'
      options.body = new URLSearchParams(form)
    }
    return ca ? tlsFetch(address + path, { ...options, ca }) : fetch(address + path, options)
  }
  async function begin(form = credentials, next = '/') {
    const response = await send('/login?' + new URLSearchParams({ next }), { form })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), totpPath)
    const header = response.headers.getSetCookie().find(value => value.startsWith('api_test_suite_totp='))
    assert.match(header, /; HttpOnly; SameSite=Strict; Max-Age=300/)
    assert.equal(header.endsWith('; Secure'), Boolean(ca))
    assert.ok(response.headers.getSetCookie().some(value => /^api_test_suite_session=;.*Max-Age=0/.test(value)))
    return header.split(';')[0]
  }
  return { send, begin, verify: (cookie, code) => send(totpPath, { cookie, form: { code } }) }
}

function decodeSetup(html) {
  const payload = html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)"/)?.[1]
  assert.ok(payload, 'Expected an embedded setup PNG')
  const png = pngjs.PNG.sync.read(Buffer.from(payload, 'base64'))
  const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
  assert.ok(qr, 'Expected a scannable setup QR code')
  const uri = new URL(qr.data)
  assert.equal(uri.protocol, 'otpauth:')
  assert.equal(uri.hostname, 'totp')
  assert.equal(uri.searchParams.get('issuer'), 'API Protocol Test Suite')
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1')
  assert.equal(uri.searchParams.get('digits'), '6')
  assert.equal(uri.searchParams.get('period'), '30')
  const base32 = uri.searchParams.get('secret')
  assert.ok(/^[A-Z2-7]{32}$/.test(base32), 'Expected a 160-bit setup secret')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = Array.from(base32, character => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('')
  return { secret: Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2))), base32, payload }
}

function code(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(clock / stepTime + step))
  const digest = createHmac('sha1', secret).update(counter).digest()
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

function session(response) {
  assert.equal(response.status, 303)
  const header = response.headers.getSetCookie().find(value => /^api_test_suite_session=[a-f0-9]{64};/.test(value))
  assert.ok(header, 'Expected a fully authenticated session')
  return header.split(';')[0]
}

test('TOTP matches the RFC test vector, tolerates one step and rejects older and repeated steps', () => {
  const secret = Buffer.from('12345678901234567890')
  assert.equal(matchingTotpStep(secret, '287082', -1, 59_000), 1)
  assert.equal(matchingTotpStep(secret, '287082', -1, 29_000), 1)
  assert.equal(matchingTotpStep(secret, '287082', -1, 89_000), 1)
  assert.equal(matchingTotpStep(secret, '287082', -1, 90_000), undefined)
  assert.equal(matchingTotpStep(secret, '287082', 1, 59_000), undefined)
  assert.equal(matchingTotpStep(secret, '287082', 2, 59_000), undefined)
  assert.equal(matchingTotpStep(secret, '287082\n', -1, 59_000), undefined)
})

for (const transport of ['HTTP', 'HTTPS']) {
  test(`offline enrollment and later sign-in gate both the workspace and API over ${transport}`, { timeout: 30000 }, async t => {
    const { directory, start, cli, env } = await fixture(t)
    const settings = { HOST: '0.0.0.0', HTTPS_ENABLED: 'false' }
    let ca
    if (transport === 'HTTPS') {
      const tls = join(directory, 'tls')
      cli(['generate-tls-certificate', '--out-dir', tls])
      Object.assign(settings, { HOST: '127.0.0.1', HTTPS_ENABLED: 'true',
        TLS_CERT_FILE: join(tls, 'cert.pem'), TLS_KEY_FILE: join(tls, 'key.pem') })
      ca = await readFile(settings.TLS_CERT_FILE)
    }
    const server = await start(settings)
    assert.match(server.boundAddress, ca ? /^https:\/\/127\.0\.0\.1:/ : /^http:\/\/0\.0\.0\.0:/)
    const { send, begin, verify } = client(server.address, ca)
    const passwordPage = await send('/login')
    assert.equal(passwordPage.headers.get('Cache-Control'), 'no-store')
    const destination = '/collections/~example/items/~request'
    const first = await begin(credentials, destination)
    async function assertGated(cookie) {
      const workspace = await send(destination, { cookie })
      assert.equal(workspace.status, 303)
      assert.match(workspace.headers.get('Location'), /^\/login\?/)
      assert.equal((await send('/api/health', { cookie })).status, 401)
    }
    await assertGated(first)
    const setup = await send(totpPath, { cookie: first })
    assert.equal(setup.headers.get('Cache-Control'), 'no-store')
    assert.match(setup.headers.get('Content-Security-Policy'), /img-src data:/)
    const { secret, base32, payload } = decodeSetup(await setup.text())
    assert.equal((await readAccounts(env.ACCOUNTS_FILE))[0].totp, undefined)
    const initialCode = code(secret, -1)
    const accepted = await verify(first, initialCode)
    assert.equal(accepted.headers.get('Location'), destination)
    const authenticated = session(accepted)
    assert.equal(accepted.headers.getSetCookie()[0].endsWith('; Secure'), Boolean(ca))
    assert.equal((await send('/api/health', { cookie: authenticated })).status, 200)
    assert.equal((await send(totpPath, { cookie: first })).status, 303)
    const stored = await readFile(env.ACCOUNTS_FILE, 'utf8')
    assert.ok(!stored.includes(base32) && !stored.includes(secret.toString('hex')))

    const second = await begin()
    await assertGated(second)
    const prompt = await send(totpPath, { cookie: second })
    const html = await prompt.text()
    assert.match(html, /name="code"/)
    assert.doesNotMatch(html, /data:image\/|name="password"/)
    assert.equal((await verify(second, initialCode)).status, 401)
    const laterCode = code(secret, 0)
    const later = await verify(second, laterCode)
    assert.equal(later.headers.get('Location'), '/')
    assert.equal((await send('/api/health', { cookie: session(later) })).status, 200)
    await server.stop()
    for (const value of [password, base32, payload, initialCode, laterCode, first, authenticated]) {
      assert.ok(!server.serverOutput().includes(value), 'Server output must omit sign-in data')
    }
  })
}

test('parallel enrollment, replay checks and failed-attempt limits use account-wide state', { timeout: 30000 }, async t => {
  const { start, env } = await fixture(t)
  const server = await start()
  const { send, begin, verify } = client(server.address)
  const first = await begin()
  const second = await begin()
  const setup = await Promise.all([first, second].map(async cookie =>
    decodeSetup(await (await send(totpPath, { cookie })).text()).secret))
  const enrollments = await Promise.all([first, second].map((cookie, index) => verify(cookie, code(setup[index], -1))))
  const winner = enrollments.findIndex(response => response.headers.get('Location') === '/')
  assert.notEqual(winner, -1)
  assert.match(enrollments[1 - winner].headers.get('Location'), /^\/login\?/)
  const secret = setup[winner]
  const a = await begin()
  const b = await begin()
  const valid = code(secret, 0)
  const replays = await Promise.all([verify(a, valid), verify(b, valid)])
  assert.deepEqual(replays.map(response => response.status).sort(), [303, 401])

  const attempts = [await begin(), await begin(), await begin()]
  const bad = await Promise.all(Array.from({ length: 5 }, (_, index) => verify(attempts[index % 3], 'bad')))
  assert.deepEqual(bad.map(response => response.status).sort(), [401, 401, 401, 401, 429])
  const blocked = await verify(await begin(), code(secret, 1))
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('Retry-After'), '300')
  assert.equal((await readAccounts(env.ACCOUNTS_FILE))[0].totp.lastStep, clock / stepTime)
})

test('factors survive restarts, password change, toggling and resuming rotation before activation', { timeout: 45000 }, async t => {
  const { start, env, cli } = await fixture(t)
  const revision = '1'.repeat(32)
  await updateAccounts(accounts => {
    accounts[0].sessionRevision = revision
    return accounts
  }, env.ACCOUNTS_FILE)
  const plain = await start({ enabled: false })
  const passwordSession = session(await client(plain.address).send('/login', { form: credentials }))
  await plain.stop()
  const enabled = await start()
  const firstClient = client(enabled.address)
  assert.equal((await firstClient.send('/api/health', { cookie: passwordSession })).status, 401)
  const first = await firstClient.begin()
  const { secret } = decodeSetup(await (await firstClient.send(totpPath, { cookie: first })).text())
  const used = code(secret, 1)
  session(await firstClient.verify(first, used))
  await enabled.stop()

  const original = (await readAccounts(env.ACCOUNTS_FILE))[0]
  const activeFile = join(env.ENCRYPTION_KEYS_DIR, 'active')
  const oldActive = await readFile(activeFile, 'utf8')
  const keyFile = join(env.ENCRYPTION_KEYS_DIR, oldActive.trim() + '.public.pem')
  const updated = { username, password: 'replacement integration test password' }
  const sealed = await sealPassword(keyFile, 'set-password', username, updated.password)
  cli(['accounts', 'set-password', username, '--sealed'], { input: JSON.stringify(sealed) })
  const changed = (await readAccounts(env.ACCOUNTS_FILE))[0]
  assert.deepEqual(changed.totp, original.totp)
  assert.equal(changed.sessionRevision, revision)

  const disabled = await start({ enabled: false })
  const disabledClient = client(disabled.address)
  session(await disabledClient.send('/login', { form: updated }))
  await disabled.stop()
  const newId = cli(['storage', 'generate-key'])
  cli(['storage', 'rotate', newId])
  const rotated = (await readAccounts(env.ACCOUNTS_FILE))[0].totp
  assert.equal(rotated.keyId, newId)
  await writeFile(activeFile, oldActive)
  cli(['storage', 'rotate', newId])
  assert.equal((await readFile(activeFile, 'utf8')).trim(), newId)
  assert.deepEqual((await readAccounts(env.ACCOUNTS_FILE))[0].totp, rotated)
  await rm(join(env.ENCRYPTION_KEYS_DIR, oldActive.trim() + '.private.pem'))

  const resumed = await start({ step: 1 })
  const resumedClient = client(resumed.address)
  const pending = await resumedClient.begin(updated)
  assert.doesNotMatch(await (await resumedClient.send(totpPath, { cookie: pending })).text(), /data:image\//)
  assert.equal((await resumedClient.verify(pending, used)).status, 401)
  assert.equal((await resumedClient.verify(pending, code(secret, 0))).status, 401)
  session(await resumedClient.verify(pending, code(secret, 2)))
})

for (const enabled of [true, false]) {
  test(`administrator reset revokes only the affected account with 2FA ${enabled ? 'on' : 'off'}`, { timeout: 30000 }, async t => {
    const { start, env, cli } = await fixture(t, [credentials, other])
    const enrolled = await start()
    let browser = client(enrolled.address)
    async function enroll(form) {
      const pending = await browser.begin(form)
      const { secret } = decodeSetup(await (await browser.send(totpPath, { cookie: pending })).text())
      return { cookie: session(await browser.verify(pending, code(secret, 0))), secret }
    }
    const first = await enroll(credentials)
    const unaffected = await enroll(other)
    let cookie = first.cookie
    let otherCookie = unaffected.cookie
    const pending = enabled ? await browser.begin() : undefined
    if (!enabled) {
      await enrolled.stop()
      browser = client((await start({ enabled })).address)
      cookie = session(await browser.send('/login', { form: credentials }))
      otherCookie = session(await browser.send('/login', { form: other }))
    }
    cli(['accounts', 'reset-2fa', username])
    assert.equal((await browser.send('/api/health', { cookie })).status, 401)
    assert.equal((await browser.send('/api/health', { cookie: otherCookie })).status, 200)
    assert.equal((await readAccounts(env.ACCOUNTS_FILE))[0].totp, undefined)
    if (enabled) {
      const stale = await browser.verify(pending, code(first.secret, 1))
      assert.match(stale.headers.get('Location'), /^\/login\?/)
      const fresh = await enroll(credentials)
      assert.ok(!fresh.secret.equals(first.secret))
    }
  })
}
