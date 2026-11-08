import QRCode from 'qrcode'
import { digits, period } from './totp.mjs'

const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function encodeBase32(bytes) {
  let result = ''
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += base32[(value >>> bits) & 31]
    }
  }
  if (bits) result += base32[(value << (5 - bits)) & 31]
  return result
}

export function totpProvisioningUri({ issuer, account, secret }) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account)
  const parameters = new URLSearchParams({
    secret: encodeBase32(secret), issuer, algorithm: 'SHA1', digits, period,
  })
  return `otpauth://totp/${label}?${parameters}`
}

export function totpQrCode(provisioning) {
  return QRCode.toDataURL(totpProvisioningUri(provisioning))
}
