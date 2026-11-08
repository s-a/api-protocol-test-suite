import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { unzipSync, zipSync } from 'fflate'
import { isMap, parseDocument, stringify } from 'yaml'
import { inferBodyFormat, isBodyFormat } from './body-format.ts'
import { defaultJwt, jwtSettings } from './jwt-settings.ts'

const definitionName = '.resources/definition.yaml'
const environmentSuffix = '.postman_environment.json'
const requestSuffix = /\.request\.ya?ml$/i
const definitionSuffix = /(?:^|\/)\.resources\/definition\.ya?ml$/i
const maxFiles = 2000
const maxBytes = 10 * 1024 * 1024
const invalidSegment = /[<>:"|?*\\]/u
const reservedSegment = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const methodToken = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export class PostmanExchangeError extends Error {}

function reject(message) {
  throw new PostmanExchangeError(message)
}

function validateSegment(segment) {
  if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || invalidSegment.test(segment) ||
      reservedSegment.test(segment) || Array.from(segment).some(character => character < ' ')) {
    reject('The collection contains an unsafe file or directory name.')
  }
}

function pathValidator() {
  const paths = new Map()
  const entries = new Set()
  const yamlEntries = new Set()
  return path => {
    if (typeof path !== 'string' || path.length > 4096 || path === '__proto__') {
      reject('The collection contains an unsafe file path.')
    }
    const directory = path.endsWith('/')
    const segments = (directory ? path.slice(0, -1) : path).split('/')
    if (segments.length > 48) reject('The collection directory is nested too deeply.')
    if (entries.has(path)) reject('The collection contains a duplicate archive entry.')
    entries.add(path)
    if (requestSuffix.test(path) || definitionSuffix.test(path)) {
      const key = yamlPath(path).normalize('NFC').toLowerCase()
      if (yamlEntries.has(key)) reject('The collection contains multiple YAML files for one Postman entry.')
      yamlEntries.add(key)
    }
    let prefix = ''
    for (const [index, segment] of segments.entries()) {
      validateSegment(segment)
      prefix = prefix ? `${prefix}/${segment}` : segment
      const key = prefix.normalize('NFC').toLowerCase()
      const kind = directory || index < segments.length - 1 ? 'directory' : 'file'
      const previous = paths.get(key)
      if (previous && (previous.path !== prefix || previous.kind !== kind)) {
        reject(`Conflicting collection paths: ${previous.path} and ${prefix}.`)
      }
      paths.set(key, { path: prefix, kind })
    }
  }
}

function parseYaml(bytes, path) {
  try {
    const document = parseDocument(textDecoder.decode(bytes), { stringKeys: true })
    if (document.errors.length || !isMap(document.contents)) throw new Error('Expected a YAML mapping.')
    return { document, data: document.toJS({ maxAliasCount: 25 }) }
  } catch {
    reject(`Invalid Postman YAML in ${path}.`)
  }
}

export function readPostmanCollectionVariables({ id, exchange }) {
  const path = exchange?.nodePaths[id]
  const file = exchange?.files.find(file => file.path === path)
  if (!file) return
  const { data } = parseYaml(Buffer.from(file.content, 'base64'), path)
  if (!Array.isArray(data.variables)) return
  const entries = data.variables.flatMap(variable => {
    if (typeof variable?.key !== 'string' || variable.disabled === true || variable.secret === true ||
        (variable.value !== undefined && typeof variable.value !== 'string')) return []
    return [[variable.key, variable.value ?? '']]
  })
  if (entries.length) return Object.fromEntries(entries)
}

function readJwt(credentials) {
  if (!Array.isArray(credentials) || !credentials.every(entry => entry && typeof entry.key === 'string' &&
      Object.keys(entry).every(key => key === 'key' || key === 'value'))) return
  const values = Object.fromEntries(credentials.map(({ key, value }) => [key, value]))
  const fields = ['algorithm', 'secret', 'privateKey', 'isSecretBase64Encoded', 'payload', 'header', 'addTokenTo', 'headerPrefix', 'queryParamKey']
  if (Object.keys(values).length !== credentials.length || Object.keys(values).some(key => !fields.includes(key))) return
  if (values.isSecretBase64Encoded !== undefined && ![true, false, 'true', 'false'].includes(values.isSecretBase64Encoded)) return
  const hmac = typeof values.algorithm === 'string' && values.algorithm.startsWith('HS')
  if (values[hmac ? 'privateKey' : 'secret']) return
  const secretRef = values[hmac ? 'secret' : 'privateKey'] ?? ''
  if (secretRef !== '' && (typeof secretRef !== 'string' || !secretRef.startsWith('{{'))) return
  const jsonText = (value, fallback) => value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value ?? fallback
  return jwtSettings({
    ...defaultJwt, algorithm: values.algorithm, secretRef,
    base64: values.isSecretBase64Encoded === true || values.isSecretBase64Encoded === 'true',
    payload: jsonText(values.payload, '{}'), header: jsonText(values.header, ''),
    addTokenTo: values.addTokenTo ?? 'header', headerPrefix: values.headerPrefix ?? 'Bearer', queryParamKey: values.queryParamKey ?? 'token',
  })
}

function writeJwt(auth) {
  const reference = auth.secretRef && !auth.secretRef.startsWith('{{') ? `{{${auth.secretRef}}}` : auth.secretRef
  const values = {
    algorithm: auth.algorithm, payload: auth.payload, header: auth.header,
    addTokenTo: auth.addTokenTo, headerPrefix: auth.headerPrefix, queryParamKey: auth.queryParamKey,
    ...(auth.algorithm.startsWith('HS') ? { secret: reference, isSecretBase64Encoded: auth.base64 } : { privateKey: reference }),
  }
  return Object.entries(values).map(([key, value]) => ({ key, value }))
}

function readAuth(auth, defaultType, warn) {
  if (auth === undefined) return { type: defaultType }
  if (auth && typeof auth === 'object' && !Array.isArray(auth) &&
      Object.keys(auth).some(key => !['type', 'credentials'].includes(key))) warn?.('authorization metadata')
  if (auth?.type === 'noauth') return { type: 'none' }
  if (auth?.type === 'inherit') return { type: 'inherit' }
  if (auth?.type === 'jwt') {
    const jwt = readJwt(auth.credentials)
    if (jwt) return jwt
  }
  if (auth?.type === 'basic' || auth?.type === 'bearer') {
    const keys = auth.type === 'basic' ? ['username', 'password'] : ['token']
    const entries = Array.isArray(auth.credentials) ? auth.credentials : Object.entries(auth.credentials ?? {})
      .map(([key, value]) => ({ key, value }))
    if (entries.every(entry => keys.includes(entry?.key) && typeof entry.value === 'string')) {
      const values = Object.fromEntries(entries.map(({ key, value }) => [key, value]))
      if (entries.length === Object.keys(values).length) {
        return { type: auth.type, ...Object.fromEntries(keys.map(key => [key, values[key] ?? ''])) }
      }
    }
  }
  warn?.(`authorization (${auth?.type ?? 'multiple credential sets'})`)
  return { type: defaultType }
}

function readBody(body, warn) {
  if (body === undefined || body?.type === 'none') return undefined
  if (isBodyFormat(body?.type) && typeof body.content === 'string') return body.content
  warn?.(`body (${body?.type ?? 'unknown format'})`)
  return undefined
}

function readHeaders(headers, requestId, warn) {
  if (headers === undefined) return []
  if (!Array.isArray(headers) || !headers.every(header => typeof header?.key === 'string' && typeof header.value === 'string')) {
    warn?.('header format')
    return []
  }
  if (headers.some(header => Object.keys(header).some(key => !['key', 'value', 'disabled'].includes(key)))) {
    warn?.('header metadata')
  }
  return headers.map(({ key, value, disabled }, index) => ({ id: `${requestId}-${index}`, key, value, enabled: disabled !== true }))
}

function readMethod(method, warn) {
  if (typeof method === 'string' && methodToken.test(method)) return method
  if (method !== undefined) warn?.('HTTP method format')
  return 'GET'
}

function importTree(files, rootName) {
  const warnings = []
  const nodePaths = Object.create(null)
  const recognized = new Set()
  const scopes = new Map([['', { files: new Map(), folders: new Set() }]])
  const rootId = randomUUID()
  let postmanFileCount = 0

  function getScope(directory) {
    if (scopes.has(directory)) return scopes.get(directory)
    const scope = { files: new Map(), folders: new Set() }
    scopes.set(directory, scope)
    const separator = directory.lastIndexOf('/')
    getScope(separator < 0 ? '' : directory.slice(0, separator)).folders.add(directory)
    return scope
  }

  for (const [path, bytes] of files) {
    const segments = path.split('/')
    const resourceIndex = segments.findIndex(segment => segment === '.resources' || segment.endsWith('.resources'))
    if (resourceIndex >= 0) {
      const scope = getScope(segments.slice(0, resourceIndex).join('/'))
      if (segments[resourceIndex] === '.resources' && resourceIndex === segments.length - 2 && definitionSuffix.test(path)) {
        if (scope.definition) reject(`Multiple Postman definitions in ${path}.`)
        scope.definition = path
      }
    } else if (path.endsWith('/')) {
      getScope(path.slice(0, -1))
      recognized.add(path)
    } else if (requestSuffix.test(path)) {
      getScope(segments.slice(0, -1).join('/')).files.set(path, bytes)
    }
  }

  function makeWarning(path) {
    return field => warnings.push(`${path}: ${field} is preserved for export and cannot be edited here.`)
  }

  function readScope(directory, id) {
    const scope = scopes.get(directory)
    const path = scope.definition ?? (directory ? `${directory}/${definitionName}` : definitionName)
    const defaultName = directory ? posix.basename(directory) : rootName
    const defaultAuth = 'inherit'
    let data = {}
    if (scope.definition) {
      data = parseYaml(files.get(path), path).data
      if (data.$kind !== 'collection') reject(`Expected a Postman v3 collection definition in ${path}.`)
      postmanFileCount += 1
      recognized.add(path)
    }
    nodePaths[id] = path
    const warn = makeWarning(path)
    reportExtraFields(data, ['$kind', '$schema', 'id', 'name', 'order', 'auth', 'scripts'], warn)
    const children = [...scope.folders].map(child => readScope(child, randomUUID()))
    for (const [requestPath, bytes] of scope.files) {
      const parsed = parseYaml(bytes, requestPath).data
      if (typeof parsed.$kind !== 'string' || !parsed.$kind.endsWith('-request')) {
        reject(`Expected a Postman v3 request in ${requestPath}.`)
      }
      postmanFileCount += 1
      recognized.add(requestPath)
      const warnRequest = makeWarning(requestPath)
      if (parsed.$kind !== 'http-request') {
        warnRequest(parsed.$kind)
        continue
      }
      if (parsed.url !== undefined && typeof parsed.url !== 'string') reject(`Invalid HTTP URL in ${requestPath}.`)
      const requestId = randomUUID()
      nodePaths[requestId] = requestPath
      reportExtraFields(parsed, ['$kind', '$schema', 'id', 'name', 'order', 'auth', 'url', 'method', 'headers', 'body', 'scripts'], warnRequest)
      const body = readBody(parsed.body, warnRequest)
      children.push({ order: parsed.order, node: {
        id: requestId,
        type: 'request',
        name: displayName(parsed.name, posix.basename(requestPath).replace(requestSuffix, '')),
        auth: readAuth(parsed.auth, 'inherit', warnRequest),
        ...readScripts(parsed.scripts, true, warnRequest),
        method: readMethod(parsed.method, warnRequest),
        url: parsed.url ?? '',
        headers: readHeaders(parsed.headers, requestId, warnRequest),
        ...(body === undefined ? {} : { body, bodyFormat: parsed.body.type }),
      } })
    }
    children.sort((a, b) => sortOrder(a.order) - sortOrder(b.order) || a.node.name.localeCompare(b.node.name))
    const node = {
      id,
      name: displayName(data.name, defaultName),
      auth: readAuth(data.auth, defaultAuth, warn),
      ...readScripts(data.scripts, false, warn),
      items: children.map(child => child.node),
    }
    if (directory) node.type = 'folder'
    return { node, order: data.order }
  }

  const { node } = readScope('', rootId)
  if (!postmanFileCount) reject('No Postman Collection v3 YAML definition or request was found.')
  for (const path of files.keys()) {
    if (!recognized.has(path)) makeWarning(path)('resource file or directory')
  }
  node.exchange = {
    rootName,
    files: Array.from(files, ([path, bytes]) => ({ path, content: Buffer.from(bytes).toString('base64') })),
    nodePaths,
    warnings,
  }
  return node
}

function sortOrder(value) {
  return Number.isFinite(value) ? value : Infinity
}

function displayName(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function reportExtraFields(data, supported, warn) {
  for (const key of Object.keys(data)) {
    if (!supported.includes(key)) warn(key)
  }
}

function supportedScript(scripts, type) {
  if (!Array.isArray(scripts)) return
  const entries = scripts.filter(script => script?.type === type)
  const script = entries[0]
  const supported = entries.length === 1 && typeof script.code === 'string' && script.code.length <= 65536 &&
    (script.language === undefined || script.language === 'text/javascript') &&
    Object.keys(script).every(key => ['code', 'type', 'language'].includes(key))
  return supported ? script : undefined
}

const scriptFields = { preRequest: 'beforeRequest', postResponse: 'afterResponse' }

function readScripts(scripts, request, warn) {
  const entries = Object.entries(scriptFields).flatMap(([field, kind]) => {
    const script = supportedScript(scripts, request ? kind : `http:${kind}`)
    return script ? [[field, script.code]] : []
  })
  if (scripts !== undefined && (!Array.isArray(scripts) || scripts.length > entries.length)) warn?.('additional scripts')
  return Object.fromEntries(entries)
}

function updateScripts(document, original, request, node, path) {
  let scripts = original
  for (const [field, kind] of Object.entries(scriptFields)) {
    const type = request ? kind : `http:${kind}`
    const code = node[field]
    if (code === undefined || (supportedScript(scripts, type)?.code || undefined) === (code || undefined)) continue
    const entries = scripts ?? []
    if (!Array.isArray(entries) || (entries.some(script => script?.type === type) && !supportedScript(entries, type))) {
      reject(`The ${type} scripts in ${path} are preserved from Postman and cannot be replaced here.`)
    }
    scripts = entries.filter(script => script?.type !== type)
    if (code) scripts.push({ type, language: 'text/javascript', code })
  }
  if (scripts === original) return
  if (scripts.length) document.set('scripts', scripts)
  else document.delete('scripts')
}

export function importPostmanCollection(entries, rootName) {
  if (!Array.isArray(entries) || entries.length > maxFiles || typeof rootName !== 'string') {
    reject('Expected a Postman Collection v3 directory.')
  }
  validateSegment(rootName)
  const validatePath = pathValidator()
  let size = 0
  const files = new Map()
  for (const entry of entries) {
    validatePath(entry?.path)
    const content = entry.content
    if (typeof content !== 'string' || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(content)) {
      reject('Invalid collection file content.')
    }
    const bytes = Buffer.from(content, 'base64')
    size += bytes.length
    if (size > maxBytes) reject('The extracted collection is too large.')
    files.set(entry.path, bytes)
  }
  return importTree(files, rootName)
}

export function importPostmanZip(bytes) {
  const validatePath = pathValidator()
  let size = 0
  let count = 0
  let entries
  try {
    if (bytes.length < 22 || bytes.length > maxBytes) reject('The collection ZIP has an invalid size.')
    entries = Object.entries(unzipSync(bytes, { filter: entry => {
      validatePath(entry.name)
      size += Math.max(entry.size, entry.originalSize)
      count += 1
      if (size > maxBytes || count > maxFiles) reject('The extracted collection is too large.')
      return true
    } }))
  } catch (error) {
    if (error instanceof PostmanExchangeError) throw error
    reject('Could not read the Postman collection ZIP.')
  }
  const roots = new Set(entries.map(([path]) => path.split('/')[0]))
  const environmentEntry = entries.find(([path]) => path.endsWith(environmentSuffix) &&
    roots.has(path.slice(0, -environmentSuffix.length)))
  if (environmentEntry) entries = entries.filter(entry => entry !== environmentEntry)
  const root = entries[0]?.[0].split('/')[0]
  const hasWrapper = root && root !== '.resources' && entries.every(([path]) => path.startsWith(`${root}/`))
  const files = new Map(hasWrapper
    ? entries.filter(([path]) => path !== `${root}/`).map(([path, content]) => [path.slice(root.length + 1), content])
    : entries)
  const collection = importTree(files, hasWrapper ? root : 'Imported Collection')
  if (environmentEntry) collection.environment = readPostmanEnvironment(environmentEntry[1])
  return collection
}

function readPostmanEnvironment(bytes) {
  let data
  try {
    data = JSON.parse(textDecoder.decode(bytes))
  } catch {
    reject('Invalid Postman environment file.')
  }
  if (data?._postman_variable_scope !== 'environment' || typeof data.name !== 'string' || !data.name.trim() ||
      !Array.isArray(data.values)) reject('Invalid Postman environment file.')
  const variables = data.values.map(row => {
    if (typeof row?.key !== 'string' || typeof row.value !== 'string' ||
        (row.enabled !== undefined && typeof row.enabled !== 'boolean')) reject('Invalid Postman environment variable.')
    return { id: randomUUID(), key: row.key, value: row.value, enabled: row.enabled ?? true }
  })
  return { id: randomUUID(), name: data.name, variables }
}

export function importGeneratedPostmanCollection({ items, ...definition }) {
  const files = new Map()
  const allocate = allocatePaths(files)
  let size = 0
  function write(path, data) {
    const bytes = Buffer.from(stringify(data, { lineWidth: 0 }))
    size += bytes.length
    if (size > maxBytes || files.size >= maxFiles) reject('The generated collection is too large.')
    files.set(path, bytes)
  }
  function writeScope(parent, children, scope) {
    write(childPath(parent, definitionName), { $kind: 'collection', ...scope })
    for (const [index, { items, examples, ...item }] of children.entries()) {
      const order = (index + 1) * 1000
      const path = allocate(parent, item.name, !items)
      if (items) {
        writeScope(path, items, { ...item, order })
      } else {
        write(path, { $kind: 'http-request', ...item, order })
        for (const [index, example] of examples.entries()) {
          write(`${requestResources(path)[1]}examples/${index + 1}.example.yaml`, { $kind: 'http-example', ...example })
        }
      }
    }
  }
  writeScope('', items, definition)
  return importTree(files, safeStem(definition.name))
}

function safeStem(name) {
  const stem = Array.from(name.normalize('NFC').trim(), character =>
    character < ' ' || character === '/' || invalidSegment.test(character) ? '-' : character)
    .slice(0, 70).join('').replace(/[. ]+$/, '')
  if (!stem || reservedSegment.test(stem)) return `Item-${stem}`
  return stem.toLowerCase().endsWith('.resources') ? `${stem}-item` : stem
}

function yamlPath(path) {
  return path.replace(/\.ya?ml$/i, '.yaml')
}

function childPath(parent, name) {
  return parent ? `${parent}/${name}` : name
}

function scopeDirectory(path) {
  return path.slice(0, path.lastIndexOf('.resources/')).replace(/\/$/, '')
}

function requestResources(path) {
  const stem = posix.basename(path).replace(requestSuffix, '')
  const directory = posix.dirname(path)
  const resources = `${stem}.resources/`
  const parent = directory === '.' ? '' : directory
  return [childPath(parent, `.resources/${resources}`), childPath(parent, resources)]
}

function editableIds(collection) {
  const ids = new Set()
  function visit(node) {
    ids.add(node.id)
    node.items?.forEach(visit)
  }
  visit(collection)
  return ids
}

function retainedFiles(collection) {
  const ids = editableIds(collection)
  const removedPaths = new Set()
  const removedPrefixes = []
  for (const [id, path] of Object.entries(collection.exchange?.nodePaths ?? {})) {
    if (ids.has(id)) continue
    if (requestSuffix.test(path)) {
      removedPaths.add(path)
      removedPrefixes.push(...requestResources(path))
    } else {
      removedPrefixes.push(`${scopeDirectory(path)}/`)
    }
  }
  return new Map((collection.exchange?.files ?? [])
    .filter(file => !removedPaths.has(file.path) && !removedPrefixes.some(prefix => file.path.startsWith(prefix)))
    .map(({ path, content }) => [path, Buffer.from(content, 'base64')]))
}

function allocatePaths(originalFiles) {
  const reserved = new Set()
  function reserve(path) {
    const segments = path.replace(/\/$/, '').normalize('NFC').toLowerCase().split('/')
    while (segments.length) {
      reserved.add(segments.join('/'))
      segments.pop()
    }
  }
  for (const path of originalFiles.keys()) reserve(yamlPath(path))

  return (parent, name, isRequest) => {
    const stem = safeStem(name)
    for (let index = 1; ; index += 1) {
      const candidate = childPath(parent, index === 1 ? stem : `${stem}-${index}`)
      const path = isRequest ? `${candidate}.request.yaml` : candidate
      const conflicts = isRequest ? [path, ...requestResources(path)] : [path]
      if (conflicts.some(conflict => reserved.has(conflict.replace(/\/$/, '').normalize('NFC').toLowerCase()))) continue
      for (const entry of conflicts) reserve(entry)
      return path
    }
  }
}

function updateAuth(document, original, auth, defaultType, path) {
  let opaque = false
  const previous = readAuth(original, defaultType, reason => { opaque ||= reason !== 'authorization metadata' })
  if (isDeepStrictEqual(previous, auth)) return
  if (opaque) reject(`The authorization in ${path} is preserved from Postman and cannot be replaced here.`)
  if (auth.type === 'inherit') {
    if (Object.keys(original ?? {}).some(key => !['type', 'credentials'].includes(key))) {
      reject(`The authorization in ${path} has Postman metadata that would be removed by inheriting authorization.`)
    }
    document.delete('auth')
    return
  }
  const { credentials, ...metadata } = original ?? {}
  if (auth.type === 'none') {
    document.set('auth', { ...metadata, type: 'noauth' })
    return
  }
  if (auth.type === 'jwt') {
    document.set('auth', { ...metadata, type: 'jwt', credentials: writeJwt(auth) })
    return
  }
  const fields = auth.type === 'basic' ? ['username', 'password'] : ['token']
  const previousEntries = Array.isArray(credentials) ? credentials : []
  document.set('auth', {
    ...metadata,
    type: auth.type,
    credentials: fields.map(key => ({ ...previousEntries.find(entry => entry.key === key), key, value: auth[key] })),
  })
}

function updateHeaders(document, original, request, path) {
  let opaque = false
  const previous = readHeaders(original, request.id, reason => { opaque = reason === 'header format' })
  if (isDeepStrictEqual(previous, request.headers)) return
  if (opaque) reject(`The header format in ${path} is preserved from Postman and cannot be replaced here.`)
  if (!request.headers.length) {
    document.delete('headers')
    return
  }
  const sourceRows = new Map(previous.map(({ id }, index) => [id, original[index]]))
  document.set('headers', request.headers.map(({ id, key, value, enabled }) => {
    const row = sourceRows.get(id)
    return { ...row, key, value, ...(enabled && row?.disabled === undefined ? {} : { disabled: !enabled }) }
  }))
}

function updateBody(document, original, { body, bodyFormat, headers }, path) {
  let opaque = false
  const previous = readBody(original, () => { opaque = true })
  const type = bodyFormat ?? (isBodyFormat(original?.type) ? original.type : inferBodyFormat(headers))
  if (previous === body && (body === undefined || original.type === type)) return
  if (opaque) reject(`The body in ${path} is preserved from Postman and cannot be replaced here.`)
  if (body === undefined) document.delete('body')
  else document.set('body', { ...original, type, content: body })
}

function queryString(url) {
  return url.split('#', 1)[0].split(/\?(.*)/s)[1] ?? ''
}

function readQuery(query) {
  return query.split('&').filter(Boolean).flatMap(part =>
    [...new URLSearchParams(part)].map(([key, value]) => ({ key, value: part.includes('=') ? value : null })))
}

function updateUrl(document, previous, request, path, existing) {
  if (existing && (previous.url ?? '') === request.url) return
  const query = queryString(request.url)
  const oldQuery = queryString(previous.url ?? '')
  if (oldQuery !== query) {
    const params = readQuery(query)
    if (!previous.queryParams || isDeepStrictEqual(previous.queryParams, readQuery(oldQuery))) {
      if (params.length) document.set('queryParams', params)
      else document.delete('queryParams')
    } else {
      const merged = mergeQueryParams(previous.queryParams, params)
      if (!merged) reject(`The URL edit would remove query parameter metadata preserved from Postman in ${path}.`)
      document.set('queryParams', merged)
    }
  }
  document.set('url', request.url)
}

function mergeQueryParams(previous, params) {
  if (!Array.isArray(previous) || !previous.every(param => param && typeof param.key === 'string')) return null
  const active = previous.filter(param => param.disabled !== true)
  const merged = params.map(param => {
    const index = active.findIndex(previousParam => previousParam.key === param.key)
    if (index < 0) return param
    const [original] = active.splice(index, 1)
    return { ...original, ...param }
  })
  if (active.some(param => Object.keys(param).some(key => key !== 'key' && key !== 'value'))) return null
  return [...merged, ...previous.filter(param => param.disabled === true)]
}

function writeNode(files, path, originalPath, node, defaultName, defaultAuth, order) {
  const existing = originalPath && files.get(originalPath)
  const { document, data } = existing ? parseYaml(existing, originalPath) : { document: parseDocument('{}'), data: {} }
  const oldYaml = document.toString()
  const isRequest = node.type === 'request'
  if (isRequest || !originalPath || node.name !== defaultName || node.auth.type !== defaultAuth || node.preRequest || node.postResponse || existing) {
    if (!existing) document.set('$kind', isRequest ? 'http-request' : 'collection')
    if (node.name !== displayName(data.name, defaultName) || !originalPath) document.set('name', node.name)
    if (!originalPath && order !== undefined) document.set('order', order)
    updateAuth(document, data.auth, node.auth, defaultAuth, path)
    updateScripts(document, data.scripts, isRequest, node, path)
    if (isRequest) {
      updateUrl(document, data, node, path, existing)
      if (!existing || readMethod(data.method) !== node.method) {
        if (data.method !== undefined && (typeof data.method !== 'string' || !methodToken.test(data.method))) {
          reject(`The HTTP method in ${path} is preserved from Postman and cannot be replaced here.`)
        }
        document.set('method', node.method)
      }
      updateHeaders(document, data.headers, node, path)
      updateBody(document, data.body, node, path)
    }
    const yaml = document.toString()
    if (existing && originalPath !== path) files.delete(originalPath)
    files.set(path, existing && oldYaml === yaml ? existing : Buffer.from(yaml))
  }
}

export function exportPostmanZip(collection, environment) {
  const exchange = collection.exchange
  const rootName = exchange?.rootName ?? safeStem(collection.name)
  const originalPaths = exchange?.nodePaths ?? {}
  const files = retainedFiles(collection)
  const allocate = allocatePaths(files)

  function writeChildren(items, parent) {
    const lastOrder = items.reduce((max, item) => {
      const path = originalPaths[item.id]
      if (!path || !files.has(path)) return max
      const { data } = parseYaml(files.get(path), path)
      return Number.isFinite(data.order) ? Math.max(max, data.order) : max
    }, 0)
    for (const [index, item] of items.entries()) {
      const original = originalPaths[item.id]
      const order = lastOrder + (index + 1) * 1000
      if (item.type === 'folder') {
        const directory = original ? scopeDirectory(original) : allocate(parent, item.name, false)
        if (original && childPath(parent, posix.basename(directory)) !== directory) reject('Imported Postman folders cannot be moved between scopes.')
        writeNode(files, childPath(directory, definitionName), original, item, posix.basename(directory), 'inherit', order)
        writeChildren(item.items, directory)
      } else {
        const path = original ? yamlPath(original) : allocate(parent, item.name, true)
        if (original && childPath(parent, posix.basename(path)) !== path) reject('Imported Postman requests cannot be moved between scopes.')
        writeNode(files, path, original, item, posix.basename(path).replace(requestSuffix, ''), 'inherit', order)
      }
    }
  }

  writeNode(files, definitionName, originalPaths[collection.id], collection, rootName, 'inherit')
  writeChildren(collection.items, '')
  const archive = Object.fromEntries([...files].map(([path, bytes]) => [childPath(rootName, path), bytes]))
  if (environment) {
    archive[rootName + environmentSuffix] = Buffer.from(JSON.stringify({
      name: environment.name,
      values: environment.variables.map(({ key, value, enabled }) => ({ key, value, enabled, type: 'default' })),
      _postman_variable_scope: 'environment',
    }, null, 2) + '\n')
  }
  return zipSync(archive)
}
