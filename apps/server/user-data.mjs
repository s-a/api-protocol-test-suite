import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { dataDirectory } from './data-directory.mjs'
import { assertNoInterruptedMigration, readEncryptedData, useEncryptedStorage, writeEncryptedData } from './encrypted-storage.mjs'
import { atomicWrite } from './storage-crypto.mjs'

const pendingWrites = new Map()

export function accountDirectoryName(username, id) {
  return `${username}--${id}`
}

export function userDirectory(accountId) {
  return join(userDataRoot(), accountId)
}

export function userDataRoot() {
  return resolve(process.env.USER_DATA_DIR || join(dataDirectory(), 'users'))
}

export async function readJsonFile(file, initial) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return structuredClone(initial)
  }
}

export async function readUserData(accountId, name, initial) {
  const directory = userDirectory(accountId)
  await assertNoInterruptedMigration(directory)
  if (await useEncryptedStorage(directory)) return readEncryptedData(userDataRoot(), directory, accountId, name, initial)
  const data = await readJsonFile(join(directory, name), initial)
  if (typeof data?.ciphertext === 'string' && typeof data?.tag === 'string') {
    return readEncryptedData(userDataRoot(), directory, accountId, name, initial)
  }
  return data
}

export function updateUserData(accountId, name, initial, update) {
  const file = join(userDirectory(accountId), name)
  const result = (pendingWrites.get(file) ?? Promise.resolve()).then(async () => {
    const next = update(await readUserData(accountId, name, initial))
    const directory = userDirectory(accountId)
    if (await useEncryptedStorage(directory)) await writeEncryptedData(userDataRoot(), directory, accountId, name, next)
    else await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
    return next
  })
  const pending = result.catch(() => {})
  pendingWrites.set(file, pending)
  void pending.then(() => {
    if (pendingWrites.get(file) === pending) pendingWrites.delete(file)
  })
  return result
}
