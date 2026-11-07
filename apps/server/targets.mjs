import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataDirectory } from './data-directory.mjs'
import { readJsonFile } from './user-data.mjs'

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const usage = 'Usage: server.mjs targets list | add <name> <origin> | update <name> <origin> | remove <name>'

function targetOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\@\s\p{Cc}]+\/?$/iu.test(value)) return null
  return URL.parse(value)?.origin ?? null
}

function targetsFile() {
  return process.env.TARGETS_FILE || join(dataDirectory(), 'targets.json')
}

async function readTargets(file) {
  const data = await readJsonFile(file, { version: 1, targets: [] })
  if (data?.version !== 1 || !Array.isArray(data.targets)) throw new Error('Invalid targets file.')
  const names = new Set()
  const origins = new Set()
  for (const target of data.targets) {
    const origin = targetOrigin(target?.origin)
    if (typeof target?.name !== 'string' || !namePattern.test(target.name) ||
        !origin || names.has(target.name) || origins.has(origin)) throw new Error('Invalid targets file.')
    names.add(target.name)
    origins.add(origin)
    target.origin = origin
  }
  return data.targets
}

export class TargetPolicyError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function checkTarget(url) {
  let targets
  try {
    targets = await readTargets(targetsFile())
  } catch {
    throw new TargetPolicyError(500, 'target_configuration_error', 'Could not read the target allowlist.')
  }
  if (!targets.some(target => target.origin === url.origin)) {
    throw new TargetPolicyError(403, 'target_not_allowed', 'This target is not enabled for requests.')
  }
}

async function updateTargets(file, update) {
  await mkdir(dirname(file), { recursive: true })
  const lockPath = `${file}.lock`
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`Targets file is locked: ${lockPath}`)
    throw error
  })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const targets = await readTargets(file)
    update(targets)
    await writeFile(temporary, JSON.stringify({ version: 1, targets }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
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

export async function runTargetsCommand(args) {
  const [command, name, value] = args
  const file = targetsFile()
  if (command === 'list' && args.length === 1) {
    for (const target of await readTargets(file)) {
      const url = new URL(target.origin)
      console.log(`${target.name}\t${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`)
    }
    return
  }
  const settingOrigin = command === 'add' || command === 'update'
  if ((!settingOrigin && command !== 'remove') || args.length !== (settingOrigin ? 3 : 2) || !namePattern.test(name)) {
    throw new Error(usage)
  }
  const origin = targetOrigin(value)
  if (settingOrigin && !origin) throw new Error('Enter an HTTP or HTTPS origin with a hostname or IP address and optional port.')

  await updateTargets(file, targets => {
    const index = targets.findIndex(target => target.name === name)
    if (settingOrigin && targets.some(target => target.name !== name && target.origin === origin)) {
      throw new Error('Target origin already exists.')
    }
    if (command === 'add') {
      if (index !== -1) throw new Error('Target name already exists.')
      targets.push({ name, origin })
    } else {
      if (index === -1) throw new Error('Target does not exist.')
      if (command === 'update') targets[index] = { name, origin }
      else targets.splice(index, 1)
    }
  })
}
