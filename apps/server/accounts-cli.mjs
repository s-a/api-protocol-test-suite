import { emitKeypressEvents } from 'node:readline'
import { stdin, stderr } from 'node:process'
import { accountId, hashPassword, maxPasswordLength, readAccounts, updateAccounts, usernamePattern } from './accounts.mjs'
import { keyDirectory, openPassword, sealPassword } from './storage-crypto.mjs'
import { userDataRoot } from './user-data.mjs'

const usage = 'Usage: server.mjs accounts list | add <username> [--sealed] | set-password <username> [--sealed] | remove <username> | seal-password <add|set-password> <username> [--stdin]'

async function readInput(limit) {
  const chunks = []
  let length = 0
  for await (const chunk of stdin) {
    length += chunk.length
    if (length > limit) throw new Error('Account input is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function promptPassword(label) {
  if (!stdin.isTTY) throw new Error('Password entry requires an interactive terminal.')
  return new Promise((resolve, reject) => {
    let password = ''
    const wasRaw = stdin.isRaw
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stderr.write(label)
    stdin.on('keypress', onKey)
    stdin.resume()

    function finish() {
      stdin.off('keypress', onKey)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stderr.write('\n')
    }

    function onKey(value, key) {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish()
        reject(new Error('Password entry cancelled.'))
      } else if (key.name === 'return' || key.name === 'enter') {
        finish()
        resolve(password)
      } else if (key.name === 'backspace') {
        password = Array.from(password).slice(0, -1).join('')
      } else if (value && Array.from(value).every(character => character >= ' ' && character !== '\x7f')) {
        password += value
        if (password.length > maxPasswordLength) {
          finish()
          reject(new Error(`Password exceeds ${maxPasswordLength} characters.`))
        }
      }
    }
  })
}

async function confirmedPassword() {
  const password = await promptPassword('Password: ')
  if (password !== await promptPassword('Confirm password: ')) throw new Error('Passwords do not match.')
  return password
}

export async function runAccountsCommand(args) {
  const [command, username, option] = args
  if (command === 'seal-password') {
    const [, action, target, input] = args
    if (!['add', 'set-password'].includes(action) || !target || !usernamePattern.test(target) ||
      (args.length !== 3 && (args.length !== 4 || input !== '--stdin'))) throw new Error(usage)
    const file = process.env.ACCOUNT_PUBLIC_KEY_FILE
    if (!file) throw new Error('Set ACCOUNT_PUBLIC_KEY_FILE to the server public key file.')
    const password = input ? await readInput(4 * maxPasswordLength) : await confirmedPassword()
    if (password.length < 15 || password.length > maxPasswordLength) throw new Error('Invalid password length.')
    console.log(JSON.stringify(await sealPassword(file, action, target, password)))
    return
  }
  if (command === 'list' && args.length === 1) {
    for (const account of await readAccounts()) console.log(account.username)
    return
  }
  const sealed = args.length === 3 && option === '--sealed' && command !== 'remove'
  if (!['add', 'set-password', 'remove'].includes(command) || !username ||
    (args.length !== 2 && !sealed) || !usernamePattern.test(username)) {
    throw new Error(usage)
  }

  function findAccount(accounts) {
    const index = accounts.findIndex(account => account.username === username)
    if (command === 'add' && index !== -1) throw new Error('Account already exists.')
    if (command !== 'add' && index === -1) throw new Error('Account does not exist.')
    return index
  }

  findAccount(await readAccounts())
  let replacement
  if (command !== 'remove') {
    let password
    if (sealed) {
      try {
        password = await openPassword(await keyDirectory(userDataRoot()), command, username, JSON.parse(await readInput(16384)))
      } catch {
        throw new Error('Could not open the sealed password package for this account command.')
      }
    } else {
      password = await confirmedPassword()
    }
    replacement = await hashPassword(username, password)
  }
  await updateAccounts(accounts => {
    const index = findAccount(accounts)
    if (command === 'add') accounts.push(replacement)
    else if (replacement) accounts[index] = { ...replacement, id: accountId(accounts[index]) }
    else accounts.splice(index, 1)
    return accounts
  })
  console.log(`Account ${{ add: 'added', 'set-password': 'updated', remove: 'removed' }[command]}: ${username}`)
}
