export const jwtAlgorithms = [
  'HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512',
] as const

export type JwtSettings = {
  type: 'jwt'
  algorithm: typeof jwtAlgorithms[number]
  base64: boolean
  secretRef: string
  payload: string
  header: string
  addTokenTo: 'header' | 'queryParam'
  headerPrefix: string
  queryParamKey: string
}

export function isJwtSecretReference(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[\w-]+|\{\{[\w-]+\}\})?$/.test(value)
}

export function jwtSettings(value: unknown): JwtSettings | undefined {
  const auth = value as Partial<JwtSettings> | null
  if (auth?.type !== 'jwt' || !auth.algorithm || !jwtAlgorithms.includes(auth.algorithm) ||
      typeof auth.base64 !== 'boolean' || !isJwtSecretReference(auth.secretRef) ||
      typeof auth.payload !== 'string' || typeof auth.header !== 'string' ||
      !['header', 'queryParam'].includes(auth.addTokenTo ?? '') ||
      typeof auth.headerPrefix !== 'string' || typeof auth.queryParamKey !== 'string') return
  const { algorithm, base64, secretRef, payload, header, addTokenTo, headerPrefix, queryParamKey } = auth as JwtSettings
  return { type: 'jwt', algorithm, base64, secretRef, payload, header, addTokenTo, headerPrefix, queryParamKey }
}

export const defaultJwt: JwtSettings = {
  type: 'jwt', algorithm: 'HS256', base64: false, secretRef: '', payload: '{}', header: '',
  addTokenTo: 'header', headerPrefix: 'Bearer', queryParamKey: 'token',
}
