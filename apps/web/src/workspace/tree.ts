import type { Auth, CollectionItem } from './types'

type AuthorizationSource = { id: string, name: string, auth: Auth }
export type ScriptSource = { id: string, name: string, preRequest?: string, postResponse?: string }
type Match = { item: CollectionItem, authorizationSource?: AuthorizationSource, parentScripts?: ScriptSource[] }

export function findItem(items: CollectionItem[], id: string, authorizationSource?: AuthorizationSource, parentScripts: ScriptSource[] = []): Match | undefined {
  for (const item of items) {
    if (item.id === id) return { item, authorizationSource, ...(parentScripts.length ? { parentScripts } : {}) }
    if (item.type === 'folder') {
      const match = findItem(item.items, id, item.auth.type === 'inherit' ? authorizationSource : item,
        item.preRequest || item.postResponse ? [...parentScripts, item] : parentScripts)
      if (match) return match
    }
  }
}

export function updateItems(items: CollectionItem[], id: string, replacement?: CollectionItem): CollectionItem[] {
  return items.flatMap(item => {
    if (item.id === id) return replacement ? [replacement] : []
    if (item.type === 'folder') return [{ ...item, items: updateItems(item.items, id, replacement) }]
    return [item]
  })
}
