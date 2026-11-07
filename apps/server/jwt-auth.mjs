import { constants, createHmac, createPrivateKey, sign } from 'node:crypto'
import { jwtSettings } from './jwt-settings.ts'

export class JwtAuthError extends Error {}

function jsonObject(text, label) {
  let data
  try {
    data = JSON.parse(text.trim() || '{}')
  } catch { /* Report the field without including its contents. */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new JwtAuthError(`JWT ${label} must be a JSON object.`)
  return data
}

export function findJwtKey(reference, keys) {
  return Object.hasOwn(keys, reference) ? keys[reference] : undefined
}

function signature(content, algorithm, keyValue, base64) {
  const family = algorithm.slice(0, 2)
  const bits = algorithm.slice(2)
  const digest = `sha${bits}`
  if (family === 'HS') {
    const encoded = keyValue.replace(/\s/g, '')
    const key = Buffer.from(base64 ? encoded : keyValue, base64 ? 'base64' : 'utf8')
    if (base64 && (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
        key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, ''))) {
      throw new JwtAuthError('The configured JWT signing secret is not valid Base64.')
    }
    return createHmac(digest, key).update(content).digest('base64url')
  }

  try {
    if (!keyValue.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('Expected PKCS #8 PEM')
    const key = createPrivateKey(keyValue)
    const details = key.asymmetricKeyDetails
    if (family === 'ES') {
      const curve = { 256: 'prime256v1', 384: 'secp384r1', 512: 'secp521r1' }[bits]
      if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== curve) throw new Error('Wrong curve')
      return sign(digest, Buffer.from(content), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    }
    if (key.asymmetricKeyType !== 'rsa' || !(details?.modulusLength >= 2048)) throw new Error('Expected RSA key')
    const padding = family === 'PS' ? constants.RSA_PKCS1_PSS_PADDING : constants.RSA_PKCS1_PADDING
    return sign(digest, Buffer.from(content), { key, padding, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64url')
  } catch {
    throw new JwtAuthError('The configured PKCS #8 private key is invalid for the selected JWT algorithm.')
  }
}

export function applyJwtForTarget(input, url, headers, keys) {
  const auth = jwtSettings(input)
  if (!auth?.secretRef || auth.secretRef.startsWith('{{')) throw new JwtAuthError('JWT Bearer requires valid settings and a server key reference.')
  const payload = jsonObject(auth.payload, 'payload')
  const header = { ...jsonObject(auth.header, 'header'), alg: auth.algorithm }
  if (Object.hasOwn(header, 'crit') || header.b64 === false) throw new JwtAuthError('Unsupported JWT header parameter.')
  const binding = findJwtKey(auth.secretRef, keys)
  if (binding?.origin !== url.origin || binding.algorithm !== auth.algorithm) {
    throw new JwtAuthError('The JWT key reference is not configured for this target origin and algorithm.')
  }
  if (!binding.key) throw new JwtAuthError('The configured JWT signing key is missing on the server.')
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const content = `${encode(header)}.${encode(payload)}`
  const token = `${content}.${signature(content, auth.algorithm, binding.key, auth.base64)}`
  if (auth.addTokenTo === 'queryParam') {
    url.searchParams.set(auth.queryParamKey || 'token', token)
  } else {
    try {
      headers.set('Authorization', auth.headerPrefix ? `${auth.headerPrefix} ${token}` : token)
    } catch {
      throw new JwtAuthError('Invalid JWT request header prefix.')
    }
  }
}
