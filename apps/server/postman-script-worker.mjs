import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { loadSandbox, sdk } from './postman-runtime.mjs'

const scope = values => Object.entries(values).map(([key, value]) => ({ key, value }))
const values = list => Object.fromEntries((list?.values ?? []).filter(entry => !entry.disabled)
  .map(({ key, value }) => [key, String(value)]))

async function execute({ scripts, request, variables, response, scopes }) {
  const sandbox = loadSandbox()
  const context = await new Promise((resolve, reject) => sandbox.createContext((error, result) => error ? reject(error) : resolve(result)))
  context.on('error', () => {})
  let current = {
    request: { method: request.method, url: request.url ?? '', header: request.headers.map(([key, value]) => ({ key, value })),
      ...(request.body === undefined ? {} : { body: { mode: 'raw', raw: request.body } }) },
    ...Object.fromEntries(Object.entries({ environment: variables, ...scopes }).map(([name, entries]) => [name, scope(entries)])),
  }
  let skipped = false
  const assertions = []
  try {
    for (const script of scripts) {
      const id = randomUUID()
      const bridge = (token, error, response) => context.dispatch(`execution.response.${id}`, token, error, response)
      const receive = message => {
        if (message.executionId === id) bridge(message.token, message.error, message.response)
      }
      const requestEvent = `execution.request.${id}`
      context.on(requestEvent, (_cursor, _id, token, payload) => {
        parentPort.postMessage({ type: 'request', executionId: id, token, request: payload })
      })
      context.once(`execution.skipRequest.${id}`, () => { skipped = true })
      const assertionEvent = `execution.assertion.${id}`
      context.on(assertionEvent, (_cursor, results) => {
        for (const { name, passed, skipped } of results) assertions.push({ name, passed, skipped })
      })
      parentPort.on('message', receive)
      try {
        current = await new Promise((resolve, reject) => context.execute({ listen: response ? 'test' : 'prerequest', script: { exec: script } },
          { id, timeout: 3000, context: { ...current, response }, disabledAPIs: ['pm.vault', 'pm.cookies', 'pm.execution.runRequest'] },
          (error, result) => error ? reject(error) : resolve(result)))
      } finally {
        parentPort.off('message', receive)
        context.removeAllListeners(requestEvent)
        context.removeAllListeners(`execution.skipRequest.${id}`)
        context.removeAllListeners(assertionEvent)
      }
      if (skipped) break
    }
    const updated = new sdk.Request(current.request)
    if (updated.body && updated.body.mode !== 'raw') throw new Error('Only raw request bodies are supported.')
    const resultScopes = {
      globals: values(current.globals), collectionVariables: values(current.collectionVariables),
      environment: values(current.environment), _variables: values(current._variables),
    }
    return { method: updated.method, url: updated.url.toString(), body: updated.body?.raw,
      headers: updated.headers.all().filter(header => !header.disabled).map(header => [header.key, header.value]),
      scopes: resultScopes,
      variables: { ...resultScopes.globals, ...resultScopes.collectionVariables, ...resultScopes.environment, ...resultScopes._variables },
      skipped, assertions }
  } finally {
    context.dispose()
  }
}

try {
  parentPort.postMessage({ type: 'result', result: await execute(workerData) })
} catch (error) {
  parentPort.postMessage({ type: 'error', timeout: /timed?\s*out|timeout|not responding/i.test(error.message) })
}
