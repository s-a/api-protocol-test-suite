import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile, userDataRoot, userDirectory } from './user-data.mjs'
import {
  assertNoInterruptedMigration, exists, readEncryptedData, useEncryptedStorage, workspaceFile, writeEncryptedData,
} from './encrypted-storage.mjs'

const manifestFile = 'workspace-index.json'
const pending = new Map()

function workspacePaths(accountId) {
  const directory = userDirectory(accountId)
  return {
    current: join(directory, 'workspace'),
    staging: join(directory, '.workspace-writing'),
    recovery: join(directory, '.workspace-recovery'),
  }
}

async function recoverWorkspace({ current, recovery }) {
  if (!(await exists(recovery))) return
  if (await exists(current)) {
    await rm(recovery, { recursive: true, force: true })
  } else {
    await rename(recovery, current)
  }
}

function storageName(name, prefix, used) {
  const slug = name.normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
  const base = slug ? `${prefix}-${slug}` : prefix
  let directory = base
  for (let suffix = 2; used.has(directory); suffix++) directory = `${base}-${suffix}`
  used.add(directory)
  return directory
}

function emptyRootEnvironment() {
  return { id: 'root-environment', name: 'Root Environment', variables: [] }
}

export function workspaceSections(workspace) {
  if (workspace.sections) return workspace.sections
  const active = workspace.environments.find(({ id }) => id === workspace.activeEnvironmentId)
  const rootEnvironment = active?.id ?? workspace.environments[0]?.id ?? emptyRootEnvironment().id
  return [
    { id: 'root', name: 'Root', collectionIds: workspace.collections.map(({ id }) => id), environmentId: rootEnvironment },
    ...workspace.environments.filter(({ id }) => id !== rootEnvironment).map(({ id, name }) => ({
      id: 'environment:' + id, name, collectionIds: [], environmentId: id,
    })),
  ]
}

export function sectionedWorkspace(workspace) {
  if (workspace.sections) return workspace
  return {
    ...workspace,
    environments: workspace.environments.length ? workspace.environments : [emptyRootEnvironment()],
    sections: workspaceSections(workspace),
  }
}

function serialize(accountId, action) {
  const result = (pending.get(accountId) ?? Promise.resolve()).then(action)
  const tail = result.catch(() => {})
  pending.set(accountId, tail)
  void tail.then(() => {
    if (pending.get(accountId) === tail) pending.delete(accountId)
  })
  return result
}

async function readSnapshot(directory, initial) {
  const manifest = await readJsonFile(join(directory, manifestFile))
  if (!manifest) return structuredClone(initial)
  const roots = []
  const collections = []
  const environments = []
  for (const name of manifest.sectionDirectories) {
    if (!/^section(?:-[a-z0-9-]+)?$/.test(name)) throw new Error('Invalid workspace section directory.')
    const section = join(directory, name)
    const [root, environment] = await Promise.all([
      readJsonFile(join(section, 'section.json')),
      readJsonFile(join(section, 'environment.json')),
    ])
    if (!root || !environment) throw new Error('Incomplete workspace section.')
    const entries = await Promise.all(root.collectionFiles.map(async file => {
      if (!/^collection(?:-[a-z0-9-]+)?\.json$/.test(file)) throw new Error('Invalid collection file name.')
      const collection = await readJsonFile(join(section, 'collections', file))
      if (!collection) throw new Error('Missing workspace collection.')
      return collection
    }))
    roots.push({
      id: root.id, name: root.name, collectionIds: entries.map(({ id }) => id),
      environmentId: environment.id,
    })
    collections.push(...entries)
    environments.push(environment)
  }
  const collectionsById = new Map(collections.map(entry => [entry.id, entry]))
  const environmentsById = new Map(environments.map(entry => [entry.id, entry]))
  return {
    collections: manifest.collectionOrder.map(id => collectionsById.get(id)),
    environments: manifest.environmentOrder.map(id => environmentsById.get(id)),
    activeEnvironmentId: manifest.activeEnvironmentId,
    ...(manifest.explicitSections && { sections: roots }),
  }
}

async function writeSnapshot(directory, workspace) {
  const { sections, environments: sectionEnvironments } = sectionedWorkspace(workspace)
  const collections = new Map(workspace.collections.map(entry => [entry.id, entry]))
  const environments = new Map(sectionEnvironments.map(entry => [entry.id, entry]))
  const sectionDirectories = new Set()
  for (const section of sections) {
    const target = join(directory, storageName(section.name, 'section', sectionDirectories))
    await mkdir(target, { mode: 0o700 })
    const { id, name, collectionIds, environmentId } = section
    const collectionDirectory = join(target, 'collections')
    await mkdir(collectionDirectory, { mode: 0o700 })
    const collectionNames = new Set()
    const collectionFiles = []
    for (const collectionId of collectionIds) {
      const collection = collections.get(collectionId)
      const file = storageName(collection.name, 'collection', collectionNames) + '.json'
      await writeFile(join(collectionDirectory, file), JSON.stringify(collection, null, 2) + '\n', { mode: 0o600 })
      collectionFiles.push(file)
    }
    await writeFile(join(target, 'section.json'), JSON.stringify({
      id, name, collectionFiles,
    }, null, 2) + '\n', { mode: 0o600 })
    await writeFile(join(target, 'environment.json'), JSON.stringify(
      environments.get(environmentId), null, 2,
    ) + '\n', { mode: 0o600 })
  }
  const manifest = {
    sectionDirectories: [...sectionDirectories],
    collectionOrder: workspace.collections.map(({ id }) => id),
    environmentOrder: workspace.environments.map(({ id }) => id),
    activeEnvironmentId: workspace.activeEnvironmentId,
    explicitSections: Boolean(workspace.sections),
  }
  await writeFile(join(directory, manifestFile), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
}

export async function readLegacyWorkspace(directory) {
  const current = join(directory, 'workspace')
  await recoverWorkspace({ current, recovery: join(directory, '.workspace-recovery') })
  if (!(await exists(current))) return
  const snapshot = await readSnapshot(current)
  if (!snapshot || snapshot.collections.includes(undefined) || snapshot.environments.includes(undefined)) {
    throw new Error('Missing or incomplete legacy workspace manifest.')
  }
  return snapshot
}

export async function writeMigratedWorkspace(directory, account, workspace) {
  const snapshot = sectionedWorkspace(workspace)
  const { collections, environments, activeEnvironmentId, sections } = snapshot
  if (await useEncryptedStorage(directory)) {
    await writeEncryptedData(userDataRoot(), directory, account, workspaceFile,
      { collections, environments, activeEnvironmentId, sections })
    return
  }
  const target = join(directory, 'workspace')
  await mkdir(target, { mode: 0o700 })
  await writeSnapshot(target, snapshot)
}

async function readEncryptedWorkspace(account, initial) {
  const paths = workspacePaths(account)
  const directory = userDirectory(account)
  await assertNoInterruptedMigration(directory)
  if (await exists(paths.current) || await exists(paths.recovery)) {
    throw new Error('Run storage migrate for this account before using encrypted workspace storage.')
  }
  return readEncryptedData(userDataRoot(), directory, account, workspaceFile, initial)
}

export function readWorkspaceData(accountId, initial) {
  return serialize(accountId, async () => {
    if (await useEncryptedStorage(userDirectory(accountId))) return readEncryptedWorkspace(accountId, initial)
    const paths = workspacePaths(accountId)
    await recoverWorkspace(paths)
    return readSnapshot(paths.current, initial)
  })
}

export function updateWorkspaceData(accountId, initial, update) {
  return serialize(accountId, async () => {
    const directory = userDirectory(accountId)
    if (await useEncryptedStorage(directory)) {
      const next = update(await readEncryptedWorkspace(accountId, initial))
      await writeEncryptedData(userDataRoot(), directory, accountId, workspaceFile, next)
      return next
    }
    const paths = workspacePaths(accountId)
    const { current, staging, recovery } = paths
    await recoverWorkspace(paths)
    const next = update(await readSnapshot(current, initial))
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      await writeSnapshot(staging, next)
      if (await exists(current)) await rename(current, recovery)
      try {
        await rename(staging, current)
      } catch (error) {
        await recoverWorkspace(paths)
        throw error
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(console.error)
    }
    await rm(recovery, { recursive: true, force: true }).catch(console.error)
    return next
  })
}
