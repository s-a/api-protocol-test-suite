import { fetchApp } from './app-api'
import { VscodeButton } from '@vscode-elements/react-elements'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { importCollection, readWorkspace } from './workspace/api'
import { Editor } from './workspace/Editor'
import type { Entry } from './workspace/Editor'
import { Explorer } from './workspace/Explorer'
import { ImportDialog } from './workspace/ImportDialog'
import { newId } from './workspace/id'
import { selectedEntry, selectionFromPath, selectionPath } from './workspace/routes'
import { completeWorkspace, sectionWorkspace } from './workspace/sections'
import { SharingDialog } from './workspace/SharingDialog'
import { updateItems } from './workspace/tree'
import { WorkspaceLink } from './workspace/WorkspaceLink'
import type { Collection, CollectionItem, Selection, Workspace, WorkspaceSection } from './workspace/types'

function subscribeToPath(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  window.addEventListener('hashchange', onChange)
  window.addEventListener('workspace:navigate', onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener('hashchange', onChange)
    window.removeEventListener('workspace:navigate', onChange)
  }
}

function readPath() {
  return window.location.pathname + window.location.hash
}

function navigate(path: string, mode: 'pushState' | 'replaceState') {
  if (path === readPath()) return
  const [pathname, hash] = path.split('#', 2)
  window.history[mode](null, '', pathname + window.location.search + (hash ? `#${hash}` : ''))
  window.dispatchEvent(new Event('workspace:navigate'))
}

export function App({ accountId }: { accountId: string }) {
  const [saved, setSaved] = useState<Workspace | null>(null)
  const [draft, setDraft] = useState<Workspace | null>(null)
  const route = useSyncExternalStore(subscribeToPath, readPath)
  const [pathname, tab] = route.split('#', 2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [sharingOpen, setSharingOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const workspace = draft ?? saved
  const dirty = draft !== null
  const linkedEntry = workspace && pathname !== '/' && selectionFromPath(workspace, pathname)
  const section = workspace?.sections?.find(candidate => linkedEntry && (
    linkedEntry.kind === 'environment' ? linkedEntry.environmentId === candidate.environmentId
      : candidate.collectionIds.includes(linkedEntry.collectionId)
  )) ?? workspace?.sections?.[0]
  const view = workspace && section ? sectionWorkspace(workspace, section) : workspace
  const selection = view && selectionFromPath(view, pathname)
  const currentPath = workspace ? selectionPath(selection) + (tab === 'scripts' ? '#scripts' : '') : route

  useEffect(() => {
    if (readPath() === route) navigate(currentPath, 'replaceState')
  }, [currentPath, route])

  function setSelection(next: Selection) {
    navigate(selectionPath(next), 'pushState')
  }

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const result = await readWorkspace(await fetchApp('/api/workspace', { signal: controller.signal }))
        if (controller.signal.aborted) return
        setSaved(completeWorkspace(result))
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load workspace.')
      }
    }
    void load()
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    if (!dirty) return
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const { collection, entry, authorizationSource, parentScripts } = selectedEntry(workspace, selection)
  const savedCollections = view?.collections.flatMap(({ id }) => {
    const stored = saved?.collections.find(candidate => candidate.id === id)
    return stored ? [stored] : []
  }) ?? []
  const selectedForExport = savedCollections.find(({ id }) => id === collection?.id)
  const exportCollections = selectedForExport ? [selectedForExport] : savedCollections
  const activeEnvironment = view?.environments[0]

  async function persist(action: () => Promise<Workspace>, success: string, after?: (result: Workspace) => void) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      setSaved(completeWorkspace(result))
      setDraft(null)
      setNotice(success)
      after?.(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save changes.')
    } finally {
      setBusy(false)
    }
  }

  function save() {
    if (!draft) return
    const data = { ...draft, collections: draft.collections.map(({ exchange, ...item }) => {
      void exchange
      return item
    }) }
    void persist(async () => readWorkspace(await fetchApp('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })), 'Workspace saved.')
  }

  function discard() {
    if (!saved || !window.confirm('Discard unsaved changes?')) return
    setDraft(null)
    setError('')
    setNotice('')
  }

  function retry() {
    setError('')
    setSaved(null)
    setNotice('')
    setReload(value => value + 1)
  }

  function change(next: Workspace) {
    setDraft(next)
    setNotice('')
  }

  function updateCollection(updated: Collection) {
    if (!workspace) return
    change({ ...workspace, collections: workspace.collections.map(candidate => candidate.id === updated.id ? updated : candidate) })
  }

  function edit(updated: Entry) {
    if (!workspace) return
    if ('variables' in updated) {
      change({ ...workspace, environments: workspace.environments.map(environment => environment.id === updated.id ? updated : environment) })
    } else if (!('type' in updated)) {
      updateCollection(updated)
    } else if (collection) {
      updateCollection({ ...collection, items: updateItems(collection.items, updated.id, updated) })
    }
  }

  function addCollection() {
    if (!workspace || !section) return
    const added: Collection = { id: newId(), name: 'New Collection', auth: { type: 'none' }, items: [] }
    change({
      ...workspace, collections: [...workspace.collections, added],
      sections: workspace.sections?.map(candidate => candidate === section
        ? { ...candidate, collectionIds: [...candidate.collectionIds, added.id] } : candidate),
    })
    setSelection({ kind: 'collection', collectionId: added.id })
  }

  function addSection() {
    if (!workspace) return
    const name = window.prompt('Name of the new workspace section')?.trim()
    if (!name) return
    const environment = { id: newId(), name: name + ' Environment', variables: [] }
    const added = { id: newId(), name, collectionIds: [], environmentId: environment.id }
    change({ ...workspace, environments: [...workspace.environments, environment], sections: [...workspace.sections ?? [], added] })
    setSelection({ kind: 'environment', environmentId: environment.id })
  }

  function openSection(next: WorkspaceSection) {
    if (next.collectionIds.length) setSelection({ kind: 'collection', collectionId: next.collectionIds[0] })
    else if (next.environmentId) setSelection({ kind: 'environment', environmentId: next.environmentId })
  }

  function renameSection(target: WorkspaceSection) {
    if (!workspace) return
    const name = window.prompt('Workspace section name', target.name)?.trim()
    if (!name || name === target.name) return
    change({ ...workspace, sections: workspace.sections?.map(candidate => candidate.id === target.id ? { ...candidate, name } : candidate) })
  }

  function moveCollection(collectionId: string, destinationId: string) {
    if (!workspace?.sections || !section?.collectionIds.includes(collectionId) || section.id === destinationId) return
    change({
      ...workspace,
      sections: workspace.sections.map(candidate => {
        if (candidate.id === destinationId) return { ...candidate, collectionIds: [...candidate.collectionIds, collectionId] }
        if (candidate === section) return { ...candidate, collectionIds: candidate.collectionIds.filter(id => id !== collectionId) }
        return candidate
      }),
    })
    setSelection({ kind: 'collection', collectionId })
  }

  function removeSection(target: WorkspaceSection) {
    if (!workspace?.sections) return
    if (!window.confirm(`Delete section "${target.name}" and all its collections and variables?`)) return
    const sections = workspace.sections.filter(candidate => candidate.id !== target.id)
    change({
      ...workspace, sections,
      collections: workspace.collections.filter(({ id }) => !target.collectionIds.includes(id)),
      environments: workspace.environments.filter(({ id }) => id !== target.environmentId),
      activeEnvironmentId: workspace.activeEnvironmentId === target.environmentId ? null : workspace.activeEnvironmentId,
    })
    if (target.id === section?.id && sections[0]) openSection(sections[0])
  }

  function addItem(type: 'folder' | 'request') {
    if (!collection || !entry) return
    const id = newId()
    const added: CollectionItem = type === 'folder'
      ? { id, name: 'New Folder', type, auth: { type: 'inherit' }, items: [] }
      : { id, name: 'New Request', type, auth: { type: 'inherit' }, method: 'GET', url: '', headers: [] }
    if ('type' in entry && entry.type === 'folder') {
      updateCollection({ ...collection, items: updateItems(collection.items, entry.id, { ...entry, items: [...entry.items, added] }) })
    } else {
      updateCollection({ ...collection, items: [...collection.items, added] })
    }
    setSelection({ kind: 'item', collectionId: collection.id, itemId: id })
  }

  function remove() {
    if (!workspace || !section || !entry || !selection || selection.kind === 'environment') return
    const extra = collection?.exchange?.warnings?.length ? ' This may also remove preserved Postman content within this item.' : ''
    if (!window.confirm(`Delete "${entry.name}"?${extra}`)) return
    if (selection.kind === 'collection') {
      const id = selection.collectionId
      change({
        ...workspace,
        collections: workspace.collections.filter(candidate => candidate.id !== id),
        sections: workspace.sections?.map(candidate => candidate === section
          ? { ...candidate, collectionIds: candidate.collectionIds.filter(collectionId => collectionId !== id) } : candidate),
      })
      const other = section.collectionIds.find(collectionId => collectionId !== id)
      if (other) setSelection({ kind: 'collection', collectionId: other })
      else if (section.environmentId) setSelection({ kind: 'environment', environmentId: section.environmentId })
    } else if (collection) {
      updateCollection({ ...collection, items: updateItems(collection.items, selection.itemId) })
    }
  }

  function importSource(source: File | string) {
    if (!saved || !section || dirty || busy) return
    setImportOpen(false)
    void persist(() => importCollection(source, section.id), 'Collection imported.', result => {
      const imported = result.collections.find(candidate => !saved.collections.some(existing => existing.id === candidate.id))
      if (imported) setSelection({ kind: 'collection', collectionId: imported.id })
    })
  }

  async function download(collectionId: string) {
    if (busy || !exportCollections.some(({ id }) => id === collectionId)) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetchApp(`/api/collections/${encodeURIComponent(collectionId)}/export`)
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || `Collection export failed (HTTP ${response.status}).`)
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'collection.zip'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(dirty ? 'Saved version exported. Unsaved changes are still in the editor.'
        : 'Collection exported. Extract the ZIP to use the Postman collection directory.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export collection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="workbench">
      {view && <Explorer workspace={view} selection={selection} onSelect={setSelection}
        sectionControls={workspace?.sections ? {
          current: section, sections: workspace.sections, onOpen: openSection, onAdd: addSection,
          orderKey: accountId ? 'workspace-section-order:' + accountId : undefined,
          onRename: renameSection, onDelete: removeSection, onMoveCollection: moveCollection,
        } : undefined}
        onAddCollection={addCollection} disabled={busy || !saved} dirty={dirty}
        onImport={section ? () => setImportOpen(true) : undefined}
        onExport={download} exportCollections={exportCollections} />}
      <main>
        <div className="editor-toolbar">
          <span className="current-tab">{entry ? entry.name || 'Untitled' : 'Workspace'}{dirty && <span className="dirty-marker" title="Unsaved changes">●</span>}</span>
          <div className="editor-controls">
            <div className="environment-controls">
              {activeEnvironment && selection?.kind !== 'environment' && <WorkspaceLink
                href={selectionPath({ kind: 'environment', environmentId: activeEnvironment.id })}
                onNavigate={path => navigate(path, 'pushState')}>View variables</WorkspaceLink>}
            </div>
            {dirty && <VscodeButton secondary disabled={busy} onClick={discard}>Discard</VscodeButton>}
            <VscodeButton disabled={!dirty || busy} onClick={save}>Save</VscodeButton>
            <VscodeButton secondary disabled={!saved || busy} onClick={() => setSharingOpen(true)}>Workspace sharing</VscodeButton>
            <form method="post" action="/logout">
              <button className="sign-out" type="submit">Sign out</button>
            </form>
          </div>
        </div>
        {error && <div className="error-banner" role="alert">
          {error} {(!workspace || !dirty) && <VscodeButton secondary disabled={busy} onClick={retry}>Reload workspace</VscodeButton>}
        </div>}
        {!workspace && !error && <p className="empty-view" role="status">Loading workspace…</p>}
        {workspace && !entry && <p className="empty-view">Select a collection, request, or environment to get started.</p>}
        {entry && <Editor key={entry.id} entry={entry} collection={collection} authorizationSource={authorizationSource}
          showScripts={tab === 'scripts'}
          parentScripts={parentScripts}
          onNavigate={path => navigate(path, 'pushState')}
          environment={activeEnvironment} disabled={busy} onEdit={edit}
          onDelete={selection?.kind === 'environment' ? undefined : remove} onAddItem={addItem} />}
      </main>
      <footer className="statusbar"><span role="status">{busy ? 'Working…' : dirty ? 'Unsaved changes' : notice || (!error && workspace && 'Workspace ready')}</span></footer>
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImport={importSource} />}
      {sharingOpen && <SharingDialog dirty={dirty} onClose={() => setSharingOpen(false)} onCopied={result => {
        setSaved(result)
        const copied = result.sections?.find(candidate => !saved?.sections?.some(existing => existing.id === candidate.id))
        if (copied) openSection(copied)
        setError('')
        setNotice('Shared workspace copied into your workspace.')
        setSharingOpen(false)
      }} />}
    </div>
  )
}
