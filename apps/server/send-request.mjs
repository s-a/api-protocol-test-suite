import { performance } from 'node:perf_hooks'
import { JwtAuthError, applyJwtForTarget, findJwtKey } from './jwt-auth.mjs'
import { readUserData, updateUserData } from './user-data.mjs'
import { jwtAlgorithms } from './jwt-settings.ts'
import { PreRequestError, runPreRequest } from './pre-request.mjs'
import { isDynamicReference } from './dynamic-variables.ts'
import { generateDynamicValue } from './postman-variables.mjs'
import { sdk } from './postman-runtime.mjs'
import { jwtSettings } from './jwt-settings.ts'
import { checkTarget, TargetPolicyError } from './targets.mjs'

const bodyLimit = 2 * 1024 * 1024
const timeoutMs = 15000
const managedHeaders = new Set(['connection', 'content-length', 'expect', 'host', 'transfer-encoding', 'upgrade'])
const jwtKeysFile = 'jwt-keys.json'

class SendError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function checkOrigin(request, bindHost) {
  let host
  try {
    host = new URL(`http://${request.headers.host}`)
  } catch {
    throw new SendError(403, 'The request host is not allowed.')
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
  if ((loopback.has(bindHost) || bindHost === '::1') && !loopback.has(host.hostname)) {
    throw new SendError(403, 'The request host is not allowed.')
  }
  if (request.headers.origin && !['http:', 'https:'].some(protocol => request.headers.origin === `${protocol}//${host.host}`)) {
    throw new SendError(403, 'Send is available only from this workspace.')
  }
}

async function readPayload(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > bodyLimit) throw new SendError(413, 'The request exceeds 2 MiB.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SendError(400, 'Invalid request JSON.')
  }
}

async function prepare(payload, accountId) {
  if (!Array.isArray(payload?.headers)) throw new SendError(400, 'Invalid request headers.')
  const collectionScope = payload.collectionVariables ? { collectionVariables: payload.collectionVariables } : undefined
  const execution = payload.scripts === undefined ? { ...payload, variables: {} } : await runPreRequest(payload.scripts,
    { method: payload.method, url: payload.url, body: payload.body, headers: payload.headers }, payload.scriptVariables ?? {},
    sendScriptRequest, undefined, collectionScope)
  if (execution.skipped) throw new SendError(400, 'The pre-request script skipped this request.')
  const { method, body } = execution
  const missing = new Set()
  const resolve = value => value.replace(/\{\{([^{}]+)\}\}/g, (reference, name) => {
    const generated = generateDynamicValue(name)
    if (generated !== undefined) return generated
    if (execution.variables && Object.hasOwn(execution.variables, name)) return String(execution.variables[name])
    if (payload.scripts !== undefined || isDynamicReference(name)) missing.add(name)
    return reference
  })
  let url
  try {
    if (typeof execution.url === 'string') url = new URL(resolve(execution.url))
  } catch {
    if (missing.size) throw new SendError(400, `Unresolved variables: ${[...missing].join(', ')}`)
    throw new SendError(400, 'Enter a valid HTTP or HTTPS URL.')
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SendError(400, 'Enter an HTTP or HTTPS URL without embedded credentials.')
  }
  if (typeof method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) || /^(CONNECT|TRACE|TRACK)$/i.test(method)) {
    throw new SendError(400, 'This HTTP method is unavailable.')
  }
  if (body !== undefined && (typeof body !== 'string' || /^(GET|HEAD)$/i.test(method))) {
    throw new SendError(400, 'GET and HEAD requests must use Body type none.')
  }
  const headerRows = execution.headers
  if (!Array.isArray(headerRows)) throw new SendError(400, 'Invalid request headers.')
  const headers = new Headers()
  for (const row of headerRows) {
    if (!Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== 'string')) {
      throw new SendError(400, 'Invalid request header.')
    }
    const [key, value] = row.map(resolve)
    if (missing.size) throw new SendError(400, `Unresolved variables: ${[...missing].join(', ')}`)
    if (managedHeaders.has(key.toLowerCase())) throw new SendError(400, `The server sets the ${key} header.`)
    try {
      headers.append(key, value)
    } catch {
      throw new SendError(400, `Invalid request header: ${key}.`)
    }
  }
  const resolvedBody = body === undefined ? undefined : resolve(body)
  const auth = payload.authorization
  if (auth !== undefined) {
    let value
    if (auth?.type === 'basic' && typeof auth.username === 'string' && typeof auth.password === 'string') {
      value = `Basic ${Buffer.from(`${resolve(auth.username)}:${resolve(auth.password)}`).toString('base64')}`
    } else if (auth?.type === 'bearer' && typeof auth.token === 'string') {
      const token = resolve(auth.token)
      if (!token.trim()) throw new SendError(400, 'Enter a bearer token before sending.')
      value = `Bearer ${token}`
    } else throw new SendError(400, 'Invalid authorization settings.')
    try {
      headers.set('Authorization', value)
    } catch {
      throw new SendError(400, 'Invalid Authorization header.')
    }
  }
  let jwt
  if (payload.jwt !== undefined) {
    const settings = jwtSettings(payload.jwt)
    if (!settings) throw new SendError(400, 'Invalid JWT Bearer settings.')
    const name = settings.secretRef.slice(2, -2)
    jwt = { ...settings, payload: resolve(settings.payload), header: resolve(settings.header),
      secretRef: settings.secretRef.startsWith('{{') ? execution.variables?.[name] ?? name : settings.secretRef,
      headerPrefix: settings.addTokenTo === 'header' ? resolve(settings.headerPrefix) : settings.headerPrefix,
      queryParamKey: settings.addTokenTo === 'queryParam' ? resolve(settings.queryParamKey) : settings.queryParamKey }
  }
  if (missing.size) throw new SendError(400, `Unresolved variables: ${[...missing].join(', ')}`)
  if (jwt) applyJwtForTarget(jwt, url, headers, await readUserData(accountId, jwtKeysFile, {}))
  const jwtQueryKey = jwt?.addTokenTo === 'queryParam' ? jwt.queryParamKey || 'token' : undefined
  return { url, method, headers, body: resolvedBody, scopes: execution.scopes ?? collectionScope, jwtQueryKey }
}

async function sendScriptRequest(input, signal) {
  const request = new sdk.Request(input)
  if (request.body && request.body.mode !== 'raw') throw new Error('Only raw script request bodies are supported.')
  const { url, method, headers, body } = await prepare({
    url: request.url.toString(), method: request.method, body: request.body?.raw,
    headers: request.headers.all().filter(row => !row.disabled).map(row => [row.key, row.value]),
  })
  await checkTarget(url)
  const response = await fetch(url, { method, headers, body, redirect: 'manual', signal })
  const result = await readResponseBody(response)
  return { code: response.status, status: response.statusText, body: result.body,
    header: [...response.headers].map(([key, value]) => ({ key, value })) }
}

async function readResponseBody(response) {
  const reader = response.body?.getReader()
  if (!reader) return { body: '', size: 0, truncated: false }
  const chunks = []
  let size = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = bodyLimit - size
    chunks.push(value.subarray(0, remaining))
    size += Math.min(remaining, value.length)
    if (value.length > remaining) {
      truncated = true
      await reader.cancel()
      break
    }
  }
  return { body: Buffer.concat(chunks).toString('utf8'), size, truncated }
}

export async function handleSendRequest(request, response, send, bindHost, accountId) {
  const json = (status, data) => {
    response.setHeader('Cache-Control', 'no-store')
    send(request, response, status, 'application/json; charset=utf-8', JSON.stringify(data))
  }
  const cancelled = new AbortController()
  response.once('close', () => cancelled.abort())
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      throw new SendError(405, 'Method not allowed.')
    }
    checkOrigin(request, bindHost)
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new SendError(415, 'Send requires JSON.')
    }
    const payload = await readPayload(request)
    const { url, method, headers, body, scopes, jwtQueryKey } = await prepare(payload, accountId)
    await checkTarget(url)
    const start = performance.now()
    const result = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.any([timeout, cancelled.signal]) })
    const resultBody = await readResponseBody(result)
    const durationMs = Math.round(performance.now() - start)
    let postResponse
    if (payload.postScripts !== undefined) {
      try {
        const executed = await runPreRequest(payload.postScripts, { url: url.toString(), method, headers: [...headers], body },
          payload.scriptVariables ?? {}, sendScriptRequest, {
            code: result.status, status: result.statusText, body: resultBody.body, responseTime: durationMs,
            header: [...result.headers].map(([key, value]) => ({ key, value })),
          }, scopes)
        postResponse = { assertions: executed.assertions ?? [] }
      } catch (error) {
        postResponse = error instanceof TargetPolicyError
          ? { error: error.message, code: error.code }
          : { error: 'Post-response script failed or timed out.' }
      }
    }
    const sentHeaders = [...headers].map(([name, value]) => [name, /authorization|cookie|token|secret|api[-_]?key/i.test(name) ? '••••••' : value])
    const sentUrl = new URL(url)
    sentUrl.hash = ''
    if (jwtQueryKey !== undefined) sentUrl.searchParams.set(jwtQueryKey, 'REDACTED')
    json(200, {
      status: result.status, statusText: result.statusText, headers: [...result.headers],
      sentHeaders, sentRequest: { method, url: sentUrl.href, body },
      ...(postResponse && { postResponse }), durationMs, ...resultBody,
    })
  } catch (error) {
    if (cancelled.signal.aborted) return
    request.resume()
    if (error instanceof TargetPolicyError) json(error.status, { error: error.message, code: error.code })
    else if (error instanceof SendError) json(error.status, { error: error.message })
    else if (error instanceof JwtAuthError) json(400, { error: error.message })
    else if (error instanceof PreRequestError) json(400, { error: error.message })
    else if (timeout.aborted) json(504, { error: 'The target did not respond within 15 seconds.' })
    else {
      const code = error.cause?.code
      json(502, { error: `Could not complete the request${code ? ` (${code})` : ''}.` })
    }
  }
}

export async function handleJwtKeys(request, response, send, bindHost, reveal, accountId) {
  const json = (status, data) => {
    response.setHeader('Cache-Control', 'no-store')
    send(request, response, status, 'application/json; charset=utf-8', JSON.stringify(data))
  }
  try {
    const method = reveal ? 'POST' : 'PUT'
    if (request.method !== method) {
      response.setHeader('Allow', method)
      throw new SendError(405, 'Method not allowed.')
    }
    checkOrigin(request, bindHost)
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new SendError(415, 'JWT key settings require JSON.')
    }
    const payload = await readPayload(request)
    const reference = payload?.reference
    if (typeof reference !== 'string' || !/^[\w-]{1,128}$/.test(reference)) {
      throw new SendError(400, 'Enter a key name using letters, digits, underscores or hyphens.')
    }
    if (reveal) {
      const entry = findJwtKey(reference, await readUserData(accountId, jwtKeysFile, {}))
      if (!entry?.key) throw new SendError(404, 'No signing key is configured with that name.')
      json(200, { origin: entry.origin, algorithm: entry.algorithm, key: entry.key })
      return
    }
    const { origin, algorithm, key } = payload
    if (typeof key !== 'string' || !key.trim() || key.length > 65536 || !jwtAlgorithms.includes(algorithm)) {
      throw new SendError(400, 'Enter a signing key and select a JWT algorithm.')
    }
    let target
    try {
      target = new URL(origin)
    } catch {
      throw new SendError(400, 'Enter a target origin such as https://api.example.test.')
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
        target.pathname !== '/' || target.search || target.hash) {
      throw new SendError(400, 'Enter a target origin with scheme, hostname and optional port.')
    }
    await updateUserData(accountId, jwtKeysFile, {}, keys => ({ ...keys, [reference]: { origin: target.origin, algorithm, key } }))
    json(200, { origin: target.origin, algorithm })
  } catch (error) {
    request.resume()
    if (error instanceof SendError) json(error.status, { error: error.message })
    else json(500, { error: 'Could not access the server signing keys.' })
  }
}
