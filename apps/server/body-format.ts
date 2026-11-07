export const bodyContentTypes = {
  text: 'text/plain',
  javascript: 'application/javascript',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
}

export type BodyFormat = keyof typeof bodyContentTypes

export function isBodyFormat(value: unknown): value is BodyFormat {
  return typeof value === 'string' && Object.hasOwn(bodyContentTypes, value)
}

export function inferBodyFormat(headers: readonly { key: string, value: string, enabled: boolean }[]): BodyFormat {
  const mediaType = headers.find(row => row.enabled && row.key.trim().toLowerCase() === 'content-type')
    ?.value.split(';')[0].trim().toLowerCase() ?? ''
  if (mediaType.endsWith('/json') || mediaType.endsWith('+json')) return 'json'
  if (mediaType.endsWith('/xml') || mediaType.endsWith('+xml')) return 'xml'
  if (mediaType === 'text/html') return 'html'
  if (mediaType === 'application/javascript' || mediaType === 'text/javascript') return 'javascript'
  return 'text'
}
