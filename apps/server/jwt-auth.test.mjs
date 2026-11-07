import assert from 'node:assert/strict'
import { constants, createHmac, generateKeyPairSync, verify } from 'node:crypto'
import { test } from 'node:test'
import { applyJwtForTarget } from './jwt-auth.mjs'
import { defaultJwt, jwtAlgorithms } from './jwt-settings.ts'

const origin = 'https://api.example.test'
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const curves = { 256: 'prime256v1', 384: 'secp384r1', 512: 'secp521r1' }
const hmac = Buffer.from('fixture key for signature verification')
const keys = (algorithm, key) => ({ example: { algorithm, origin, key } })

for (const algorithm of jwtAlgorithms) {
  test(`JWT Bearer produces a verifiable ${algorithm} signature`, () => {
    const family = algorithm.slice(0, 2)
    const bits = algorithm.slice(2)
    const pair = family === 'ES' ? generateKeyPairSync('ec', { namedCurve: curves[bits] }) : rsa
    const key = family === 'HS' ? hmac.toString('base64') : pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    const url = new URL(`${origin}/data`)
    const headers = new Headers({ Authorization: 'stale' })
    applyJwtForTarget({ ...defaultJwt, algorithm, base64: true, secretRef: 'example',
      header: '{"kid":"test","alg":"ignored"}', payload: '{"sub":"example-user"}' }, url, headers,
    keys(algorithm, key))
    const [header, payload, signed] = headers.get('Authorization').slice('Bearer '.length).split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { kid: 'test', alg: algorithm })
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { sub: 'example-user' })
    const input = Buffer.from(`${header}.${payload}`)
    const digest = `sha${bits}`
    if (family === 'HS') {
      assert.equal(signed, createHmac(digest, hmac).update(input).digest('base64url'))
    } else {
      const options = { key: pair.publicKey }
      if (family === 'ES') options.dsaEncoding = 'ieee-p1363'
      if (family === 'PS') Object.assign(options, { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST })
      assert.ok(verify(digest, input, options, Buffer.from(signed, 'base64url')))
    }
  })
}

test('JWT query placement replaces its parameter and requires the configured origin and algorithm', () => {
  const auth = { ...defaultJwt, secretRef: 'example', addTokenTo: 'queryParam', queryParamKey: 'jwt' }
  const headers = new Headers({ Authorization: 'existing' })
  const url = new URL(`${origin}/data?jwt=old&keep=1`)
  const stored = keys('HS256', 'example')
  applyJwtForTarget(auth, url, headers, stored)
  assert.match(url.searchParams.get('jwt'), /^[\w-]+\.[\w-]+\.[\w-]+$/)
  assert.equal(url.searchParams.getAll('jwt').length, 1)
  assert.equal(url.searchParams.get('keep'), '1')
  assert.equal(headers.get('Authorization'), 'existing')
  assert.throws(() => applyJwtForTarget(auth, new URL('https://other.test/'), headers, stored), /target origin/)
  assert.throws(() => applyJwtForTarget({ ...auth, algorithm: 'HS384' }, url, headers, stored), /algorithm/)
})
