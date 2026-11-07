import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { accountId, hashPassword, updateAccounts } from './accounts.mjs'
import { entrypoint, login, password, startServer, username } from './test-support/server.mjs'

test('the sign-in form is public and the workspace, assets and API require a session', { timeout: 15000 }, async t => {
  const { address, accountsFile } = await startServer(t, {}, false)
  const path = '/collections/~example/items/~request'
  const page = await fetch(address + path, { redirect: 'manual' })
  assert.equal(page.status, 303)
  const loginUrl = page.headers.get('Location')
  assert.equal(new URL(loginUrl, address).searchParams.get('next'), path)
  const form = await fetch(address + loginUrl)
  assert.equal(form.status, 200)
  const html = await form.text()
  assert.match(html, /type="password"/)
  assert.match(html, /rel="icon" type="image\/png" sizes="64x64" href="\/favicon\.png"/)
  for (const iconPath of ['/favicon.png', '/favicon.ico']) {
    const icon = await fetch(address + iconPath)
    assert.equal(icon.status, 200)
    assert.equal(icon.headers.get('Content-Type'), 'image/png')
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()), await readFile(new URL('./favicon.png', import.meta.url)))
  }
  assert.equal(form.headers.get('Cache-Control'), 'no-store')
  assert.equal((await fetch(address + '/assets/example.js', { redirect: 'manual' })).status, 303)
  for (const route of ['/api/health', '/api/workspace', '/api/profiles', '/api/jwt-keys', '/api/collections/example/export']) {
    assert.equal((await fetch(address + route)).status, 401)
  }
  assert.equal((await fetch(address + '/api/requests/send', { method: 'POST' })).status, 401)
  assert.equal((await login(address)).status, 401)

  const account = await hashPassword(username, password)
  await updateAccounts(() => [account], accountsFile)
  const stored = await readFile(accountsFile, 'utf8')
  assert.ok(!stored.includes(password))
  assert.equal((await login(address, { username, password: 'wrong' })).status, 401)
  assert.equal((await login(address, undefined, '/login', {
    headers: { Origin: 'https://unrelated.example' },
  })).status, 403)

  const accepted = await login(address, undefined, loginUrl)
  assert.equal(accepted.status, 303)
  assert.equal(accepted.headers.get('Location'), path)
  const session = accepted.headers.get('Set-Cookie')
  assert.match(session, /; HttpOnly; SameSite=Strict; Max-Age=28800/)
  const headers = { Cookie: session.split(';')[0] }
  assert.equal((await fetch(address + '/api/health', { headers })).status, 200)
  assert.equal((await fetch(address + '/api/workspace', { method: 'PUT', headers: {
    ...headers, Origin: 'https://unrelated.example',
  } })).status, 403)

  const external = await login(address, undefined, '/login?next=%2F%2Funrelated.example')
  assert.equal(external.headers.get('Location'), '/')
  const logout = await fetch(address + '/logout', { method: 'POST', headers, redirect: 'manual' })
  assert.equal(logout.status, 303)
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/)
  assert.equal((await fetch(address + '/api/health', { headers })).status, 401)
})

test('password changes and CLI removal invalidate active sessions without restarting', { timeout: 15000 }, async t => {
  const { address, accountsFile, request } = await startServer(t)
  const cli = (...args) => spawnSync(process.execPath, [entrypoint, 'accounts', ...args], {
    env: { ...process.env, ACCOUNTS_FILE: accountsFile }, encoding: 'utf8',
  })
  const listed = cli('list')
  assert.equal(listed.status, 0, listed.stderr)
  assert.equal(listed.stdout.trim(), username)
  const noTerminal = cli('set-password', username)
  assert.equal(noTerminal.status, 1)
  assert.match(noTerminal.stderr, /interactive terminal/)

  const nextPassword = 'changed integration test password'
  const workspace = { collections: [{ id: 'kept', name: 'Kept', auth: { type: 'none' }, items: [] }],
    environments: [], activeEnvironmentId: null }
  assert.equal((await request(address + '/api/workspace', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workspace),
  })).status, 200)
  const account = await hashPassword(username, nextPassword)
  await updateAccounts(([previous]) => [{ ...account, id: accountId(previous) }], accountsFile)
  assert.equal((await request(address + '/api/health')).status, 401)
  assert.equal((await login(address)).status, 401)
  const accepted = await login(address, { username, password: nextPassword })
  assert.equal(accepted.status, 303)
  const headers = { Cookie: accepted.headers.get('Set-Cookie').split(';')[0] }
  assert.deepEqual(await (await fetch(address + '/api/workspace', { headers })).json(), workspace)
  const removed = cli('remove', username)
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal((await fetch(address + '/api/health', { headers })).status, 401)
  assert.equal((await login(address, { username, password: nextPassword })).status, 401)
  assert.equal(cli('list').stdout, '')

  const recreated = await hashPassword(username, nextPassword)
  await updateAccounts(() => [recreated], accountsFile)
  const newSession = await login(address, { username, password: nextPassword })
  assert.equal(newSession.status, 303)
  const newHeaders = { Cookie: newSession.headers.get('Set-Cookie').split(';')[0] }
  const empty = { collections: [], environments: [], activeEnvironmentId: null }
  assert.deepEqual(await (await fetch(address + '/api/workspace', { headers: newHeaders })).json(), empty)

  await writeFile(accountsFile, '{')
  assert.equal((await login(address)).status, 503)
  assert.equal(cli('list').status, 1)
})
