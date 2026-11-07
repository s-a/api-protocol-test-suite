import type { Auth, Request } from './types.ts'
import { previewVariables } from './variables.ts'
import { bodyContentTypes } from '../../../server/body-format.ts'

export function prepareSend(request: Request, variables: Record<string, string>, parentAuth?: Auth, deferRequestVariables = false) {
  const missing = new Set<string>()
  function resolve(value: string, keepDynamic = false) {
    const result = previewVariables(value, variables, keepDynamic)
    for (const name of result.unresolved) missing.add(name)
    return result.value
  }

  const resolveRequest = (value: string) => deferRequestVariables ? value : resolve(value, true)
  const url = resolveRequest(request.url)
  const body = request.body === undefined ? undefined : resolveRequest(request.body)
  const auth = request.auth.type === 'inherit' ? parentAuth : request.auth
  const headers = request.headers.filter(row => row.enabled).map(row => [resolveRequest(row.key), resolveRequest(row.value)])
    .filter(([name]) => !(auth?.type === 'basic' || auth?.type === 'bearer' || (auth?.type === 'jwt' && auth.addTokenTo === 'header')) || name.trim().toLowerCase() !== 'authorization')
  if (body !== undefined && request.bodyFormat && !headers.some(([name]) => name.trim().toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', bodyContentTypes[request.bodyFormat]])
  }
  const authorization = auth?.type === 'basic' ? { type: auth.type,
    username: resolveRequest(auth.username), password: resolveRequest(auth.password) } : auth?.type === 'bearer'
    ? { type: auth.type, token: resolveRequest(auth.token) } : undefined
  const jwt = auth?.type === 'jwt' ? {
    ...auth, payload: resolveRequest(auth.payload), header: resolveRequest(auth.header),
    secretRef: auth.secretRef.startsWith('{{')
      ? (deferRequestVariables ? auth.secretRef : Object.hasOwn(variables, auth.secretRef.slice(2, -2))
        ? resolve(auth.secretRef) : auth.secretRef.slice(2, -2))
      : auth.secretRef,
    headerPrefix: auth.addTokenTo === 'header' ? resolveRequest(auth.headerPrefix) : auth.headerPrefix,
    queryParamKey: auth.addTokenTo === 'queryParam' ? resolveRequest(auth.queryParamKey) : auth.queryParamKey,
  } : undefined
  if (missing.size) throw new Error(`Unresolved variables: ${[...missing].join(', ')}`)
  return { url, method: request.method, headers, body, ...(jwt && { jwt }), ...(authorization && { authorization }) }
}
