const leases = new Map()
const leaseDuration = 75_000

export function ownsAppTab(accountId, tabId) {
  const active = leases.get(accountId)
  return active?.tabId === tabId && active.expires > Date.now()
}

export function handleAppTab(request, response, send, accountId) {
  const json = (status, body) => send(request, response, status, 'application/json; charset=utf-8', JSON.stringify(body))
  if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(request.method)) {
    response.setHeader('Allow', 'PUT, PATCH, POST, DELETE')
    return json(405, { error: 'Method not allowed.' })
  }
  const tabId = request.headers['app-tab-id']
  if (typeof tabId !== 'string' || !/^[a-f0-9]{32}$/.test(tabId)) {
    return json(400, { error: 'Invalid app tab ID.' })
  }
  const now = Date.now()
  for (const [id, lease] of leases) {
    if (lease.expires <= now) leases.delete(id)
  }
  const active = leases.get(accountId)
  if (request.method === 'DELETE') {
    if (active?.tabId === tabId) leases.delete(accountId)
    return send(request, response, 204, 'application/json; charset=utf-8')
  }
  if ((request.method === 'PUT' && active && active.tabId !== tabId) ||
      (request.method === 'PATCH' && active?.tabId !== tabId)) {
    return json(409, { error: 'This tab does not have app access. Select Open anyway to continue here.' })
  }
  leases.set(accountId, { tabId, expires: now + leaseDuration })
  response.setHeader('App-Account-Id', accountId)
  return send(request, response, 204, 'application/json; charset=utf-8')
}
