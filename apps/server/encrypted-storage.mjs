import { randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeKeyId, atomicWrite, keyDirectory, openData, readOptional, sealData, unwrapAccountKey, wrapAccountKey,
  workspaceEncryptionEnabled,
} from './storage-crypto.mjs'

export const dataKeyFile = 'data-key.json'
export const workspaceFile = 'workspace.enc.json'
export const accountFiles = ['profiles.json', 'jwt-keys.json', 'sharing.json']
export const encryptionRecoverySuffix = '.encryption-recovery'

export class StorageError extends Error {
  constructor(cause) {
    super('Account data could not be read or written.', { cause })
  }
}

export async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

export async function storedAccountKey(directory) {
  const contents = await readOptional(join(directory, dataKeyFile))
  return contents === undefined ? undefined : JSON.parse(contents)
}

export async function useEncryptedStorage(directory) {
  return workspaceEncryptionEnabled() || await exists(join(directory, dataKeyFile)) ||
    await exists(join(directory, workspaceFile)) || await exists(directory + encryptionRecoverySuffix)
}

export async function assertNoInterruptedMigration(directory) {
  if (await exists(directory + encryptionRecoverySuffix)) throw new Error('Finish the interrupted account migration.')
}

export async function accountDataKey(root, directory, account, create = false) {
  let envelope = await storedAccountKey(directory)
  if (envelope === undefined && !create) throw new Error('Missing account data key.')
  const keys = await keyDirectory(root)
  if (envelope !== undefined) return unwrapAccountKey(keys, account, envelope)
  for (const name of ['workspace', '.workspace-recovery', workspaceFile, ...accountFiles]) {
    if (await exists(join(directory, name))) {
      // Another writer may have installed the key and written its first file.
      envelope = await storedAccountKey(directory)
      if (envelope !== undefined) return unwrapAccountKey(keys, account, envelope)
      throw new Error('Existing account data requires storage migrate or its original account data key.')
    }
  }
  const id = await activeKeyId(keys)
  const key = randomBytes(32)
  envelope = await wrapAccountKey(keys, id, account, key)
  try {
    await atomicWrite(join(directory, dataKeyFile), JSON.stringify(envelope), true)
    return key
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return unwrapAccountKey(keys, account, await storedAccountKey(directory))
  }
}

export async function readEncryptedData(root, directory, account, name, initial) {
  try {
    const contents = await readOptional(join(directory, name))
    if (contents === undefined) return structuredClone(initial)
    const key = await accountDataKey(root, directory, account)
    return JSON.parse(openData(key, [account, name], JSON.parse(contents)).toString('utf8'))
  } catch (error) {
    throw new StorageError(error)
  }
}

export async function writeEncryptedData(root, directory, account, name, data) {
  try {
    const key = await accountDataKey(root, directory, account, true)
    const envelope = sealData(key, [account, name], Buffer.from(JSON.stringify(data)))
    await atomicWrite(join(directory, name), JSON.stringify(envelope))
  } catch (error) {
    throw new StorageError(error)
  }
}
