import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { hashPassword, readAccounts, updateAccounts } from '../accounts.mjs'
import { generateStorageKey, readOptional } from '../storage-crypto.mjs'

export const entrypoint = fileURLToPath(new URL('../server.mjs', import.meta.url))
export const username = 'tester'
export const password = 'local integration test password'

export function login(address, credentials = { username, password }, path = '/login', options = {}) {
  return fetch(address + path, {
    method: 'POST', body: new URLSearchParams(credentials), redirect: 'manual', ...options,
  })
}

export async function startServer(t, env = {}, authenticate = true, nodeArgs = []) {
  const directory = await mkdtemp(join(tmpdir(), 'api-server-test-'))
  const accountsFile = env.ACCOUNTS_FILE ?? join(directory, 'accounts.json')
  const targetsFile = join(directory, 'targets.json')
  const keys = env.ENCRYPTION_KEYS_DIR ?? env.ACCOUNT_KEY_DIR ??
    join(env.USER_DATA_DIR ? dirname(env.USER_DATA_DIR) : directory, 'keys')
  let stop = async () => {}
  t.after(async () => {
    await stop()
    await rm(directory, { recursive: true, force: true })
  })

  if (authenticate && !(await readAccounts(accountsFile)).some(account => account.username === username)) {
    const account = await hashPassword(username, password)
    await updateAccounts(accounts => [...accounts, account], accountsFile)
  }
  if ((env.WORKSPACE_ENCRYPTION_ENABLED !== 'false' || env.TOTP_ENABLED === 'true') &&
      !await readOptional(join(keys, 'active'))) {
    await generateStorageKey(keys)
  }
  const server = spawn(process.execPath, [...nodeArgs, entrypoint], {
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', HTTPS_ENABLED: undefined, TLS_CERT_FILE: '', TLS_KEY_FILE: '',
      WORKSPACE_ENCRYPTION_ENABLED: undefined, TOTP_ENABLED: undefined, ...env, ACCOUNTS_FILE: accountsFile, ENCRYPTION_KEYS_DIR: keys,
      TARGETS_FILE: targetsFile,
      USER_DATA_DIR: env.USER_DATA_DIR ?? join(directory, 'users'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  server.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
  const exited = once(server, 'exit')
  stop = async () => {
    server.kill()
    await exited
  }

  const output = createInterface({ input: server.stdout })
  const { value: startupLine } = await output[Symbol.asyncIterator]().next()
  const boundAddress = startupLine?.match(/https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):\d+$/)?.[0]
  assert.ok(boundAddress, 'Expected the server to report its listen address. ' + errors)
  const address = boundAddress.replace('://0.0.0.0:', '://127.0.0.1:')
  let outputText = startupLine + '\n'
  output.on('line', line => { outputText += line + '\n' })
  let cookie
  if (authenticate) {
    const response = await login(address)
    assert.equal(response.status, 303)
    cookie = response.headers.get('Set-Cookie').split(';')[0]
  }
  function request(url, options) {
    const headers = new Headers(options?.headers)
    if (cookie) headers.set('Cookie', cookie)
    return fetch(url, { ...options, headers })
  }
  function targets(...args) {
    return promisify(execFile)(process.execPath, [entrypoint, 'targets', ...args], {
      env: { ...process.env, TARGETS_FILE: targetsFile },
    })
  }
  return { address, boundAddress, stop, request, accountsFile, targetsFile, targets, serverOutput: () => outputText + errors }
}
