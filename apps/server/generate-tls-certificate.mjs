import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const defaultHosts = ['localhost', '127.0.0.1', '::1']
const usage = 'Usage: node apps/server/server.mjs generate-tls-certificate [--out-dir <directory>] [host ...]'

// DER fields used by the X.509 certificate and its extensions.
function der(tag, ...parts) {
  const value = Buffer.concat(parts)
  if (value.length < 128) {
    return Buffer.concat([Buffer.from([tag, value.length]), value])
  }
  const lengthBytes = []
  for (let length = value.length; length > 0; length = Math.floor(length / 256)) {
    lengthBytes.unshift(length % 256)
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | lengthBytes.length, ...lengthBytes]), value])
}

const sequence = (...parts) => der(0x30, ...parts)
const oid = hex => der(0x06, Buffer.from(hex, 'hex'))

function extension(id, value, critical = false) {
  const fields = [oid(id)]
  if (critical) fields.push(der(0x01, Buffer.from([0xff])))
  return sequence(...fields, der(0x04, value))
}

function certificateTime(date) {
  const timestamp = date.toISOString().slice(0, 19).replace(/[-:T]/g, '') + 'Z'
  if (date.getUTCFullYear() >= 2050) return der(0x18, Buffer.from(timestamp))
  return der(0x17, Buffer.from(timestamp.slice(2)))
}

function ipv6Bytes(host) {
  const address = new URL(`http://[${host}]`).hostname.slice(1, -1)
  const [left, right] = address.split('::')
  const groups = left ? left.split(':') : []
  if (right !== undefined) {
    const trailing = right ? right.split(':') : []
    groups.push(...Array(8 - groups.length - trailing.length).fill('0'), ...trailing)
  }
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2))
  return bytes
}

function subjectAltName(host) {
  const ipVersion = isIP(host)
  if (ipVersion === 4) return der(0x87, Buffer.from(host.split('.').map(Number)))
  if (ipVersion === 6 && !host.includes('%')) return der(0x87, ipv6Bytes(host))

  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
  if (host.length > 253 || !host.split('.').every(label => dnsLabel.test(label))
      || /^[\d.]+$/.test(host)) {
    throw new Error(`Invalid DNS name or IP address: ${host}`)
  }
  return der(0x82, Buffer.from(host.toLowerCase(), 'ascii'))
}

function generateCertificate(hosts) {
  const names = hosts.map(subjectAltName)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x3f) | 0x40
  const signatureAlgorithm = sequence(oid('2a864886f70d01010b'), der(0x05)) // sha256WithRSAEncryption
  const subject = sequence(der(0x31, sequence(
    oid('550403'), // commonName
    der(0x0c, Buffer.from('API Protocol Test Suite')),
  )))
  const now = Date.now()
  const validity = sequence(
    certificateTime(new Date(now - 5 * 60 * 1000)),
    certificateTime(new Date(now + 365 * 24 * 60 * 60 * 1000)),
  )
  const extensions = sequence(
    extension('551d13', sequence(), true), // basicConstraints (CA false)
    extension('551d0f', der(0x03, Buffer.from([5, 0xa0])), true), // digitalSignature, keyEncipherment
    extension('551d25', sequence(oid('2b06010505070301'))), // serverAuth
    extension('551d11', sequence(...names)), // subjectAltName
  )
  const certificateBody = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // X.509 v3
    der(0x02, serial),
    signatureAlgorithm,
    subject,
    validity,
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, extensions),
  )
  const signature = sign('sha256', certificateBody, privateKey)
  const certificate = sequence(certificateBody, signatureAlgorithm, der(0x03, Buffer.from([0]), signature))
  const pemLines = certificate.toString('base64').match(/.{1,64}/g)
  return {
    cert: ['-----BEGIN CERTIFICATE-----', ...pemLines, '-----END CERTIFICATE-----', ''].join('\n'),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}

async function writeCertificate(directory, hosts) {
  const existing = await lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing) throw new Error(`Output directory already exists: ${directory}`)

  const { cert, key } = generateCertificate(hosts)
  const parent = dirname(directory)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, '.tls-'))
  try {
    await writeFile(join(staging, 'key.pem'), key, { flag: 'wx', mode: 0o600 })
    await writeFile(join(staging, 'cert.pem'), cert, { flag: 'wx' })
    await rename(staging, directory)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function runGenerateTlsCertificate(args) {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        'out-dir': { type: 'string', default: 'data/tls' },
      },
      allowPositionals: true,
    })
    if (values.help) {
      console.log(usage)
      console.log('Default hosts: localhost, 127.0.0.1, ::1. Default output directory: data/tls.')
      return
    }
    if (!values['out-dir']) throw new Error('Provide a non-empty output directory.')
    const directory = resolve(values['out-dir'])
    const hosts = positionals.length ? positionals : defaultHosts
    await writeCertificate(directory, hosts)
    console.log(`Certificate: ${join(directory, 'cert.pem')}`)
    console.log(`Private key: ${join(directory, 'key.pem')}`)
  } catch (error) {
    console.error(error.message)
    console.error(usage)
    process.exitCode = 1
  }
}
