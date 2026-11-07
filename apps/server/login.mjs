import { randomBytes } from 'node:crypto'
import { accountId, maxPasswordLength, readAccounts, usernamePattern, verifyPassword } from './accounts.mjs'
import { renderLoginPage } from './login-page.mjs'

const sessionLifetime = 8 * 60 * 60
const loginWindow = 5 * 60
const maxAttempts = 10
const maxBody = 16 * 1024
const cookieName = 'api_test_suite_session'
const sessions = new Map()
const attempts = new Map()
let pendingChecks = 0

const now = () => Date.now() / 1000

setInterval(() => {
  const time = now()
  for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id)
  for (const [ip, attempt] of attempts) if (attempt.expires <= time) attempts.delete(ip)
}, 60_000).unref()

function cookie(request, id, maxAge) {
  const secure = request.socket.encrypted ? '; Secure' : ''
  return `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

function sessionId(request) {
  return request.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
}

function redirect(response, location) {
  response.writeHead(303, { Location: location }).end()
}

function jsonError(request, response, send, status, error) {
  send(request, response, status, 'application/json; charset=utf-8', JSON.stringify({ error }))
}

function loginPage(request, response, send, status = 200, message = '') {
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
  send(request, response, status, 'text/html; charset=utf-8', renderLoginPage(message))
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
  sessions.delete(sessionId(request))
  if (sessions.size >= 4096) sessions.delete(sessions.keys().next().value)
  const id = randomBytes(32).toString('hex')
  sessions.set(id, { username, accountId: accountId(account), hash: account.hash, expires: now() + sessionLifetime })
  response.setHeader('Set-Cookie', cookie(request, id, sessionLifetime))
  const next = new URL(request.url, 'http://workspace.local').searchParams.get('next')
  redirect(response, loginDestination(next))
}

async function signedInAccount(request) {
  const id = sessionId(request)
  const session = sessions.get(id)
  if (!session) return
  if (session.expires > now()) {
    const accounts = await readAccounts()
    const account = accounts.find(account => account.username === session.username &&
      account.hash === session.hash && accountId(account) === session.accountId)
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
    } else if (path === '/logout' && request.method === 'POST') {
      sessions.delete(sessionId(request))
      response.setHeader('Set-Cookie', cookie(request, '', 0))
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
