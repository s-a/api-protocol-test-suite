import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { accountId, readAccounts, usernamePattern } from './accounts.mjs'
import {
  accountDataKey, accountFiles, dataKeyFile, encryptionRecoverySuffix, exists,
  readEncryptedData, storedAccountKey, workspaceFile, writeEncryptedData,
} from './encrypted-storage.mjs'
import {
  atomicWrite, generateStorageKey, keyDirectory, loadKey, unwrapAccountKey, wrapAccountKey,
} from './storage-crypto.mjs'
import { accountDirectoryName, readJsonFile, userDataRoot, userDirectory } from './user-data.mjs'
import { readLegacyWorkspace } from './workspace-storage.mjs'

const accountDirectoryPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}--[a-f0-9]{32}$/
const usage = 'Usage: server.mjs storage generate-key | migrate <username> | rotate <new-key-id>'

async function storageEntries(root) {
  return readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

export async function migratePlaintextStorage() {
  const root = userDataRoot()
  const accounts = new Set()
  for (const { name } of await storageEntries(root)) {
    const account = name.endsWith(encryptionRecoverySuffix) ? name.slice(0, -encryptionRecoverySuffix.length) : name
    if (accountDirectoryPattern.test(account)) accounts.add(account)
  }
  for (const account of accounts) {
    const directory = userDirectory(account)
    if (await exists(directory + encryptionRecoverySuffix) || !(await exists(join(directory, dataKeyFile)))) {
      try {
        await migrateAccount(root, account)
      } catch (error) {
        throw new Error('Could not migrate account storage for ' + account + ': ' + error.message, { cause: error })
      }
    }
  }
}

async function verifyAccount(root, directory, account) {
  await accountDataKey(root, directory, account)
  for (const name of [workspaceFile, ...accountFiles]) {
    await readEncryptedData(root, directory, account, name)
  }
}

async function migrateAccount(root, account) {
  const directory = userDirectory(account)
  const staging = directory + '.encryption-writing'
  const recovery = directory + encryptionRecoverySuffix
  if ((await exists(directory) && !(await lstat(directory)).isDirectory()) ||
      (await exists(recovery) && !(await lstat(recovery)).isDirectory())) {
    throw new Error('Invalid account data directory.')
  }
  if (await exists(recovery)) {
    if (await exists(directory)) {
      if (!(await storedAccountKey(directory))) throw new Error('Cannot verify the migrated account.')
      await verifyAccount(root, directory, account)
      await rm(recovery, { recursive: true })
    } else {
      await rename(recovery, directory)
    }
  }
  await rm(staging, { recursive: true, force: true })
  if (!(await exists(directory))) return

  const names = await readdir(directory)
  if (await storedAccountKey(directory)) {
    await verifyAccount(root, directory, account)
    return
  }
  for (const name of names) {
    if (![...accountFiles, 'workspace', '.workspace-writing', '.workspace-recovery'].includes(name) &&
        !/^(?:data-key|workspace\.enc|profiles|jwt-keys|sharing)\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) {
      throw new Error('Unexpected entry in account data directory: ' + name)
    }
  }
  const data = new Map([[workspaceFile, await readLegacyWorkspace(directory)]])
  for (const name of accountFiles) data.set(name, await readJsonFile(join(directory, name)))
  if ([...data.values()].every(value => value === undefined)) return

  await mkdir(staging, { mode: 0o700 })
  try {
    for (const [name, value] of data) {
      if (value === undefined) continue
      await writeEncryptedData(root, staging, account, name, value)
      const verified = await readEncryptedData(root, staging, account, name)
      if (!isDeepStrictEqual(verified, JSON.parse(JSON.stringify(value)))) {
        throw new Error('Encrypted account data failed verification.')
      }
    }
    await rename(directory, recovery)
    try {
      await rename(staging, directory)
    } catch (error) {
      await rename(recovery, directory)
      throw error
    }
    await rm(recovery, { recursive: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function rotate(root, keys, id) {
  await Promise.all([loadKey(keys, id, 'public'), loadKey(keys, id, 'private')])
  const entries = await storageEntries(root)
  if (entries.some(({ name }) => name.endsWith(encryptionRecoverySuffix))) {
    throw new Error('Finish the interrupted account migration before rotating keys.')
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !accountDirectoryPattern.test(entry.name)) continue
    const directory = join(root, entry.name)
    const envelope = await storedAccountKey(directory)
    if (envelope === undefined) continue
    const key = await unwrapAccountKey(keys, entry.name, envelope)
    if (envelope.keyId === id) continue
    const replacement = await wrapAccountKey(keys, id, entry.name, key)
    const verified = await unwrapAccountKey(keys, entry.name, replacement)
    if (!verified.equals(key)) throw new Error('Rewrapped AES key failed verification.')
    await atomicWrite(join(directory, dataKeyFile), JSON.stringify(replacement))
  }
  await atomicWrite(join(keys, 'active'), id + '\n')
}

export async function runStorageCommand(args) {
  const [command, target] = args
  const root = userDataRoot()
  if (command === 'generate-key' && args.length === 1) {
    console.log(await generateStorageKey(await keyDirectory(root)))
  } else if (command === 'migrate' && args.length === 2 && usernamePattern.test(target)) {
    const account = (await readAccounts()).find(entry => entry.username === target)
    if (!account) throw new Error('Account does not exist.')
    await migrateAccount(root, accountDirectoryName(target, accountId(account)))
    console.log('Account storage migrated: ' + target)
  } else if (command === 'rotate' && args.length === 2) {
    await rotate(root, await keyDirectory(root), target)
    console.log('Active RSA key: ' + target)
  } else {
    throw new Error(usage)
  }
}
