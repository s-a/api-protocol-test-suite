import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { accountId, readAccounts, usernamePattern } from './accounts.mjs'
import { dataDirectory } from './data-directory.mjs'
import { accountDirectoryName, readJsonFile, userDataRoot, userDirectory } from './user-data.mjs'
import { writeMigratedWorkspace } from './workspace-storage.mjs'
import { useEncryptedStorage, writeEncryptedData } from './encrypted-storage.mjs'

function readLegacyFile(setting, name) {
  return readJsonFile(process.env[setting] || join(dataDirectory(), name))
}

function legacyJwtKeys(stored = {}) {
  const bindings = JSON.parse(process.env.JWT_SIGNING_KEYS || '{}')
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) ||
      !stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Invalid legacy JWT signing configuration.')
  }
  const keys = { ...stored }
  for (const [reference, binding] of Object.entries(bindings)) {
    if (Object.hasOwn(keys, reference)) continue
    if (typeof binding?.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.env) ||
        typeof binding.origin !== 'string' || typeof binding.algorithm !== 'string' || !process.env[binding.env]) {
      throw new Error(`Incomplete legacy JWT signing key: ${reference}`)
    }
    Object.defineProperty(keys, reference, {
      value: { origin: binding.origin, algorithm: binding.algorithm, key: process.env[binding.env] },
      enumerable: true,
    })
  }
  return keys
}

export async function migrateWorkspace(args) {
  const [command, username] = args
  if (command !== 'migrate' || args.length !== 2 || !usernamePattern.test(username)) {
    throw new Error('Usage: server.mjs workspace migrate <username>')
  }
  const account = (await readAccounts()).find(account => account.username === username)
  if (!account) throw new Error('Account does not exist.')
  const dataKey = accountDirectoryName(username, accountId(account))
  const target = userDirectory(dataKey)
  const existing = await lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing) throw new Error('The target account already has stored data.')

  const [workspace, profiles, storedKeys] = await Promise.all([
    readLegacyFile('WORKSPACE_FILE', 'workspace.json'),
    readLegacyFile('PROFILES_FILE', 'profiles.json'),
    readLegacyFile('JWT_KEYS_FILE', 'jwt-keys.json'),
  ])
  if (!Array.isArray(workspace?.collections) || !Array.isArray(workspace.environments)) {
    throw new Error('The legacy workspace is missing or invalid.')
  }
  if (profiles !== undefined && (!Number.isSafeInteger(profiles?.revision) || !Array.isArray(profiles.connections))) {
    throw new Error('The legacy profiles file is invalid.')
  }
  const files = { 'profiles.json': profiles, 'jwt-keys.json': legacyJwtKeys(storedKeys) }
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(directory, '.migration-'))
  try {
    await writeMigratedWorkspace(staging, dataKey, workspace)
    for (const [name, data] of Object.entries(files)) {
      if (data !== undefined) {
        if (await useEncryptedStorage(staging)) await writeEncryptedData(userDataRoot(), staging, dataKey, name, data)
        else await writeFile(join(staging, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      }
    }
    await rename(staging, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  console.log(`Legacy workspace copied to account: ${username}`)
}
