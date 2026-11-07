import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { accountId, hashPassword, updateAccounts } from './accounts.mjs'
import { accountDirectoryName } from './user-data.mjs'
import { entrypoint, login, password, startServer, username } from './test-support/server.mjs'

const sharingPath = '/api/workspace/sharing'
const workspacePath = '/api/workspace'
const profilePath = '/api/profiles'
const sharedPath = `/api/workspace/shared/${username}`
const initial = { collections: [], environments: [], activeEnvironmentId: null }
const collection = (id, name) => ({ id, name, auth: { type: 'none' }, items: [] })
const environment = (id, name) => ({ id, name, variables: [] })
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
const root = { id: 'root', name: 'Root' }
const sharing = (owners = []) => ({ sections: [root], sectionIds: [], owners })

test('sharing previews and copies only the selected sections with their environments', { timeout: 15000 }, async t => {
  const { address, request, accountsFile } = await startServer(t)
  const other = await hashPassword('Tester', password)
  await updateAccounts(accounts => [...accounts, other], accountsFile)
  const signedIn = await login(address, { username: other.username, password })
  assert.equal(signedIn.status, 303)
  const cookie = signedIn.headers.get('Set-Cookie').split(';')[0]
  const owner = (path, options) => request(address + path, { ...options, signal: t.signal })
  const recipient = (path, options) => fetch(address + path, {
    ...options, headers: { ...options?.headers, Cookie: cookie }, signal: t.signal,
  })
  const first = {
    ...initial, collections: [collection('common', 'Owner collection'), collection('private', 'Private collection')],
    environments: [environment('local', 'Owner environment'), environment('secret', 'Private environment')],
    activeEnvironmentId: 'secret',
    sections: [
      { ...root, collectionIds: ['common'], environmentId: 'local' },
      { id: 'private', name: 'Private', collectionIds: ['private'], environmentId: 'secret' },
    ],
  }
  const second = {
    ...initial, collections: [collection('common', 'Recipient collection')],
    environments: [environment('local', 'Recipient environment')], activeEnvironmentId: 'local',
  }
  const results = await Promise.all([owner(workspacePath, json('PUT', first)), recipient(workspacePath, json('PUT', second))])
  assert.deepEqual(results.map(response => response.status), [200, 200])
  assert.deepEqual(await (await owner(workspacePath)).json(), first)
  assert.deepEqual(await (await recipient(workspacePath)).json(), second)
  const duplicateAssignment = {
    ...first, sections: [first.sections[0], { ...first.sections[1], environmentId: 'local' }],
  }
  assert.equal((await owner(workspacePath, json('PUT', duplicateAssignment))).status, 400)
  assert.equal((await recipient(sharedPath)).status, 404)
  assert.deepEqual(await (await recipient(sharingPath)).json(), sharing())
  assert.equal((await owner('/api/jwt-keys', json('PUT', {
    reference: 'owner-only', key: 'private test key', algorithm: 'HS256', origin: 'https://example.test',
  }))).status, 200)
  assert.equal((await owner(profilePath, json('PUT', { revision: 0, connections: [] }))).status, 200)
  assert.deepEqual(await (await recipient(profilePath)).json(), { revision: 0, connections: [] })

  const share = sectionIds => owner(sharingPath, json('PUT', { sectionIds }))
  assert.equal((await share(['missing'])).status, 400)
  assert.equal((await share(['root'])).status, 200)
  assert.deepEqual(await (await recipient(sharingPath)).json(), sharing([username]))
  assert.equal((await fetch(address + sharedPath, { signal: t.signal })).status, 401)
  const preview = await recipient(sharedPath)
  assert.deepEqual(await preview.json(), {
    collections: first.collections.slice(0, 1), environments: first.environments.slice(0, 1),
    activeEnvironmentId: null, sections: first.sections.slice(0, 1),
  })
  assert.equal((await recipient(sharedPath, json('PUT', second))).status, 405)
  assert.equal((await recipient('/api/jwt-keys/reveal', json('POST', { reference: 'owner-only' }))).status, 404)

  const resource = 'Postman resource'
  const zip = zipSync({
    'Shared/.resources/definition.yaml': strToU8('$kind: collection\nname: Shared\nvariables:\n  - { key: mode, value: demo }\n'),
    'Shared/.resources/retained.txt': strToU8(resource),
  })
  const imported = await owner('/api/collections/import', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', 'Workspace-Section': 'root' }, body: zip,
  })
  assert.equal(imported.status, 201)
  const source = await imported.json()
  const original = source.collections[2]
  const copy = version => recipient(sharedPath + '/copy', { method: 'POST', headers: { 'If-Match': version } })
  assert.equal((await copy(preview.headers.get('ETag'))).status, 412)
  assert.equal((await recipient(`/api/collections/${original.id}/export`)).status, 404)

  const updatedRecipient = { ...second, collections: [...second.collections, collection(original.id, 'Keep local')] }
  assert.equal((await recipient(workspacePath, json('PUT', updatedRecipient))).status, 200)
  const beforeSelectionChange = (await recipient(sharedPath)).headers.get('ETag')
  assert.equal((await share(['root', 'private'])).status, 200)
  assert.equal((await copy(beforeSelectionChange)).status, 412)
  const full = await recipient(sharedPath)
  assert.deepEqual((await full.json()).sections, source.sections)
  assert.equal((await share(['root'])).status, 200)
  const version = (await recipient(sharedPath)).headers.get('ETag')
  assert.notEqual(version, beforeSelectionChange)
  const copied = await copy(version)
  assert.equal(copied.status, 200)
  const result = await copied.json()
  assert.deepEqual(result.collections.map(({ name }) => name), ['Recipient collection', 'Keep local', 'Owner collection', 'Shared'])
  assert.notEqual(result.collections[2].id, 'common')
  assert.notEqual(result.collections[3].id, original.id)
  assert.deepEqual(result.collections[3].exchange.variables, { mode: 'demo' })
  assert.deepEqual(result.environments.map(({ name }) => name), ['Recipient environment', 'Owner environment'])
  assert.notEqual(result.environments[1].id, 'local')
  assert.equal(result.activeEnvironmentId, 'local')
  assert.deepEqual(result.sections[1].collectionIds, result.collections.slice(2).map(({ id }) => id))
  assert.equal(result.sections[1].environmentId, result.environments[1].id)
  const exported = await recipient(`/api/collections/${result.collections[3].id}/export`)
  assert.equal(exported.status, 200)
  const files = unzipSync(new Uint8Array(await exported.arrayBuffer()))
  assert.equal(Buffer.from(files['Shared/.resources/retained.txt']).toString(), resource)

  assert.equal((await owner(sharingPath, { method: 'DELETE' })).status, 200)
  assert.equal((await recipient(sharedPath)).status, 404)
  assert.equal((await copy(version)).status, 404)
  assert.deepEqual((await (await recipient(sharingPath)).json()).owners, [])
  assert.deepEqual(await (await recipient(workspacePath)).json(), result)
  assert.deepEqual(await (await owner(workspacePath)).json(), source)
  const empty = { ...initial, sections: [] }
  assert.deepEqual(await (await owner(workspacePath, json('PUT', empty))).json(), empty)
  assert.deepEqual(await (await owner(workspacePath)).json(), empty)
})

test('migration copies legacy data to one account without overwriting its files or publishing it', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'api-workspace-migration-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const origin = 'https://example.test'
  const env = {
    WORKSPACE_ENCRYPTION_ENABLED: 'false',
    ACCOUNTS_FILE: join(directory, 'accounts.json'), USER_DATA_DIR: join(directory, 'users'),
    WORKSPACE_FILE: join(directory, 'workspace.json'), PROFILES_FILE: join(directory, 'profiles.json'),
    JWT_KEYS_FILE: join(directory, 'jwt-keys.json'),
    JWT_SIGNING_KEYS: JSON.stringify({ configured: { env: 'TEST_MIGRATION_KEY', origin, algorithm: 'HS256' } }),
    TEST_MIGRATION_KEY: 'configured test key',
  }
  const account = await hashPassword(username, password)
  const another = await hashPassword('another', password)
  await updateAccounts(() => [account, another], env.ACCOUNTS_FILE)
  const legacy = { ...initial, revision: 7, collections: [collection('legacy', 'Legacy collection')] }
  const original = JSON.stringify(legacy)
  const profiles = { revision: 3, connections: [] }
  const key = { origin, algorithm: 'HS256', key: 'stored test key' }
  await Promise.all([
    writeFile(env.WORKSPACE_FILE, original),
    writeFile(env.PROFILES_FILE, JSON.stringify(profiles)),
    writeFile(env.JWT_KEYS_FILE, JSON.stringify({ stored: key })),
  ])
  const migrate = target => spawnSync(process.execPath, [entrypoint, 'workspace', 'migrate', target], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  })
  assert.equal(migrate('missing').status, 1)
  const result = migrate(username)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(migrate(username).status, 1)
  assert.equal(await readFile(env.WORKSPACE_FILE, 'utf8'), original)

  const { address, request } = await startServer(t, env)
  const get = path => request(address + path, { signal: t.signal })
  const migrated = await (await get(workspacePath)).json()
  assert.deepEqual(migrated.collections, legacy.collections)
  assert.equal(Object.hasOwn(migrated, 'revision'), false)
  const [section] = migrated.sections
  const [rootEnvironment] = migrated.environments
  assert.deepEqual(section, { ...root, collectionIds: ['legacy'], environmentId: rootEnvironment.id })
  const target = join(env.USER_DATA_DIR, accountDirectoryName(username, accountId(account)))
  const manifest = JSON.parse(await readFile(join(target, 'workspace', 'workspace-index.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest, 'revision'), false)
  assert.deepEqual(manifest.sectionDirectories, ['section-root'])
  const sectionDirectory = join(target, 'workspace', 'section-root')
  assert.deepEqual(JSON.parse(await readFile(join(sectionDirectory, 'section.json'), 'utf8')), {
    ...root, collectionFiles: ['collection-legacy-collection.json'],
  })
  assert.deepEqual(JSON.parse(await readFile(join(sectionDirectory, 'collections', 'collection-legacy-collection.json'), 'utf8')),
    legacy.collections[0])
  assert.deepEqual(JSON.parse(await readFile(join(sectionDirectory, 'environment.json'), 'utf8')), rootEnvironment)
  assert.deepEqual(await (await get(profilePath)).json(), profiles)
  assert.deepEqual(await (await get(sharingPath)).json(), sharing())
  await writeFile(join(target, 'sharing.json'), JSON.stringify({ shared: true }))
  for (const [reference, expected] of [['stored', key], ['configured', { ...key, key: env.TEST_MIGRATION_KEY }]]) {
    const reveal = await request(address + '/api/jwt-keys/reveal', json('POST', { reference }))
    assert.deepEqual(await reveal.json(), expected)
  }

  const accepted = await login(address, { username: another.username, password })
  assert.equal(accepted.status, 303)
  const headers = { Cookie: accepted.headers.get('Set-Cookie').split(';')[0] }
  assert.equal((await fetch(address + sharedPath, { headers })).status, 404)
  assert.deepEqual(await (await fetch(address + workspacePath, { headers })).json(), initial)
  assert.equal((await fetch(address + '/api/jwt-keys/reveal', {
    ...json('POST', { reference: 'configured' }), headers: { ...headers, 'Content-Type': 'application/json' },
  })).status, 404)
})
