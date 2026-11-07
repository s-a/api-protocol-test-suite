import { createHash, randomUUID } from 'node:crypto'
import { accountId, readAccounts } from './accounts.mjs'
import { accountDirectoryName, readUserData, updateUserData } from './user-data.mjs'
import { copyWorkspace, publicWorkspace, readWorkspace, readWorkspaceJson, WorkspaceError } from './workspace.mjs'
import { sectionedWorkspace, workspaceSections } from './workspace-storage.mjs'

const sharingFile = 'sharing.json'
const privateWorkspace = { sectionIds: [] }

async function readSharing(id) {
  const settings = await readUserData(id, sharingFile, privateWorkspace)
  return Array.isArray(settings.sectionIds) ? settings : privateWorkspace
}

async function publishedWorkspace(id) {
  const settings = await readSharing(id)
  if (!settings.sectionIds.length) return null
  const workspace = sectionedWorkspace(await readWorkspace(id))
  if ((await readSharing(id)).version !== settings.version) return null
  const selected = new Set(settings.sectionIds)
  const sections = workspace.sections.filter(({ id }) => selected.has(id))
  if (!sections.length) return null
  const collectionIds = new Set(sections.flatMap(section => section.collectionIds))
  const environmentIds = new Set(sections.map(section => section.environmentId))
  return {
    version: settings.version,
    workspace: {
      collections: workspace.collections.filter(({ id }) => collectionIds.has(id)),
      environments: workspace.environments.filter(({ id }) => environmentIds.has(id)),
      activeEnvironmentId: environmentIds.has(workspace.activeEnvironmentId) ? workspace.activeEnvironmentId : null,
      sections,
    },
  }
}

export async function handleWorkspaceSharing(request, response, send, path, account) {
  const listing = path === '/api/workspace/sharing'
  const source = /^\/api\/workspace\/shared\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})(\/copy)?$/.exec(path)
  if (!listing && !source) return false
  const dataKey = accountDirectoryName(account.username, account.id)

  response.setHeader('Cache-Control', 'no-store')
  const json = (status, data) => send(request, response, status, 'application/json; charset=utf-8', JSON.stringify(data))
  const methods = listing ? ['GET', 'PUT', 'DELETE'] : source[2] ? ['POST'] : ['GET']
  if (!methods.includes(request.method)) {
    response.setHeader('Allow', methods.join(', '))
    json(405, { error: 'Method not allowed.' })
    return true
  }

  try {
    if (listing && request.method !== 'GET') {
      const sectionIds = request.method === 'PUT' ? (await readWorkspaceJson(request, 64 * 1024))?.sectionIds : []
      const sections = workspaceSections(await readWorkspace(dataKey))
      const available = new Set(sections.map(({ id }) => id))
      if (!Array.isArray(sectionIds) || new Set(sectionIds).size !== sectionIds.length ||
          sectionIds.some(id => !available.has(id))) {
        throw new WorkspaceError(400, 'Select valid saved workspace sections.')
      }
      await updateUserData(dataKey, sharingFile, privateWorkspace, () => ({ sectionIds, version: randomUUID() }))
      json(200, { sectionIds })
    } else {
      const others = (await readAccounts()).filter(other => accountId(other) !== account.id)
      if (listing) {
        const [own, workspace, ...published] = await Promise.all([
          readSharing(dataKey), readWorkspace(dataKey),
          ...others.map(async other => (await publishedWorkspace(accountDirectoryName(other.username, accountId(other))))
            ? other.username : null),
        ])
        const sections = workspaceSections(workspace).map(({ id, name }) => ({ id, name }))
        const selected = new Set(own.sectionIds)
        json(200, { sections, sectionIds: sections.map(({ id }) => id).filter(id => selected.has(id)),
          owners: published.filter(Boolean).sort() })
      } else {
        const owner = others.find(other => other.username === source[1])
        const published = owner && await publishedWorkspace(accountDirectoryName(owner.username, accountId(owner)))
        if (!published) {
          json(404, { error: 'Shared workspace not found.' })
        } else {
          const { workspace } = published
          const version = createHash('sha256').update(
            JSON.stringify([accountId(owner), published.version, workspace]),
          ).digest('hex')
          const etag = `"${version}"`
          if (request.method === 'GET') {
            response.setHeader('ETag', etag)
            json(200, publicWorkspace(workspace))
          } else if (request.headers['if-match'] !== etag) {
            json(412, { error: 'The shared workspace has changed. Open it again before copying.' })
          } else {
            json(200, publicWorkspace(await copyWorkspace(dataKey, workspace)))
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceError) {
      json(error.status, { error: error.message })
    } else {
      console.error(error)
      json(500, { error: 'Could not process the shared workspace.' })
    }
  }
  return true
}
