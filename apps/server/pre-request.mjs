import { Worker } from 'node:worker_threads'
import { TargetPolicyError } from './targets.mjs'

export class PreRequestError extends Error {}

export async function runPreRequest(scripts, request, variables, sendRequest, response, scopes) {
  if (!Array.isArray(scripts) || scripts.length > 102 || scripts.some(script => typeof script !== 'string' || script.length > 65536)) {
    throw new PreRequestError('Invalid pre-request scripts.')
  }
  if (!scripts.length) return { ...request, variables: { ...scopes?.collectionVariables, ...variables }, scopes }
  const worker = new Worker(new URL('./postman-script-worker.mjs', import.meta.url), {
    workerData: { scripts, request, variables, response, scopes }, env: {}, execArgv: [],
  })
  const timeout = 'Pre-request script timed out.'
  const failed = 'Pre-request script failed. Check the JavaScript and supported pm functions.'
  const controller = new AbortController()
  let timer
  let requests = 0
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new PreRequestError(timeout)), 5000)
      worker.on('error', () => reject(new PreRequestError(failed)))
      worker.on('exit', () => reject(new PreRequestError(failed)))
      worker.on('message', async message => {
        if (message.type === 'result') resolve(message.result)
        if (message.type === 'error') reject(new PreRequestError(message.timeout ? timeout : failed))
        if (message.type === 'request') {
          const { executionId, token } = message
          try {
            if (!sendRequest || ++requests > 20) throw new Error('Script HTTP requests are unavailable.')
            const response = await sendRequest(message.request, controller.signal)
            if (!controller.signal.aborted) worker.postMessage({ executionId, token, response })
          } catch (error) {
            if (error instanceof TargetPolicyError) reject(error)
            else if (!controller.signal.aborted) worker.postMessage({ executionId, token, error: { message: 'Script HTTP request failed.' } })
          }
        }
      })
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
    await worker.terminate()
  }
}
