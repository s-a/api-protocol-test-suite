import { monacoLanguage } from './workspace/loadMonacoBodyEditor'
import { translateError } from './i18n'
import { useTranslation } from 'react-i18next'
import { fetchApp } from './app-api'
import { VscodeButton } from '@vscode-elements/react-elements'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { importCollection, readWorkspace } from './workspace/api'
import { Editor } from './workspace/Editor'
import type { Entry } from './workspace/Editor'
import { ExportDialog } from './workspace/ExportDialog'
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
  const { t, i18n } = useTranslation()
  const [saved, setSaved] = useState<Workspace | null>(null)
  const [draft, setDraft] = useState<Workspace | null>(null)
  const route = useSyncExternalStore(subscribeToPath, readPath)
  const [pathname, tab] = route.split('#', 2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [languageReload, setLanguageReload] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [exportTarget, setExportTarget] = useState<Collection>()
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
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : i18n.t('loadError'))
      }
    }
    void load()
    return () => controller.abort()
  }, [reload, i18n])

  useEffect(() => {
    if (!dirty) return
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  useEffect(() => {
    if (languageReload && !dirty) window.location.reload()
  }, [languageReload, dirty])

  function changeLanguage(language: string) {
    void i18n.changeLanguage(language).then(() => {
      setLanguageReload(Boolean(monacoLanguage() && monacoLanguage() !== language))
    })
  }

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
      setError(reason instanceof Error ? reason.message : t('saveError'))
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
    })), t('saved'))
  }

  function discard() {
    if (!saved || !window.confirm(t('confirmDiscard'))) return
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
    const added: Collection = { id: newId(), name: i18n.language === 'de' ? 'Neue Sammlung' : 'New Collection', auth: { type: 'none' }, items: [] }
    change({
      ...workspace, collections: [...workspace.collections, added],
      sections: workspace.sections?.map(candidate => candidate === section
        ? { ...candidate, collectionIds: [...candidate.collectionIds, added.id] } : candidate),
    })
    setSelection({ kind: 'collection', collectionId: added.id })
  }

  function addSection() {
    if (!workspace) return
    const name = window.prompt(t('sectionPrompt'))?.trim()
    if (!name) return
    const environment = { id: newId(), name: name + (i18n.language === 'de' ? ' Umgebung' : ' Environment'), variables: [] }
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
    const name = window.prompt(t('sectionName'), target.name)?.trim()
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
    if (!window.confirm(t('deleteSection', { name: target.name }))) return
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
      ? { id, name: i18n.language === 'de' ? 'Neuer Ordner' : 'New Folder', type, auth: { type: 'inherit' }, items: [] }
      : { id, name: i18n.language === 'de' ? 'Neue Anfrage' : 'New Request', type, auth: { type: 'inherit' }, method: 'GET', url: '', headers: [] }
    if ('type' in entry && entry.type === 'folder') {
      updateCollection({ ...collection, items: updateItems(collection.items, entry.id, { ...entry, items: [...entry.items, added] }) })
    } else {
      updateCollection({ ...collection, items: [...collection.items, added] })
    }
    setSelection({ kind: 'item', collectionId: collection.id, itemId: id })
  }

  function remove() {
    if (!workspace || !section || !entry || !selection || selection.kind === 'environment') return
    const extra = collection?.exchange?.warnings?.length ? t('deleteWarning') : ''
    if (!window.confirm(t('deleteItem', { name: entry.name, extra }))) return
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
    void persist(() => importCollection(source, section.id), t('imported'), result => {
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
      setNotice(dirty ? t('exportedDirty')
        : t('exported'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('exportError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="workbench">
      {view && <Explorer workspace={view} searchSource={workspace ?? undefined} selection={selection} onSelect={setSelection}
        sectionControls={workspace?.sections ? {
          current: section, sections: workspace.sections, onOpen: openSection, onAdd: addSection,
          orderKey: accountId ? 'workspace-section-order:' + accountId : undefined,
          onRename: renameSection, onDelete: removeSection, onMoveCollection: moveCollection,
        } : undefined}
        onAddCollection={addCollection} disabled={busy || !saved} dirty={dirty}
        onImport={section ? () => setImportOpen(true) : undefined}
        onExport={id => setExportTarget(exportCollections.find(candidate => candidate.id === id))}
        exportCollections={exportCollections} />}
      <main>
        <div className="editor-toolbar">
          <span className="current-tab">{entry ? entry.name || t('untitled') : t('workspace')}{dirty && <span className="dirty-marker" title={t('unsaved')}>●</span>}</span>
          <div className="editor-controls">
            <label>{t('language')}{' '}
              <select value={i18n.resolvedLanguage} disabled={busy} onChange={event => changeLanguage(event.target.value)}>
                <option value="de">Deutsch</option><option value="en">English</option>
              </select>
            </label>
            <div className="environment-controls">
              {activeEnvironment && selection?.kind !== 'environment' && <WorkspaceLink
                href={selectionPath({ kind: 'environment', environmentId: activeEnvironment.id })}
                onNavigate={path => navigate(path, 'pushState')}>{t('variables')}</WorkspaceLink>}
            </div>
            {dirty && <VscodeButton secondary disabled={busy} onClick={discard}>{t('discard')}</VscodeButton>}
            <VscodeButton disabled={!dirty || busy} onClick={save}>{t('save')}</VscodeButton>
            <VscodeButton secondary disabled={!saved || busy} onClick={() => setSharingOpen(true)}>{t('sharing')}</VscodeButton>
            <form method="post" action="/logout">
              <button className="sign-out" type="submit">{t('signOut')}</button>
            </form>
          </div>
        </div>
        {languageReload && dirty && <p role="status">{i18n.resolvedLanguage === 'de'
          ? 'Die Editorsprache wird nach dem Speichern oder Verwerfen der Änderungen aktualisiert.'
          : 'The editor language will update after saving or discarding changes.'}</p>}
        {error && <div className="error-banner" role="alert">
          {translateError(error)} {(!workspace || !dirty) && <VscodeButton secondary disabled={busy} onClick={retry}>{t('reload')}</VscodeButton>}
        </div>}
        {!workspace && !error && <p className="empty-view" role="status">{t('loading')}</p>}
        {workspace && !entry && <p className="empty-view">{t('empty')}</p>}
        {entry && <Editor key={entry.id} entry={entry} collection={collection} authorizationSource={authorizationSource}
          showScripts={tab === 'scripts'}
          parentScripts={parentScripts}
          onNavigate={path => navigate(path, 'pushState')}
          environment={activeEnvironment} disabled={busy} onEdit={edit}
          onDelete={selection?.kind === 'environment' ? undefined : remove} onAddItem={addItem} />}
      </main>
      <footer className="statusbar"><span role="status">{busy ? t('working') : dirty ? t('unsaved') : notice || (!error && workspace && t('ready'))}</span></footer>
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImport={importSource} />}
      {exportTarget && <ExportDialog name={exportTarget.name || t('untitledCollection')}
        onClose={() => setExportTarget(undefined)} onConfirm={() => void download(exportTarget.id)} />}
      {sharingOpen && <SharingDialog dirty={dirty} onClose={() => setSharingOpen(false)} onCopied={result => {
        setSaved(result)
        const copied = result.sections?.find(candidate => !saved?.sections?.some(existing => existing.id === candidate.id))
        if (copied) openSection(copied)
        setError('')
        setNotice(t('copied'))
        setSharingOpen(false)
      }} />}
    </div>
  )
}

