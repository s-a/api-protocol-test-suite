import { findItem } from './tree.ts'
import type { Selection, Workspace } from './types.ts'

function segment(id: string) {
  // A prefix keeps IDs such as "." and ".." from becoming path navigation.
  return '~' + encodeURIComponent(id)
}

function readId(value: string) {
  try {
    return decodeURIComponent(value.slice(1))
  } catch {
    return null
  }
}

export function selectionPath(selection: Selection | null): string {
  if (!selection) return '/'
  if (selection.kind === 'environment') return '/environments/' + segment(selection.environmentId)
  const collectionPath = '/collections/' + segment(selection.collectionId)
  return selection.kind === 'item' ? collectionPath + '/items/' + segment(selection.itemId) : collectionPath
}

export function selectionFromPath(workspace: Workspace, pathname: string): Selection | null {
  const environmentRoute = /^\/environments\/(~[^/]+)\/?$/.exec(pathname)
  if (environmentRoute) {
    const environmentId = readId(environmentRoute[1])
    if (environmentId && workspace.environments.some(environment => environment.id === environmentId)) {
      return { kind: 'environment', environmentId }
    }
  }

  const collectionRoute = /^\/collections\/(~[^/]+)(?:\/items\/(~[^/]+))?\/?$/.exec(pathname)
  if (collectionRoute) {
    const collectionId = readId(collectionRoute[1])
    const collection = workspace.collections.find(candidate => candidate.id === collectionId)
    if (collection) {
      const itemId = collectionRoute[2] ? readId(collectionRoute[2]) : null
      if (itemId && findItem(collection.items, itemId)) return { kind: 'item', collectionId: collection.id, itemId }
      return { kind: 'collection', collectionId: collection.id }
    }
  }

  if (workspace.collections.length) return { kind: 'collection', collectionId: workspace.collections[0].id }
  if (workspace.environments.length) return { kind: 'environment', environmentId: workspace.environments[0].id }
  return null
}

export function selectedEntry(workspace: Workspace | null, selection: Selection | null) {
  const collection = selection && selection.kind !== 'environment'
    ? workspace?.collections.find(candidate => candidate.id === selection.collectionId)
    : undefined
  const match = collection && selection?.kind === 'item'
    ? findItem(collection.items, selection.itemId, collection.auth.type === 'inherit' ? undefined : collection,
      collection.preRequest || collection.postResponse ? [collection] : [])
    : undefined
  const source = match?.authorizationSource
  const authorizationSource = source && collection ? {
    ...source,
    href: selectionPath(source.id === collection.id
      ? { kind: 'collection', collectionId: collection.id }
      : { kind: 'item', collectionId: collection.id, itemId: source.id }),
  } : undefined
  const entry = selection?.kind === 'environment'
    ? workspace?.environments.find(environment => environment.id === selection.environmentId)
    : selection?.kind === 'item' ? match?.item : collection
  return { collection, entry, authorizationSource, parentScripts: match?.parentScripts }
}
