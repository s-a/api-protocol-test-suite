import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { accountId, hashPassword, readAccounts, updateAccounts, verifyPassword } from './accounts.mjs'
import { accountDirectoryName } from './user-data.mjs'
import { entrypoint, login, password, startServer, username } from './test-support/server.mjs'

test('a newly added account can save its first encrypted workspace without a restart', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'api-storage-first-save-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const users = join(root, 'users')
  const keys = join(root, 'encryption-keys')
  const { address, accountsFile } = await startServer(t, {
    USER_DATA_DIR: relative(process.cwd(), users), ENCRYPTION_KEYS_DIR: relative(process.cwd(), keys),
  }, false)
  const account = await hashPassword(username, password)
  await updateAccounts(() => [account], accountsFile)
  const signedIn = await login(address)
  assert.equal(signedIn.status, 303)
  const headers = { Cookie: signedIn.headers.get('Set-Cookie').split(';')[0] }
  const url = address + '/api/workspace'
  const before = await fetch(url, { headers })
  assert.equal(before.status, 200)
  const directory = join(users, accountDirectoryName(username, accountId(account)))
  const file = join(directory, 'workspace.enc.json')
  await assert.rejects(readFile(file), { code: 'ENOENT' })

  const snapshot = {
    collections: [{ id: 'smoke', name: 'First collection', auth: { type: 'none' }, items: [] }],
    environments: [{ id: 'root-environment', name: 'Root Environment', variables: [] }],
    activeEnvironmentId: null,
    sections: [{ id: 'root', name: 'Root', collectionIds: ['smoke'], environmentId: 'root-environment' }],
  }
  const saved = await fetch(url, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), snapshot)
  assert.equal(typeof JSON.parse(await readFile(file, 'utf8')).ciphertext, 'string')
  assert.deepEqual(await (await fetch(url, { headers })).json(), snapshot)
})

test('default encryption, migration, sealed reset, rotation and restore', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'api-storage-encryption-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = {
    ACCOUNTS_FILE: join(root, 'accounts.json'),
    USER_DATA_DIR: join(root, 'users'),
    ACCOUNT_KEY_DIR: join(root, 'keys'),
    WORKSPACE_ENCRYPTION_ENABLED: undefined,
  }
  function cli(args, input, overrides = {}) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], {
      env: { ...process.env, ...env, ...overrides }, input, encoding: 'utf8',
    })
    assert.ifError(result.error)
    return result
  }
  function success(result) {
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const first = success(cli(['storage', 'generate-key']))
  const other = 'z-recipient'
  const oldAccounts = await Promise.all([hashPassword(username, password), hashPassword(other, password)])
  await updateAccounts(() => oldAccounts, env.ACCOUNTS_FILE)
  const [ownerDirectory, recipientDirectory] = oldAccounts.map(account =>
    join(env.USER_DATA_DIR, accountDirectoryName(account.username, accountId(account))))
  const section = join(ownerDirectory, 'workspace', 'section-root')
  await mkdir(section, { recursive: true })
  await writeFile(join(ownerDirectory, 'workspace', 'workspace-index.json'), JSON.stringify({
    sectionDirectories: ['section-root'], collectionOrder: [], environmentOrder: ['shared-env'],
    activeEnvironmentId: 'shared-env', explicitSections: true,
  }))
  const sharedEnvironment = { id: 'shared-env', name: 'Shared settings', variables: [] }
  await writeFile(join(section, 'section.json'), JSON.stringify({ id: 'root', name: 'Root', collectionFiles: [] }))
  await writeFile(join(section, 'environment.json'), JSON.stringify(sharedEnvironment))
  await writeFile(join(ownerDirectory, 'sharing.json'), JSON.stringify({ sectionIds: ['root'], version: 'original' }))
  const secret = 'test secret for migrated JWT'
  const keyEntry = { origin: 'https://example.test', algorithm: 'HS256', key: secret }
  await writeFile(join(ownerDirectory, 'jwt-keys.json'), JSON.stringify({ demo: keyEntry }))

  const orphan = join(env.USER_DATA_DIR, 'removed--' + 'a'.repeat(32))
  const recovery = orphan + '.encryption-recovery'
  await mkdir(recovery)
  await writeFile(join(recovery, 'profiles.json'), '{"revision":1,"connections":[]}')

  const old = await startServer(t, env)
  assert.equal((await old.request(old.address + '/api/workspace')).status, 200)
  const sharedSession = await login(old.address, { username: other, password })
  assert.equal(sharedSession.status, 303)
  const headers = { Cookie: sharedSession.headers.get('Set-Cookie').split(';')[0] }
  const sharedUrl = old.address + '/api/workspace/shared/' + username
  const preview = await fetch(sharedUrl, { headers })
  assert.equal(preview.status, 200)
  assert.deepEqual((await preview.json()).environments, [sharedEnvironment])
  const copy = await fetch(sharedUrl + '/copy', { method: 'POST', headers: { ...headers, 'If-Match': preview.headers.get('ETag') } })
  assert.equal(copy.status, 200)
  assert.ok((await copy.json()).environments.some(({ name }) => name === sharedEnvironment.name))
  assert.equal(JSON.parse(await readFile(join(orphan, 'data-key.json'), 'utf8')).keyId, first)
  await assert.rejects(readFile(join(recovery, 'profiles.json')), { code: 'ENOENT' })
  await old.stop()

  success(cli(['storage', 'migrate', username]))
  const file = join(ownerDirectory, 'jwt-keys.json')
  const before = await readFile(file, 'utf8')
  assert.equal(before.includes(secret), false)
  await assert.rejects(readFile(join(ownerDirectory, 'workspace', 'workspace-index.json')), { code: 'ENOENT' })
  const backup = join(root, 'backup')
  await cp(ownerDirectory, backup, { recursive: true })

  const second = success(cli(['storage', 'generate-key']))
  assert.notEqual(first, second)
  // A failed rotation leaves both keys readable and can be retried.
  const recipientKey = join(recipientDirectory, 'data-key.json')
  const originalRecipientKey = await readFile(recipientKey, 'utf8')
  await writeFile(recipientKey, '{}')
  assert.equal(cli(['storage', 'rotate', second]).status, 1)
  assert.equal((await readFile(join(env.ACCOUNT_KEY_DIR, 'active'), 'utf8')).trim(), first)
  assert.equal(JSON.parse(await readFile(join(ownerDirectory, 'data-key.json'), 'utf8')).keyId, second)
  await writeFile(recipientKey, originalRecipientKey)
  success(cli(['storage', 'rotate', second]))
  success(cli(['storage', 'rotate', second]))
  assert.equal(await readFile(file, 'utf8'), before)

  const next = '🔐'.repeat(480)
  const publicFile = join(env.ACCOUNT_KEY_DIR, second + '.public.pem')
  const sealed = success(cli(['accounts', 'seal-password', 'set-password', username, '--stdin'], next,
    { ACCOUNT_PUBLIC_KEY_FILE: publicFile }))
  assert.equal(cli(['accounts', 'set-password', other, '--sealed'], sealed).status, 1)
  assert.equal(cli(['accounts', 'add', username, '--sealed'], sealed).status, 1)
  success(cli(['accounts', 'set-password', username, '--sealed'], sealed))
  const [account] = await readAccounts(env.ACCOUNTS_FILE)
  assert.equal(accountId(account), accountId(oldAccounts[0]))
  assert.equal(await verifyPassword(account, next), true)
  assert.equal((await readFile(env.ACCOUNTS_FILE, 'utf8')).includes(next), false)
  const add = success(cli(['accounts', 'seal-password', 'add', 'new-user', '--stdin'], next,
    { ACCOUNT_PUBLIC_KEY_FILE: publicFile }))
  success(cli(['accounts', 'add', 'new-user', '--sealed'], add))
  assert.equal(await verifyPassword((await readAccounts(env.ACCOUNTS_FILE)).at(-1), next), true)

  // Restore a backup wrapped with the previous RSA key.
  await cp(backup, ownerDirectory, { recursive: true })
  const server = await startServer(t, env, false)
  const signedIn = await login(server.address, { username, password: next })
  assert.equal(signedIn.status, 303)
  const cookie = signedIn.headers.get('Set-Cookie').split(';')[0]
  const reveal = () => server.request(server.address + '/api/jwt-keys/reveal', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: 'demo' }),
  })
  assert.deepEqual(await (await reveal()).json(), keyEntry)
  assert.equal((await server.request(server.address + '/api/workspace', { headers: { Cookie: cookie } })).status, 200)
  await cp(backup, recipientDirectory, { recursive: true })
  const recipient = await login(server.address, { username: other, password })
  assert.equal(recipient.status, 303)
  assert.equal((await server.request(server.address + '/api/workspace', {
    headers: { Cookie: recipient.headers.get('Set-Cookie').split(';')[0] },
  })).status, 500)
  const tampered = JSON.parse(before)
  const tag = Buffer.from(tampered.tag, 'base64')
  tag[0] ^= 1
  tampered.tag = tag.toString('base64')
  await writeFile(file, JSON.stringify(tampered))
  assert.equal((await reveal()).status, 500)
  await rm(join(env.ACCOUNT_KEY_DIR, first + '.private.pem'))
  await writeFile(file, before)
  assert.equal((await reveal()).status, 500)
})

test('disabling encryption keeps plain storage usable and does not decrypt encrypted accounts', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'api-storage-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = {
    ACCOUNTS_FILE: join(root, 'accounts.json'), USER_DATA_DIR: join(root, 'users'), ACCOUNT_KEY_DIR: join(root, 'keys'),
    WORKSPACE_ENCRYPTION_ENABLED: 'false',
  }
  const snapshot = { collections: [], environments: [], activeEnvironmentId: null, sections: [] }
  function save(server) {
    return server.request(server.address + '/api/workspace', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
    })
  }
  const plain = await startServer(t, env)
  assert.deepEqual(await (await save(plain)).json(), snapshot)
  await plain.stop()
  const [account] = await readAccounts(env.ACCOUNTS_FILE)
  const directory = join(env.USER_DATA_DIR, accountDirectoryName(username, accountId(account)))
  assert.ok(await readFile(join(directory, 'workspace', 'workspace-index.json'), 'utf8'))
  await assert.rejects(readFile(join(env.ACCOUNT_KEY_DIR, 'active')), { code: 'ENOENT' })

  const secure = { ...env, WORKSPACE_ENCRYPTION_ENABLED: undefined }
  for (const args of [['generate-key'], ['migrate', username]]) {
    const result = spawnSync(process.execPath, [entrypoint, 'storage', ...args], {
      env: { ...process.env, ...secure }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  }
  const encrypted = await startServer(t, env)
  const file = join(directory, 'workspace.enc.json')
  const before = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(await (await save(encrypted)).json(), snapshot)
  const after = JSON.parse(await readFile(file, 'utf8'))
  assert.notEqual(before.nonce, after.nonce)
  await assert.rejects(readFile(join(directory, 'workspace', 'workspace-index.json')), { code: 'ENOENT' })
})
