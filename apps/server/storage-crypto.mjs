import {
  constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPair, privateDecrypt, publicEncrypt, randomBytes, randomUUID,
} from 'node:crypto'
import { link, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const generatePair = promisify(generateKeyPair)
const keyIdPattern = /^[a-f0-9]{64}$/
const passwordLabel = 'account-password-v1'
const storageLabel = 'account-storage-v1'
const totpLabel = 'account-totp-v1'

export async function atomicWrite(file, contents, exclusive = false) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
    if (exclusive) await link(temporary, file)
    else await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function readOptional(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function workspaceEncryptionEnabled() {
  const setting = process.env.WORKSPACE_ENCRYPTION_ENABLED
  if (setting === undefined || setting === 'true') return true
  if (setting === 'false') return false
  throw new Error('WORKSPACE_ENCRYPTION_ENABLED must be true or false.')
}

async function resolvedLocation(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error
    return resolve(await resolvedLocation(dirname(path)), relative(dirname(path), path))
  }
}

export async function keyDirectory(userDataRoot) {
  const configuredDirectory = process.env.ENCRYPTION_KEYS_DIR || process.env.ACCOUNT_KEY_DIR
  if (!configuredDirectory) throw new Error('Set ENCRYPTION_KEYS_DIR to the encryption key directory.')
  const directory = await resolvedLocation(resolve(configuredDirectory))
  const path = relative(await resolvedLocation(userDataRoot), directory)
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))) {
    throw new Error('ENCRYPTION_KEYS_DIR must be outside the user data directory.')
  }
  return directory
}

function fingerprint(publicKey) {
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('Expected an RSA key of at least 2048 bits.')
  }
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
}

export async function loadKey(directory, id, kind) {
  if (typeof id !== 'string' || !keyIdPattern.test(id)) throw new Error('Invalid RSA key ID.')
  const pem = await readOptional(join(directory, id + '.' + kind + '.pem'))
  if (pem === undefined) throw new Error('Missing RSA ' + kind + ' key: ' + id)
  const key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem)
  if (fingerprint(kind === 'private' ? createPublicKey(key) : key) !== id) {
    throw new Error('RSA key does not match its ID.')
  }
  return key
}

export async function activeKeyId(directory) {
  const id = (await readOptional(join(directory, 'active')))?.trim()
  if (!id || !keyIdPattern.test(id)) throw new Error('No valid active RSA key. Run storage generate-key.')
  return id
}

export async function generateStorageKey(directory) {
  const { privateKey, publicKey } = await generatePair('rsa', { modulusLength: 3072 })
  const id = fingerprint(publicKey)
  await atomicWrite(join(directory, id + '.private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), true)
  await atomicWrite(join(directory, id + '.public.pem'), publicKey.export({ type: 'spki', format: 'pem' }), true)
  try {
    await atomicWrite(join(directory, 'active'), id + '\n', true)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return id
}

function decode(value, length) {
  if (typeof value !== 'string') throw new Error('Invalid encrypted data.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error('Invalid encrypted data.')
  }
  return bytes
}

export function sealData(key, context, bytes) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(context)))
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  return { version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') }
}

export function openData(key, context, envelope) {
  if (envelope?.version !== 1) throw new Error('Invalid encrypted data version.')
  const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.nonce, 12), { authTagLength: 16 })
  decipher.setAAD(Buffer.from(JSON.stringify(context)))
  decipher.setAuthTag(decode(envelope.tag, 16))
  return Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()])
}

function rsaOptions(key, label, context) {
  return { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
    oaepLabel: Buffer.from(JSON.stringify([label, ...context])) }
}

function wrapKey(publicKey, label, context, key) {
  return publicEncrypt(rsaOptions(publicKey, label, context), key).toString('base64')
}

function unwrapKey(privateKey, label, context, wrapped) {
  const key = privateDecrypt(rsaOptions(privateKey, label, context), decode(wrapped))
  if (key.length !== 32) throw new Error('Invalid AES key.')
  return key
}

export async function wrapAccountKey(directory, id, account, key) {
  const publicKey = await loadKey(directory, id, 'public')
  return { version: 1, keyId: id, wrappedKey: wrapKey(publicKey, storageLabel, [account, id], key) }
}

export async function unwrapAccountKey(directory, account, envelope) {
  if (envelope?.version !== 1) throw new Error('Invalid account key version.')
  const privateKey = await loadKey(directory, envelope.keyId, 'private')
  return unwrapKey(privateKey, storageLabel, [account, envelope.keyId], envelope.wrappedKey)
}

export async function sealTotpSecret(directory, accountId, secret) {
  const keyId = await activeKeyId(directory)
  const publicKey = await loadKey(directory, keyId, 'public')
  const key = randomBytes(32)
  return {
    ...sealData(key, [totpLabel, accountId], secret),
    keyId,
    wrappedKey: wrapKey(publicKey, totpLabel, [accountId, keyId], key),
  }
}

async function unwrapTotpKey(directory, accountId, envelope) {
  const privateKey = await loadKey(directory, envelope.keyId, 'private')
  return unwrapKey(privateKey, totpLabel, [accountId, envelope.keyId], envelope.wrappedKey)
}

export async function openTotpSecret(directory, accountId, envelope) {
  const key = await unwrapTotpKey(directory, accountId, envelope)
  const secret = openData(key, [totpLabel, accountId], envelope)
  if (secret.length !== 20) throw new Error('Invalid TOTP secret.')
  return secret
}

export async function rewrapTotpSecret(directory, accountId, envelope, keyId) {
  const key = await unwrapTotpKey(directory, accountId, envelope)
  const publicKey = await loadKey(directory, keyId, 'public')
  const replacement = { ...envelope, keyId, wrappedKey: wrapKey(publicKey, totpLabel, [accountId, keyId], key) }
  const verified = await unwrapTotpKey(directory, accountId, replacement)
  if (!verified.equals(key)) throw new Error('Rewrapped TOTP key failed verification.')
  return replacement
}

export async function sealPassword(file, command, username, password) {
  const publicKey = createPublicKey(await readFile(file))
  const keyId = fingerprint(publicKey)
  const key = randomBytes(32)
  const context = [command, username, keyId]
  return {
    ...sealData(key, [passwordLabel, ...context], Buffer.from(password)),
    keyId, wrappedKey: wrapKey(publicKey, passwordLabel, context, key),
  }
}

export async function openPassword(directory, command, username, envelope) {
  const id = await activeKeyId(directory)
  if (envelope?.keyId !== id) throw new Error('Password package must use the active RSA key.')
  const privateKey = await loadKey(directory, id, 'private')
  const context = [command, username, id]
  const key = unwrapKey(privateKey, passwordLabel, context, envelope.wrappedKey)
  return openData(key, [passwordLabel, ...context], envelope).toString('utf8')
}
