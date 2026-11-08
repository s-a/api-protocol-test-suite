import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const period = 30
export const digits = 6

export function generateTotpSecret() {
  return randomBytes(20)
}

function codeAtStep(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', secret).update(counter).digest()
  const offset = digest.at(-1) & 15
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return Buffer.from(String(value).padStart(digits, '0'))
}

export function matchingTotpStep(secret, code, lastStep = -1, timeMs = Date.now()) {
  if (typeof code !== 'string' || code.length !== digits || /[^0-9]/.test(code)) return
  const expected = Buffer.from(code)
  const current = Math.floor(timeMs / (period * 1000))
  let matched
  for (let step = Math.max(0, current - 1); step <= current + 1; step++) {
    if (!timingSafeEqual(expected, codeAtStep(secret, step))) continue
    if (step <= lastStep) return
    matched = step
  }
  return matched
}
