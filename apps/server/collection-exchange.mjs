import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { importPostmanCollection, importPostmanZip, exportPostmanZip, PostmanExchangeError } from './postman.mjs'
import { appendImportedCollection, publicWorkspace, readWorkspace, WorkspaceError } from './workspace.mjs'
import { workspaceSections } from './workspace-storage.mjs'
import { checkTarget, TargetPolicyError } from './targets.mjs'

const importLimit = 24 * 1024 * 1024
const wsdlLimit = 2 * 1024 * 1024
const wsdlTimeout = 15000
const wsdlTypes = new Set(['application/wsdl+xml', 'application/xml', 'text/xml'])
const redirectStatuses = new Set([301, 302, 303, 307, 308])

class ImportRequestError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function readImport(stream, limit = importLimit, message = 'The collection upload exceeds 24 MiB.') {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) throw new ImportRequestError(message, 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function readWsdl(stream) {
  return readImport(stream, wsdlLimit, 'The WSDL exceeds 2 MiB.')
}

async function downloadWsdl(value) {
  let url = typeof value === 'string' && value.length <= 8192 ? URL.parse(value) : null
  const signal = AbortSignal.timeout(wsdlTimeout)
  try {
    for (let redirects = 0; ; redirects++) {
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        if (redirects) throw new ImportRequestError('The WSDL URL redirected to an invalid URL.', 502)
        throw new ImportRequestError('Enter an HTTP or HTTPS WSDL URL without embedded credentials.', 400)
      }
      await checkTarget(url)
      const response = await fetch(url, { redirect: 'manual', signal })
      const location = response.headers.get('location')
      if (redirectStatuses.has(response.status) && location !== null) {
        await response.body?.cancel()
        if (redirects === 20) throw new ImportRequestError('The WSDL URL redirected too many times.', 502)
        url = URL.parse(location, url)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new ImportRequestError(`The WSDL URL returned HTTP ${response.status}.`, 502)
      }
      if (!response.body) throw new ImportRequestError('The WSDL URL returned an empty response.', 400)
      return await readWsdl(response.body)
    }
  } catch (error) {
    if (error instanceof ImportRequestError || error instanceof TargetPolicyError) throw error
    if (signal.aborted) throw new ImportRequestError('The WSDL download timed out.', 504)
    throw new ImportRequestError('Could not download the WSDL.', 502)
  }
}

async function importWsdl(bytes) {
  const signal = AbortSignal.timeout(wsdlTimeout)
  const worker = new Worker(new URL('./wsdl-import-worker.mjs', import.meta.url), {
    workerData: bytes, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 },
  })
  try {
    const [{ collection, error }] = await once(worker, 'message', { signal })
    if (error) throw new PostmanExchangeError(error)
    return collection
  } catch (error) {
    if (signal.aborted) throw new ImportRequestError('WSDL conversion timed out.', 504)
    if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') throw new ImportRequestError('The WSDL is too complex to convert.', 413)
    throw error
  } finally {
    await worker.terminate()
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(data))
}

async function importCollection(request) {
  const mediaType = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
  const body = request.iterator({ destroyOnReturn: false })
  if (wsdlTypes.has(mediaType)) return importWsdl(await readWsdl(body))
  if (mediaType === 'application/json') {
    const bytes = await readImport(body)
    let input
    try {
      input = JSON.parse(bytes)
    } catch {
      throw new ImportRequestError('Invalid collection directory upload.', 400)
    }
    if (!Array.isArray(input?.files) || typeof input.rootName !== 'string') {
      if (input && Object.hasOwn(input, 'url')) return importWsdl(await downloadWsdl(input.url))
      throw new ImportRequestError('A collection directory needs a root name and files.', 400)
    }
    return importPostmanCollection(input.files, input.rootName)
  }
  if (mediaType === 'application/zip' || mediaType === 'application/octet-stream') {
    return importPostmanZip(await readImport(body))
  }
  throw new ImportRequestError('Select a WSDL file, a WSDL URL, or a Postman Collection v3 directory or ZIP file.', 415)
}

export async function handleCollectionExchange(request, response, path, accountId) {
  const importing = path === '/api/collections/import'
  const exportRoute = /^\/api\/collections\/([^/]+)\/export$/.exec(path)
  if (!importing && !exportRoute) return false

  const method = importing ? 'POST' : 'GET'
  if (request.method !== method) {
    response.setHeader('Allow', method)
    sendJson(response, 405, { error: 'Method not allowed.' })
    return true
  }

  try {
    if (importing) {
      const collection = await importCollection(request)
      const section = request.headers['workspace-section']
      const workspace = await appendImportedCollection(accountId, collection, section && decodeURIComponent(section))
      sendJson(response, 201, publicWorkspace(workspace))
    } else {
      const id = decodeURIComponent(exportRoute[1])
      const workspace = await readWorkspace(accountId)
      const collection = workspace.collections.find((entry) => entry.id === id)
      if (!collection) {
        sendJson(response, 404, { error: 'Collection not found.' })
        return true
      }
      const section = workspaceSections(workspace).find(({ collectionIds }) => collectionIds.includes(id))
      const environment = workspace.environments.find(({ id }) => id === section?.environmentId)
      const zip = await exportPostmanZip(collection, environment)
      const filename = collection.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'collection'
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${filename}.zip"`,
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(zip)
    }
  } catch (error) {
    if (importing) request.resume()
    if (error instanceof TargetPolicyError) {
      sendJson(response, error.status, { error: error.message, code: error.code })
    } else if (error instanceof ImportRequestError || error instanceof WorkspaceError) {
      sendJson(response, error.status, { error: error.message })
    } else if (error instanceof PostmanExchangeError || error instanceof URIError) {
      sendJson(response, 400, { error: error.message })
    } else {
      console.error(error)
      sendJson(response, 500, { error: 'Collection exchange failed.' })
    }
  }
  return true
}
