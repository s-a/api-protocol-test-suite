import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { handleAppTab, ownsAppTab } from './app-tab.mjs'
import { handleCollectionExchange } from './collection-exchange.mjs'
import { authorizeRequest } from './login.mjs'
import { handleProfiles } from './profiles.mjs'
import { handleJwtKeys, handleSendRequest } from './send-request.mjs'
import { handleWorkspace } from './workspace.mjs'
import { handleWorkspaceSharing } from './workspace-sharing.mjs'
import { accountDirectoryName, userDataRoot } from './user-data.mjs'
import { activeKeyId, keyDirectory, loadKey, workspaceEncryptionEnabled } from './storage-crypto.mjs'
import { migratePlaintextStorage } from './storage-cli.mjs'

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || '3000')
const certFile = process.env.TLS_CERT_FILE
const keyFile = process.env.TLS_KEY_FILE
const httpsSetting = process.env.HTTPS_ENABLED
if (httpsSetting !== undefined && httpsSetting !== 'true' && httpsSetting !== 'false') {
  throw new Error('HTTPS_ENABLED must be true or false.')
}
const httpsEnabled = httpsSetting === undefined ? Boolean(certFile || keyFile) : httpsSetting === 'true'
if (httpsEnabled && (!certFile || !keyFile)) {
  throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE to enable HTTPS.')
}

const webRoot = new URL('../web/dist/', import.meta.url)
const favicon = await readFile(new URL('./favicon.png', import.meta.url))
const assetTypes = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  ttf: 'font/ttf',
}

function send(request, response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

async function handleRequest(request, response) {
  const textType = 'text/plain; charset=utf-8'
  const path = request.url.split('?')[0]
  if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/favicon.png' || path === '/favicon.ico')) {
    send(request, response, 200, 'image/png', favicon)
    return
  }
  const account = await authorizeRequest(request, response, send, path)
  if (!account) return
  if (path === '/api/app-tab') {
    handleAppTab(request, response, send, account.id)
    return
  }
  const tabId = request.headers['app-tab-id']
  if (path.startsWith('/api/') && tabId !== undefined && !ownsAppTab(account.id, tabId)) {
    send(request, response, 409, 'application/json; charset=utf-8',
      JSON.stringify({ error: 'This tab does not have app access. Select Open anyway to continue here.' }))
    return
  }
  const dataKey = accountDirectoryName(account.username, account.id)
  if (path === '/api/requests/send') {
    await handleSendRequest(request, response, send, host, dataKey)
    return
  }
  if (path === '/api/jwt-keys' || path === '/api/jwt-keys/reveal') {
    await handleJwtKeys(request, response, send, host, path.endsWith('/reveal'), dataKey)
    return
  }
  if (path === '/api/workspace') {
    await handleWorkspace(request, response, send, dataKey)
    return
  }

  if (path === '/api/profiles') {
    await handleProfiles(request, response, send, dataKey)
    return
  }

  if (await handleWorkspaceSharing(request, response, send, path, account)) return
  if (await handleCollectionExchange(request, response, path, dataKey)) return

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    send(request, response, 405, textType, 'Method not allowed')
    return
  }

  if (path === '/api/health') {
    send(request, response, 200, 'application/json; charset=utf-8', '{"status":"ok"}')
    return
  }

  const asset = /^\/assets\/[\w-]+(?:\.[\w-]+)*\.(js|css|ttf)$/.exec(path)
  const workspaceRoute = /^\/(?:collections\/~[^/]+(?:\/items\/~[^/]+)?|environments\/~[^/]+)\/?$/.test(path)
  if (path !== '/' && !workspaceRoute && !asset) {
    send(request, response, 404, textType, 'Not found')
    return
  }

  const file = asset ? path.slice(1) : 'index.html'
  const contentType = asset ? assetTypes[asset[1]] : 'text/html; charset=utf-8'
  try {
    const content = await readFile(new URL(file, webRoot))
    send(request, response, 200, contentType, content)
  } catch (error) {
    if (error.code === 'ENOENT') {
      const message = asset ? 'Not found' : 'Frontend build missing. Run npm run build.'
      send(request, response, asset ? 404 : 503, textType, message)
    } else {
      console.error(error)
      send(request, response, 500, textType, 'Internal server error')
    }
  }
}

let server
if (workspaceEncryptionEnabled()) {
  const keys = await keyDirectory(userDataRoot())
  const id = await activeKeyId(keys)
  await Promise.all([loadKey(keys, id, 'public'), loadKey(keys, id, 'private')])
  await migratePlaintextStorage()
}
if (httpsEnabled) {
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)])
  server = createHttpsServer({ cert, key }, handleRequest)
} else {
  server = createHttpServer(handleRequest)
}

server.listen(port, host, () => {
  const address = server.address()
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
  const protocol = httpsEnabled ? 'https' : 'http'
  console.log(`API Protocol Test Suite listening on ${protocol}://${displayHost}:${address.port}`)
})
