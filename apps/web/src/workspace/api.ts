import { fetchApp } from '../app-api'
import type { Workspace } from './types'

export async function readApiResult<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) {
    throw new Error(data?.error || `Workspace request failed (HTTP ${response.status}).`)
  }
  return data
}

export function readWorkspace(response: Response) {
  return readApiResult<Workspace>(response)
}

export async function importCollection(source: File | string, sectionId: string) {
  const contentType = typeof source === 'string' ? 'application/json'
    : source.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/wsdl+xml'
  return readWorkspace(await fetchApp('/api/collections/import', {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'Workspace-Section': encodeURIComponent(sectionId) },
    body: typeof source === 'string' ? JSON.stringify({ url: source }) : source,
  }))
}
