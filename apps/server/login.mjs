import { randomBytes } from 'node:crypto'
import { accountId, maxPasswordLength, readAccounts, updateAccounts, usernamePattern, verifyPassword } from './accounts.mjs'
import { renderLoginPage } from './login-page.mjs'
import { keyDirectory, openTotpSecret, sealTotpSecret } from './storage-crypto.mjs'
import { generateTotpSecret, matchingTotpStep } from './totp.mjs'
import { totpQrCode } from './totp-qr.mjs'
import { userDataRoot } from './user-data.mjs'

const sessionLifetime = 8 * 60 * 60
const loginWindow = 5 * 60
const maxAttempts = 10
const maxBody = 16 * 1024
const cookieName = 'api_test_suite_session'
const challengeCookieName = 'api_test_suite_totp'
const maxTotpAttempts = 5
const sessions = new Map()
const attempts = new Map()
const challenges = new Map()
const totpAttempts = new Map()
const verifications = new Map()
let pendingChecks = 0

const totpSetting = process.env.TOTP_ENABLED
if (totpSetting !== undefined && totpSetting !== 'true' && totpSetting !== 'false') {
  throw new Error('TOTP_ENABLED must be true or false.')
}
export const totpEnabled = totpSetting === 'true'

const now = () => Date.now() / 1000

setInterval(() => {
  const time = now()
  for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id)
  for (const [ip, attempt] of attempts) if (attempt.expires <= time) attempts.delete(ip)
  for (const [id, challenge] of challenges) if (challenge.expires <= time) challenges.delete(id)
  for (const [id, attempt] of totpAttempts) if (attempt.expires <= time) totpAttempts.delete(id)
}, 60_000).unref()

function cookie(request, id, maxAge, name = cookieName) {
  const secure = request.socket.encrypted ? '; Secure' : ''
  return `${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

function sessionId(request, name = cookieName) {
  return request.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function redirect(response, location) {
  response.writeHead(303, { Location: location }).end()
}

function jsonError(request, response, send, status, error) {
  send(request, response, status, 'application/json; charset=utf-8', JSON.stringify({ error }))
}

function loginPage(request, response, send, status = 200, message = '', challenge) {
  const url = new URL(request.url, 'http://workspace.local')
  const selected = url.searchParams.get('language')
  const stored = sessionId(request, 'ui_language')
  const language = ['de', 'en'].includes(selected) ? selected : ['de', 'en'].includes(stored) ? stored
    : /^de(?:[-,;]|$)/i.test(request.headers['accept-language'] ?? '') ? 'de' : 'en'
  if (['de', 'en'].includes(selected)) response.setHeader('Set-Cookie', `ui_language=${language}; Path=/; SameSite=Strict; Max-Age=31536000`)
  const images = challenge?.qrCode ? '; img-src data:' : ''
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" + images)
  response.setHeader('Referrer-Policy', 'same-origin')
  send(request, response, status, 'text/html; charset=utf-8',
    renderLoginPage(message, challenge && { qrCode: challenge.qrCode }, language, loginDestination(url.searchParams.get('next')) === '/' ? '' : loginDestination(url.searchParams.get('next'))))
}

function loginDestination(value) {
  if (!value || !/^\/(?![/\\])/.test(value)) return '/'
  const target = new URL(value, 'http://workspace.local')
  if (target.origin !== 'http://workspace.local') return '/'
  if (!/^\/(?:collections\/|environments\/|$)/.test(target.pathname)) return '/'
  return target.pathname + target.search + target.hash
}

function sameOrigin(request) {
  const { host, origin, 'sec-fetch-site': site } = request.headers
  if (site && site !== 'none' && site !== 'same-origin') return false
  const scheme = request.socket.encrypted ? 'https' : 'http'
  return !origin || origin === `${scheme}://${host}`
}

async function readForm(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBody) return null
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function accountSnapshot(account) {
  return { username: account.username, accountId: accountId(account), hash: account.hash,
    sessionRevision: account.sessionRevision }
}

function matchesAccount(account, snapshot) {
  return account.username === snapshot.username && accountId(account) === snapshot.accountId &&
    account.hash === snapshot.hash && account.sessionRevision === snapshot.sessionRevision
}

function finishLogin(request, response, account, destination, clearChallenge = false) {
  sessions.delete(sessionId(request))
  if (sessions.size >= 4096) sessions.delete(sessions.keys().next().value)
  const id = randomBytes(32).toString('hex')
  sessions.set(id, { ...accountSnapshot(account), expires: now() + sessionLifetime })
  const sessionCookie = cookie(request, id, sessionLifetime)
  response.setHeader('Set-Cookie', clearChallenge
    ? [sessionCookie, cookie(request, '', 0, challengeCookieName)] : sessionCookie)
  redirect(response, destination)
}

async function beginTotp(request, response, account, destination) {
  const secret = account.totp ? undefined : generateTotpSecret()
  const qrCode = secret && await totpQrCode({ issuer: 'API Protocol Test Suite', account: account.username, secret })
  const id = randomBytes(32).toString('hex')
  sessions.delete(sessionId(request))
  challenges.delete(sessionId(request, challengeCookieName))
  if (challenges.size >= 4096) challenges.delete(challenges.keys().next().value)
  challenges.set(id, { ...accountSnapshot(account), secret, qrCode, destination, expires: now() + loginWindow })
  response.setHeader('Set-Cookie', [
    cookie(request, id, loginWindow, challengeCookieName), cookie(request, '', 0),
  ])
  redirect(response, '/login/totp')
}

async function login(request, response, send) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    loginPage(request, response, send, 415, 'Use the sign-in form.')
    return
  }
  const form = await readForm(request)
  if (!form) {
    response.setHeader('Connection', 'close')
    loginPage(request, response, send, 413, 'The sign-in form is too large.')
    return
  }
  const username = form.get('username') ?? ''
  const password = form.get('password') ?? ''
  if (!usernamePattern.test(username) || !password || password.length > maxPasswordLength) {
    loginPage(request, response, send, 401, 'Invalid username or password.')
    return
  }

  const ip = request.socket.remoteAddress
  const time = now()
  let attempt = attempts.get(ip)
  if (attempt?.expires <= time) {
    attempts.delete(ip)
    attempt = undefined
  }
  if (pendingChecks >= 2 || attempt?.count >= maxAttempts || (!attempt && attempts.size >= 4096)) {
    response.setHeader('Retry-After', attempt?.count >= maxAttempts ? Math.ceil(attempt.expires - time) : 2)
    loginPage(request, response, send, 429, 'Too many sign-in attempts. Try again later.')
    return
  }
  attempt ??= { count: 0, expires: time + loginWindow }
  attempt.count++
  attempts.set(ip, attempt)
  pendingChecks++
  let account
  try {
    account = (await readAccounts()).find(entry => entry.username === username)
    if (!await verifyPassword(account, password)) {
      loginPage(request, response, send, 401, 'Invalid username or password.')
      return
    }
  } finally {
    pendingChecks--
  }

  attempts.delete(ip)
  const next = new URL(request.url, 'http://workspace.local').searchParams.get('next')
  const destination = loginDestination(next)
  if (totpEnabled) await beginTotp(request, response, account, destination)
  else finishLogin(request, response, account, destination)
}

function currentChallenge(id) {
  const challenge = challenges.get(id)
  if (challenge?.expires > now()) return challenge
  challenges.delete(id)
}

function matchesChallenge(account, challenge) {
  return matchesAccount(account, challenge) && Boolean(account.totp) === !challenge.secret
}

function restartLogin(request, response, id, destination) {
  challenges.delete(id)
  response.setHeader('Set-Cookie', cookie(request, '', 0, challengeCookieName))
  redirect(response, destination ? `/login?${new URLSearchParams({ next: destination })}` : '/login')
}

async function serializeVerification(account, verify) {
  const previous = verifications.get(account)
  let release
  const current = new Promise(resolve => { release = resolve })
  verifications.set(account, current)
  try {
    await previous
    await verify()
  } finally {
    release()
    if (verifications.get(account) === current) verifications.delete(account)
  }
}

async function verifyTotp(request, response, send, id, challenge, code) {
  if (currentChallenge(id) !== challenge) return restartLogin(request, response, id, challenge.destination)
  const time = now()
  const attempt = totpAttempts.get(challenge.accountId)
  const active = attempt?.expires > time && attempt.revision === challenge.sessionRevision ? attempt : undefined
  let account
  let outcome = 'stale'
  await updateAccounts(async accounts => {
    account = accounts.find(entry => matchesChallenge(entry, challenge))
    if (!account || currentChallenge(id) !== challenge) return
    if (active?.count >= maxTotpAttempts || (!active && !attempt && totpAttempts.size >= 4096)) {
      outcome = 'limited'
      return
    }
    const directory = await keyDirectory(userDataRoot())
    const secret = challenge.secret ?? await openTotpSecret(directory, challenge.accountId, account.totp)
    const lastStep = matchingTotpStep(secret, code, account.totp?.lastStep)
    if (lastStep === undefined) {
      outcome = 'invalid'
      return
    }
    const envelope = account.totp ?? await sealTotpSecret(directory, challenge.accountId, secret)
    if (currentChallenge(id) !== challenge) return
    account.totp = { ...envelope, lastStep }
    outcome = 'accepted'
    return accounts
  })
  if (outcome === 'stale' || currentChallenge(id) !== challenge) {
    return restartLogin(request, response, id, challenge.destination)
  }
  if (outcome === 'limited') {
    const retry = active ? Math.max(1, Math.ceil(active.expires - now())) : 60
    response.setHeader('Retry-After', retry)
    return loginPage(request, response, send, 429, 'Too many code attempts. Try again later.', challenge)
  }
  if (outcome === 'invalid') {
    totpAttempts.set(challenge.accountId, { count: (active?.count ?? 0) + 1,
      expires: active?.expires ?? time + loginWindow, revision: challenge.sessionRevision })
    return loginPage(request, response, send, 401, 'Invalid or expired code.', challenge)
  }
  challenges.delete(id)
  totpAttempts.delete(challenge.accountId)
  finishLogin(request, response, account, challenge.destination, true)
}

async function totp(request, response, send, readOnly) {
  const id = sessionId(request, challengeCookieName)
  const challenge = currentChallenge(id)
  if (!challenge) return restartLogin(request, response, id)
  if (readOnly) {
    const accounts = await readAccounts()
    if (!accounts.some(account => matchesChallenge(account, challenge)) || currentChallenge(id) !== challenge) {
      return restartLogin(request, response, id, challenge.destination)
    }
    return loginPage(request, response, send, 200, '', challenge)
  }
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    return jsonError(request, response, send, 415, 'Use the code form.')
  }
  const form = await readForm(request)
  if (!form) {
    response.setHeader('Connection', 'close')
    return jsonError(request, response, send, 413, 'The code form is too large.')
  }
  await serializeVerification(challenge.accountId, () => verifyTotp(request, response, send, id, challenge, form.get('code')))
}

async function signedInAccount(request) {
  const id = sessionId(request)
  const session = sessions.get(id)
  if (!session) return
  if (session.expires > now()) {
    const accounts = await readAccounts()
    const account = accounts.find(account => matchesAccount(account, session))
    if (account) return { username: session.username, id: session.accountId }
  }
  sessions.delete(id)
}

export async function authorizeRequest(request, response, send, path) {
  response.setHeader('Cache-Control', 'no-store')
  const readOnly = request.method === 'GET' || request.method === 'HEAD'
  try {
    if (!readOnly && !sameOrigin(request)) {
      jsonError(request, response, send, 403, 'The request origin is not allowed.')
    } else if (path === '/login' && readOnly) {
      loginPage(request, response, send)
    } else if (path === '/login' && request.method === 'POST') {
      await login(request, response, send)
    } else if (totpEnabled && path === '/login/totp' && (readOnly || request.method === 'POST')) {
      await totp(request, response, send, readOnly)
    } else if (path === '/logout' && request.method === 'POST') {
      sessions.delete(sessionId(request))
      challenges.delete(sessionId(request, challengeCookieName))
      response.setHeader('Set-Cookie', totpEnabled
        ? [cookie(request, '', 0), cookie(request, '', 0, challengeCookieName)] : cookie(request, '', 0))
      redirect(response, '/login')
    } else {
      const account = await signedInAccount(request)
      if (account) return account
      if (readOnly && path !== '/api' && !path.startsWith('/api/')) {
        redirect(response, `/login?${new URLSearchParams({ next: loginDestination(request.url) })}`)
      } else {
        jsonError(request, response, send, 401, 'Sign in to continue. Reload the page to open the sign-in form.')
      }
    }
  } catch {
    jsonError(request, response, send, 503, 'The account service is unavailable.')
  }
}
