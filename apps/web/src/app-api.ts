import { newId } from './workspace/id'

export const appTabId = newId()

export function fetchApp(input: string, options?: RequestInit) {
  const headers = new Headers(options?.headers)
  headers.set('App-Tab-Id', appTabId)
  return fetch(input, { ...options, headers })
}
