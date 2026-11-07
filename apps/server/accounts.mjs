import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { dataDirectory } from './data-directory.mjs'

const derive = promisify(scrypt)
const hashOptions = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }
export const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
export const maxPasswordLength = 1024

export function accountsFile() {
  return process.env.ACCOUNTS_FILE || join(dataDirectory(), 'accounts.json')
}

export function accountId(account) {
  return account.id ?? account.salt
}

export async function readAccounts(file = accountsFile()) {
  let contents
  try {
    contents = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const data = JSON.parse(contents)
  const names = new Set()
  const ids = new Set()
  if (data?.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid accounts file.')
  for (const account of data.accounts) {
    if (typeof account?.username !== 'string' || !usernamePattern.test(account.username) ||
      typeof account.salt !== 'string' || !/^[0-9a-f]{32}$/.test(account.salt) ||
      typeof account.hash !== 'string' || !/^[0-9a-f]{64}$/.test(account.hash) ||
      (account.id !== undefined && (typeof account.id !== 'string' || !/^[0-9a-f]{32}$/.test(account.id))) ||
      names.has(account.username) || ids.has(accountId(account))) throw new Error('Invalid accounts file.')
    names.add(account.username)
    ids.add(accountId(account))
  }
  return data.accounts
}

export async function hashPassword(username, password) {
  if (password.length < 15 || password.length > maxPasswordLength) {
    throw new Error(`Password must contain between 15 and ${maxPasswordLength} characters.`)
  }
  const salt = randomBytes(16)
  const hash = await derive(password, salt, 32, hashOptions)
  return { username, salt: salt.toString('hex'), hash: hash.toString('hex') }
}

export async function verifyPassword(account, password) {
  const salt = account ? Buffer.from(account.salt, 'hex') : Buffer.alloc(16)
  const hash = await derive(password, salt, 32, hashOptions)
  return Boolean(account && timingSafeEqual(hash, Buffer.from(account.hash, 'hex')))
}

export async function updateAccounts(update, file = accountsFile()) {
  await mkdir(dirname(file), { recursive: true })
  const lockPath = `${file}.lock`
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`Accounts file is locked: ${lockPath}`)
    throw error
  })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const accounts = update(await readAccounts(file))
    await writeFile(temporary, JSON.stringify({ version: 1, accounts }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    try {
      await rm(temporary, { force: true })
    } finally {
      await lock.close()
      await rm(lockPath)
    }
  }
}
