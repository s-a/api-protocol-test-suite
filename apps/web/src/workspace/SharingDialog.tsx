import { translateError } from '../i18n'
import i18n from '../i18n'
import { fetchApp } from '../app-api'
import { VscodeButton } from '@vscode-elements/react-elements'
import { useEffect, useRef, useState } from 'react'
import { readApiResult, readWorkspace } from './api'
import { Editor } from './Editor'
import { Explorer } from './Explorer'
import { selectedEntry, selectionFromPath, selectionPath } from './routes'
import { sectionWorkspace } from './sections'
import type { Workspace, WorkspaceSection } from './types'

type Sharing = { sections: Pick<WorkspaceSection, 'id' | 'name'>[], sectionIds: string[], owners: string[] }
type Preview = { owner: string, workspace: Workspace, version: string }
const sharingUrl = '/api/workspace/sharing'
const previewUrl = (owner: string) => `/api/workspace/shared/${encodeURIComponent(owner)}`

function SharedPreview({ workspace }: { workspace: Workspace }) {
  const [path, setPath] = useState('/')
  const [pathname, tab] = path.split('#', 2)
  const selection = selectionFromPath(workspace, pathname)
  const { collection, entry, authorizationSource, parentScripts } = selectedEntry(workspace, selection)
  const activeEnvironment = workspace.environments.find(environment => environment.id === workspace.activeEnvironmentId)
  return <div className="shared-preview">
    <Explorer workspace={workspace} selection={selection} onSelect={next => setPath(selectionPath(next))} />
    <section className="shared-preview-content" aria-label={i18n.t("Shared workspace preview")}>
      {entry ? <Editor key={entry.id} entry={entry} collection={collection} authorizationSource={authorizationSource}
        parentScripts={parentScripts} showScripts={tab === 'scripts'} environment={activeEnvironment}
        onNavigate={setPath} onEdit={() => {}} disabled readOnly />
        : <p className="empty-view">{i18n.t("This workspace is empty.")}</p>}
    </section>
  </div>
}

export function SharingDialog({ dirty, onClose, onCopied }: {
  dirty: boolean, onClose: () => void, onCopied: (workspace: Workspace) => void,
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [sharing, setSharing] = useState<Sharing>()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview>()
  const [previewSectionId, setPreviewSectionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    dialog.current?.showModal()
    const controller = new AbortController()
    void fetchApp(sharingUrl, { signal: controller.signal })
      .then(readApiResult<Sharing>)
      .then(data => {
        if (controller.signal.aborted) return
        setSharing(data)
        setSelectedIds(data.sectionIds)
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : i18n.t("Workspace sharing request failed."))
    } finally {
      setBusy(false)
    }
  }

  function saveSharing(sectionIds: string[]) {
    if (!sharing) return
    void run(async () => {
      const result = await readApiResult<{ sectionIds: string[] }>(await fetchApp(sharingUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sectionIds }),
      }))
      setSharing({ ...sharing, sectionIds: result.sectionIds })
      setSelectedIds(result.sectionIds)
    })
  }

  function openPreview(owner: string) {
    void run(async () => {
      const response = await fetchApp(previewUrl(owner))
      if (response.status === 404) {
        setSharing(current => current && { ...current, owners: current.owners.filter(name => name !== owner) })
      }
      const workspace = await readWorkspace(response)
      const version = response.headers.get('ETag')
      if (!version) throw new Error(i18n.t("The shared workspace version is unavailable."))
      setPreviewSectionId(workspace.sections?.[0]?.id ?? '')
      setPreview({ owner, workspace, version })
    })
  }

  function backToSharing() {
    void run(async () => {
      setPreview(undefined)
      const latest = await readApiResult<Sharing>(await fetchApp(sharingUrl))
      setSharing(current => current && { ...current, owners: latest.owners })
    })
  }

  function copy() {
    if (!preview || dirty) return
    void run(async () => {
      const result = await readWorkspace(await fetchApp(previewUrl(preview.owner) + '/copy', {
        method: 'POST', headers: { 'If-Match': preview.version },
      }))
      dialog.current?.close()
      onCopied(result)
    })
  }

  const previewSection = preview?.workspace.sections?.find(({ id }) => id === previewSectionId)
  const selectionChanged = sharing && (selectedIds.length !== sharing.sectionIds.length ||
    selectedIds.some(id => !sharing.sectionIds.includes(id)))
  return <dialog ref={dialog} className={`sharing-dialog${preview ? ' sharing-dialog-preview' : ''}`}
    aria-labelledby="sharing-title" onClose={onClose}
    onCancel={event => { if (busy) event.preventDefault() }}>
    <header className="sharing-header">
      <div>
        <h2 id="sharing-title">{preview ? i18n.t("Shared workspace") : i18n.t("Workspace sharing")}</h2>
        <p>{preview ? `${i18n.language === "de" ? "Geteilt von" : "Shared by"} ${preview.owner}` : i18n.t("Manage access to your saved sections and browse workspaces shared with you.")}</p>
      </div>
      <VscodeButton secondary disabled={busy} onClick={() => dialog.current?.close()}>{i18n.t("Close")}</VscodeButton>
    </header>
    {error && <p className="error-banner" role="alert">{translateError(error)}</p>}
    {preview ? <>
      <div className="sharing-preview-bar">
        <label>{i18n.t("Section")}
          <select value={previewSectionId} disabled={busy} onChange={event => setPreviewSectionId(event.target.value)}>
            {preview.workspace.sections?.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <span className="sharing-badge">{i18n.t("Read-only")}</span>
      </div>
      {previewSection && <SharedPreview key={previewSection.id} workspace={sectionWorkspace(preview.workspace, previewSection)} />}
      <footer className="sharing-footer">
        <p>{dirty ? i18n.t("Save or discard your changes before copying.")
          : i18n.t("Copying adds all shared sections and their environments to your workspace.")}</p>
        <div className="sharing-actions">
          <VscodeButton secondary disabled={busy} onClick={backToSharing}>{i18n.t("Back")}</VscodeButton>
          <VscodeButton disabled={busy || dirty} onClick={copy}>{i18n.t("Copy to my workspace")}</VscodeButton>
        </div>
      </footer>
    </> : sharing ? <div className="sharing-options">
      <section className="sharing-panel">
        <div className="sharing-panel-heading">
          <h3>{i18n.t("My workspace")}</h3>
          <span className="sharing-badge" role="status">{sharing.sectionIds.length
            ? `${sharing.sectionIds.length} ${i18n.language === "de" ? "geteilt" : "shared"}` : i18n.t("Private")}</span>
        </div>
        <p>{i18n.t("All signed-in users can access the sections you share, including collections, environment values, stored credentials, and future saves.")}</p>
        <fieldset disabled={busy}>
          <legend>{i18n.t("Sections to share")}</legend>
          <ul>{sharing.sections.map(({ id, name }) => <li key={id}>
            <label className="sharing-row">
              <input type="checkbox" checked={selectedIds.includes(id)} onChange={event => {
                setSelectedIds(event.target.checked ? [...selectedIds, id] : selectedIds.filter(selected => selected !== id))
              }} />
              <span>{name}</span>
            </label>
          </li>)}</ul>
        </fieldset>
        <div className="sharing-actions">
          {sharing.sectionIds.length > 0 && <VscodeButton className="danger-action" secondary disabled={busy}
            onClick={() => saveSharing([])}>{i18n.t("Stop sharing")}</VscodeButton>}
          <VscodeButton disabled={busy || !selectionChanged} onClick={() => saveSharing(selectedIds)}>{i18n.t("Save sharing")}</VscodeButton>
        </div>
      </section>
      <section className="sharing-panel">
        <h3>{i18n.t("Shared by other users")}</h3>
        <p>{i18n.t("Preview a shared workspace or copy its sections into yours.")}</p>
        {sharing.owners.length ? <ul>{sharing.owners.map(owner => <li className="sharing-row sharing-owner" key={owner}>
          <span>{owner}</span>
          <VscodeButton secondary disabled={busy} aria-label={`${i18n.language === "de" ? "Vorschau des geteilten Arbeitsbereichs von" : "Preview workspace shared by"} ${owner}`}
            onClick={() => openPreview(owner)}>{i18n.t("Preview")}</VscodeButton>
        </li>)}</ul> : <p className="sharing-empty">{i18n.t("No shared workspaces are available.")}</p>}
      </section>
    </div> : !error && <p className="sharing-loading" role="status">{i18n.t("Loading shared workspaces…")}</p>}
  </dialog>
}
