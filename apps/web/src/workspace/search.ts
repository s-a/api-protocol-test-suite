import type { CollectionItem, Selection, Workspace, WorkspaceSection } from './types'

export type SearchResult = {
  name: string
  path: string
  selection?: Selection
  section?: WorkspaceSection
  score: number
}

function normalize(value: string) {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
}

function near(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return false
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]))
    }
    if (Math.min(...current) > limit) return false
    previous = current
  }
  return previous[b.length] <= limit
}

function match(text: string, term: string) {
  if (text.includes(term)) return true
  if (term.length < 4 || term.length > 48) return false
  const limit = term.length >= 8 ? 2 : 1
  return (text.match(/[\p{L}\p{N}_-]+/gu) ?? []).some(word => word.length <= 50 && near(word, term, limit))
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => key === 'id' || key === 'items' ? [] : strings(child))
}

export function searchWorkspace(workspace: Workspace, query: string): SearchResult[] {
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const results: SearchResult[] = []
  function add(name: string, path: string[], content: unknown, target: Pick<SearchResult, 'selection' | 'section'>) {
    const title = normalize(name)
    const text = normalize([name, ...path, ...strings(content)].join(' '))
    if (!terms.every(term => match(text, term))) return
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 2 : 0), 0)
    results.push({ name, path: path.join(' / '), ...target, score })
  }
  function visit(items: CollectionItem[], collectionId: string, path: string[]) {
    for (const item of items) {
      add(item.name, path, item, { selection: { kind: 'item', collectionId, itemId: item.id } })
      if (item.type === 'folder') visit(item.items, collectionId, [...path, item.name])
    }
  }
  for (const section of workspace.sections ?? []) add(section.name, [], section.name, { section })
  for (const collection of workspace.collections) {
    const section = workspace.sections?.find(candidate => candidate.collectionIds.includes(collection.id))
    const path = section ? [section.name] : []
    add(collection.name, path, collection, { selection: { kind: 'collection', collectionId: collection.id } })
    visit(collection.items, collection.id, [...path, collection.name])
  }
  for (const environment of workspace.environments) {
    const section = workspace.sections?.find(candidate => candidate.environmentId === environment.id)
    add(environment.name, section ? [section.name] : [], environment,
      { selection: { kind: 'environment', environmentId: environment.id } })
  }
  return results.sort((a, b) => b.score - a.score)
}
