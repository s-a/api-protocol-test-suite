import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isBodyFormat } from './body-format.ts'
import { jwtSettings } from './jwt-settings.ts'
import { readPostmanCollectionVariables } from './postman.mjs'
import { readWorkspaceData, sectionedWorkspace, updateWorkspaceData } from './workspace-storage.mjs'

const maxUpdateSize = 16 * 1024 * 1024
const maxFolderDepth = 100
const initialWorkspace = {
  collections: [],
  environments: [],
  activeEnvironmentId: null,
}

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function invalid(message) {
  throw new WorkspaceError(400, message)
}

export function readWorkspace(accountId) {
  return readWorkspaceData(accountId, initialWorkspace)
}

export function publicWorkspace(workspace) {
  return {
    ...workspace,
    collections: workspace.collections.map(({ exchange, ...collection }) => {
      if (!exchange) return collection
      const variables = readPostmanCollectionVariables({ id: collection.id, exchange })
      return { ...collection, exchange: { warnings: exchange.warnings, ...(variables && { variables }) } }
    }),
  }
}

function string(value, label) {
  if (typeof value !== 'string') invalid(`${label} must be a string.`)
  return value
}

function nonempty(value, label) {
  if (!string(value, label).trim()) invalid(`${label} must not be empty.`)
  return value
}

function entries(value, label, parse, ids = new Set()) {
  if (!Array.isArray(value)) invalid(`${label} must be a list.`)
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`Invalid entry in ${label}.`)
    const id = nonempty(entry.id, 'ID')
    if (ids.has(id)) invalid(`Duplicate ID in ${label}.`)
    ids.add(id)
    return { id, ...parse(entry) }
  })
}

function readRows(value, label) {
  return entries(value, label, (row) => {
    if (typeof row.enabled !== 'boolean') invalid(`Each row in ${label} must have an enabled state.`)
    return { key: string(row.key, 'Key'), value: string(row.value, 'Value'), enabled: row.enabled }
  })
}

function readAuth(auth) {
  switch (auth?.type) {
    case 'none':
    case 'inherit':
      return { type: auth.type }
    case 'basic':
      return {
        type: auth.type,
        username: string(auth.username, 'Username'),
        password: string(auth.password, 'Password'),
      }
    case 'bearer':
      return { type: auth.type, token: string(auth.token, 'Token') }
    case 'jwt': {
      const settings = jwtSettings(auth)
      if (!settings) invalid('Invalid JWT Bearer settings.')
      return settings
    }
    default:
      invalid('Invalid authentication type.')
  }
}

function readItems(value, ids, depth) {
  if (depth > maxFolderDepth) invalid('Too many nested folders.')
  return entries(value, 'collection items', (entry) => {
    const item = { name: nonempty(entry.name, 'Item name'), auth: readAuth(entry.auth), type: entry.type, ...readScript(entry) }
    if (entry.type === 'folder') return { ...item, items: readItems(entry.items, ids, depth + 1) }
    if (entry.type !== 'request') invalid('Invalid collection item type.')
    const method = string(entry.method, 'HTTP method')
    if (entry.bodyFormat !== undefined && (entry.body === undefined || !isBodyFormat(entry.bodyFormat))) {
      invalid('Invalid request body format.')
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) invalid('Invalid HTTP method.')
    return {
      ...item,
      method,
      url: string(entry.url, 'URL'),
      headers: readRows(entry.headers, 'request headers'),
      ...(entry.body === undefined ? {} : { body: string(entry.body, 'Request body') }),
      ...(entry.bodyFormat === undefined ? {} : { bodyFormat: entry.bodyFormat }),
    }
  }, ids)
}

function readCollection(entry) {
  return {
    name: nonempty(entry.name, 'Collection name'),
    auth: readAuth(entry.auth),
    ...readScript(entry),
    items: readItems(entry.items, new Set([entry.id]), 0),
  }
}

function readScript(entry) {
  const scripts = {}
  for (const field of ['preRequest', 'postResponse']) {
    if (entry[field] === undefined) continue
    const code = string(entry[field], 'Script')
    if (code.length > 65536) invalid('Script is too long.')
    scripts[field] = code
  }
  return scripts
}

function readEnvironment(entry) {
  return {
    name: nonempty(entry.name, 'Environment name'),
    variables: readRows(entry.variables, 'environment variables'),
  }
}

function readSections(value, collections, environments) {
  const remainingCollections = new Set(collections.map(({ id }) => id))
  const remainingEnvironments = new Set(environments.map(({ id }) => id))
  const sections = entries(value, 'workspace sections', entry => {
    const name = nonempty(entry.name, 'Section name')
    const { collectionIds, environmentId } = entry
    if (!Array.isArray(collectionIds) || collectionIds.some(id => !remainingCollections.delete(id))) {
      invalid('Each collection must belong to exactly one section.')
    }
    if (!remainingEnvironments.delete(environmentId)) {
      invalid('Each section must have its own environment.')
    }
    return { name, collectionIds, environmentId }
  })
  if (remainingCollections.size || remainingEnvironments.size) {
    invalid('Every collection and environment must belong to a section.')
  }
  return sections
}

export async function readWorkspaceJson(request, limit = maxUpdateSize) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new WorkspaceError(415, 'The request must contain JSON.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      request.resume()
      throw new WorkspaceError(413, 'The workspace update is too large.')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    invalid('Invalid JSON.')
  }
}

async function readUpdate(request) {
  const data = await readWorkspaceJson(request)
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Invalid workspace.')
  const collections = entries(data.collections, 'collections', readCollection)
  const environments = entries(data.environments, 'environments', readEnvironment)
  const { activeEnvironmentId } = data
  if (activeEnvironmentId !== null && !environments.some(({ id }) => id === activeEnvironmentId)) {
    invalid('The active environment does not exist.')
  }
  const sections = data.sections === undefined ? undefined : readSections(data.sections, collections, environments)
  return { collections, environments, activeEnvironmentId, ...(sections && { sections }) }
}

function updateWorkspace(accountId, update) {
  return updateWorkspaceData(accountId, initialWorkspace, current => {
    if (current.sections && !update.sections) invalid('Workspace sections are required.')
    const exchangeByCollection = new Map(current.collections.map(({ id, exchange }) => [id, exchange]))
    const collections = update.collections.map((collection) => {
      const exchange = exchangeByCollection.get(collection.id)
      return exchange ? { ...collection, exchange } : collection
    })
    return { ...update, collections }
  })
}

export function appendImportedCollection(accountId, collection, sectionId) {
  return updateWorkspaceData(accountId, initialWorkspace, current => {
    const [entry] = entries([collection], 'collections', readCollection)
    if (current.collections.some(({ id }) => id === entry.id)) {
      throw new WorkspaceError(409, 'This collection ID already exists in the workspace.')
    }
    const collections = [...current.collections, { ...entry, exchange: collection.exchange }]
    const { sections, environments } = sectionedWorkspace(current)
    const section = sectionId === undefined ? sections[0] : sections.find(({ id }) => id === sectionId)
    if (!section && (sectionId !== undefined || !collection.environment)) {
      throw new WorkspaceError(404, 'Workspace section not found.')
    }
    if (collection.environment) {
      const [environment] = entries([collection.environment], 'environments', readEnvironment)
      const settings = ({ name, variables }) => ({
        name,
        variables: variables.map(({ key, value, enabled }) => ({ key, value, enabled })),
      })
      const importedSettings = settings(environment)
      const matches = candidate => {
        const saved = environments.find(({ id }) => id === candidate?.environmentId)
        return saved && isDeepStrictEqual(settings(saved), importedSettings)
      }
      const destination = matches(section) ? section : sections.find(matches)
      if (destination) {
        return { ...current, collections, environments, sections: sections.map(candidate => candidate === destination
          ? { ...candidate, collectionIds: [...candidate.collectionIds, entry.id] } : candidate) }
      }
      const empty = !current.sections && !current.collections.length && !current.environments.length
      const added = { id: empty ? 'root' : randomUUID(), name: environment.name, environmentId: environment.id, collectionIds: [entry.id] }
      return {
        ...current, collections,
        sections: empty ? [added] : [...sections, added],
        environments: empty ? [environment] : [...environments, environment],
      }
    }
    const updatedSections = sections.map(candidate => ({
      ...candidate,
      collectionIds: candidate === section ? [...candidate.collectionIds, entry.id] : candidate.collectionIds,
    }))
    return {
      ...current,
      collections,
      environments: sectionId === undefined ? current.environments : environments,
      ...((current.sections || sectionId !== undefined) && { sections: updatedSections }),
    }
  })
}

export function copyWorkspace(accountId, source) {
  return updateWorkspaceData(accountId, initialWorkspace, current => {
    const target = sectionedWorkspace(current)
    const collectionIds = new Set(current.collections.map(({ id }) => id))
    const collections = source.collections.map(collection => {
      if (!collectionIds.has(collection.id)) return collection
      const id = randomUUID()
      if (!collection.exchange?.nodePaths) return { ...collection, id }
      const { [collection.id]: rootPath, ...nodePaths } = collection.exchange.nodePaths
      if (rootPath !== undefined) nodePaths[id] = rootPath
      return { ...collection, id, exchange: { ...collection.exchange, nodePaths } }
    })
    const environmentIds = new Set(target.environments.map(({ id }) => id))
    const environments = source.environments.map(environment =>
      environmentIds.has(environment.id) ? { ...environment, id: randomUUID() } : environment)
    const activeIndex = source.environments.findIndex(({ id }) => id === source.activeEnvironmentId)
    const collectionMap = new Map(source.collections.map(({ id }, index) => [id, collections[index].id]))
    const environmentMap = new Map(source.environments.map(({ id }, index) => [id, environments[index].id]))
    const sections = [
      ...target.sections,
      ...source.sections.map(section => ({
        ...section, id: randomUUID(), collectionIds: section.collectionIds.map(id => collectionMap.get(id)),
        environmentId: environmentMap.get(section.environmentId),
      })),
    ]
    const activeEnvironmentId = current.activeEnvironmentId ?? environments[activeIndex]?.id ?? null
    return {
      collections: [...current.collections, ...collections],
      environments: [...target.environments, ...environments],
      activeEnvironmentId,
      sections,
    }
  })
}

export async function handleWorkspace(request, response, send, accountId) {
  const json = (status, data) => {
    response.setHeader('Cache-Control', 'no-store')
    send(request, response, status, 'application/json; charset=utf-8', JSON.stringify(data))
  }
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      json(200, publicWorkspace(await readWorkspace(accountId)))
    } else if (request.method === 'PUT') {
      const update = await readUpdate(request)
      json(200, publicWorkspace(await updateWorkspace(accountId, update)))
    } else {
      response.setHeader('Allow', 'GET, HEAD, PUT')
      json(405, { error: 'Method not allowed.' })
    }
  } catch (error) {
    if (error instanceof WorkspaceError) {
      json(error.status, { error: error.message })
    } else {
      console.error(error)
      json(500, { error: 'Unable to process the workspace data.' })
    }
  }
}
