import { fetchApp } from '../app-api'
import { VscodeButton, VscodeTabHeader, VscodeTabPanel, VscodeTabs } from '@vscode-elements/react-elements'
import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentRef, type ReactNode } from 'react'
import { inferBodyFormat, isBodyFormat } from '../../../server/body-format.ts'
import { AuthorizationEditor } from './AuthorizationEditor'
import { ResponseView } from './ResponseView'
import type { RequestResult } from './ResponseView'
import { RowsEditor } from './RowsEditor'
import { prepareSend } from './send'
import type { Auth, Collection, Environment, Folder, Request } from './types'
import { previewVariables } from './variables'
import { selectionPath } from './routes'
import { WorkspaceLink } from './WorkspaceLink'
import type { ScriptSource } from './tree'

export type Entry = Collection | Folder | Request | Environment

type Props = {
  entry: Entry
  collection?: Collection
  authorizationSource?: { name: string, auth: Auth, href: string }
  parentScripts?: ScriptSource[]
  showScripts?: boolean
  onNavigate: (path: string) => void
  environment?: Environment
  disabled: boolean
  readOnly?: boolean
  onEdit: (entry: Entry) => void
  onDelete?: () => void
  onAddItem?: (type: 'folder' | 'request') => void
}

const commonMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const MonacoBodyEditor = lazy(() => import('./MonacoBodyEditor'))

function RequestFields({ entry, variables, onEdit, disabled, sendButton }: Pick<Props, 'onEdit' | 'disabled'> & {
  entry: Request, variables: Record<string, string>, sendButton: ReactNode,
}) {
  const preview = previewVariables(entry.url, variables)
  const methods = useId()
  return (
    <div className="request-builder">
      <div className="request-line">
        <input className="method-input" aria-label="HTTP method" list={methods} disabled={disabled}
          value={entry.method} onChange={event => onEdit({ ...entry, method: event.target.value.toUpperCase() })} />
        <datalist id={methods}>{commonMethods.map(method => <option key={method} value={method} />)}</datalist>
        <input className="url-input" aria-label="Request URL" placeholder="Enter URL or paste text" disabled={disabled}
          value={entry.url} onChange={event => onEdit({ ...entry, url: event.target.value })} />
        {sendButton}
      </div>
      {preview.value !== entry.url && <p className="url-preview"><strong>Resolved URL</strong> {preview.value}</p>}
      {preview.unresolved.length > 0 && <p className="url-preview">Unresolved variables: {preview.unresolved.join(', ')}</p>}
    </div>
  )
}

export function Editor({ entry, collection, authorizationSource, parentScripts = [], showScripts, onNavigate, environment, disabled, readOnly, onEdit, onDelete, onAddItem }: Props) {
  const [result, setResult] = useState<RequestResult>()
  const [sendError, setSendError] = useState('')
  const [pending, setPending] = useState(false)
  const inFlight = useRef<AbortController>(null)
  const configuration = useRef<ComponentRef<typeof VscodeTabs>>(null)
  useEffect(() => () => inFlight.current?.abort(), [])
  const environmentVariables = Object.fromEntries(environment?.variables.filter(row => row.enabled).map(row => [row.key, row.value]) ?? [])
  const collectionVariables = collection?.exchange?.variables
  const variables = { ...collectionVariables, ...environmentVariables }
  const variableHover = {
    href: environment && selectionPath({ kind: 'environment', environmentId: environment.id }), values: variables, onNavigate,
  }
  const isEnvironment = 'variables' in entry
  const isRequest = 'type' in entry && entry.type === 'request'
  const isCollection = !isEnvironment && !('type' in entry)
  useEffect(() => {
    if (configuration.current) configuration.current.selectedIndex = showScripts ? (isRequest ? 3 : 1) : 0
  }, [isRequest, showScripts])
  const warnings = collection?.exchange?.warnings
  const scriptSources = !isEnvironment && (entry.preRequest || entry.postResponse)
    ? [...parentScripts, entry]
    : parentScripts
  const preRequestSources = scriptSources.filter(source => source.preRequest)

  async function sendRequest(request: Request) {
    if (inFlight.current) return
    const controller = new AbortController()
    inFlight.current = controller
    setPending(true)
    setResult(undefined)
    setSendError('')
    try {
      const scripts = preRequestSources.flatMap(source => source.preRequest ? [source.preRequest] : [])
      const postScripts = scriptSources.flatMap(source => source.postResponse ? [source.postResponse] : [])
      const payload = prepareSend(request, variables, authorizationSource?.auth, scripts.length > 0)
      const response = await fetchApp('/api/requests/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(scripts.length ? { scripts } : {}), ...(postScripts.length ? { postScripts } : {}),
          ...(scripts.length || postScripts.length ? { scriptVariables: environmentVariables, collectionVariables } : {}) }), signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `Send failed (HTTP ${response.status}).`)
      if (!controller.signal.aborted) setResult(data)
    } catch (error) {
      if (!controller.signal.aborted) setSendError(error instanceof Error ? error.message : 'Send failed.')
    } finally {
      inFlight.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }
  const sendButton = isRequest && !readOnly && (
    <VscodeButton disabled={disabled || pending || !entry.url.trim()} onClick={() => void sendRequest(entry)}>
      {pending ? 'Sending…' : 'Send'}
    </VscodeButton>
  )
  const configurationTabs = !isEnvironment && (
    <VscodeTabs className="editor-tabs" panel ref={configuration}>
      <VscodeTabHeader slot="header">Authorization</VscodeTabHeader>
      {isRequest && <>
        <VscodeTabHeader slot="header">Headers ({entry.headers.length})</VscodeTabHeader>
        <VscodeTabHeader slot="header">Body</VscodeTabHeader>
      </>}
      <VscodeTabHeader slot="header">Scripts</VscodeTabHeader>
      <VscodeTabPanel>
        <AuthorizationEditor auth={entry.auth} source={authorizationSource} onNavigate={onNavigate} variableHover={variableHover} disabled={disabled} readOnly={readOnly}
          onChange={auth => onEdit({ ...entry, auth })} />
      </VscodeTabPanel>
      {isRequest && <>
        <VscodeTabPanel>
          {!!preRequestSources.length && collection && <div className="pre-request-links">
            <span>Pre-request scripts run before variables are resolved:</span>
            {preRequestSources.map(source => <WorkspaceLink key={source.id}
              href={`${selectionPath(source.id === collection.id ? { kind: 'collection', collectionId: collection.id }
                : { kind: 'item', collectionId: collection.id, itemId: source.id })}#scripts`}
              onNavigate={onNavigate}>{source.name}</WorkspaceLink>)}
          </div>}
          <RowsEditor label="Headers" keyLabel="Key" addLabel="Add header" wrapFields rows={entry.headers} disabled={disabled}
            onChange={headers => onEdit({ ...entry, headers })} />
        </VscodeTabPanel>
        <VscodeTabPanel>
          <div className="body-editor">
            <label>Body type
              <select value={entry.body === undefined ? 'none' : 'raw'} disabled={disabled}
                onChange={event => onEdit(event.target.value === 'none'
                  ? { ...entry, body: undefined, bodyFormat: undefined }
                  : { ...entry, body: '', bodyFormat: 'json' })}>
                <option value="none">none</option>
                <option value="raw">raw</option>
              </select>
            </label>
            {entry.body !== undefined && <>
              <label>Raw format
                <select value={entry.bodyFormat ?? inferBodyFormat(entry.headers)} disabled={disabled}
                  onChange={event => {
                    const bodyFormat = event.target.value
                    if (isBodyFormat(bodyFormat)) onEdit({ ...entry, bodyFormat })
                  }}>
                  <option value="text">Text</option>
                  <option value="javascript">JavaScript</option>
                  <option value="json">JSON</option>
                  <option value="html">HTML</option>
                  <option value="xml">XML</option>
                </select>
              </label>
              <Suspense fallback={<p role="status">Loading editor…</p>}>
                <div className="request-body-frame">
                  <MonacoBodyEditor value={entry.body} format={entry.bodyFormat ?? inferBodyFormat(entry.headers)} disabled={disabled} variableHover={variableHover}
                    onChange={body => onEdit({ ...entry, body })} />
                </div>
              </Suspense>
              <div className="request-send">{sendButton}</div>
            </>}
          </div>
        </VscodeTabPanel>
      </>}
      <VscodeTabPanel>
        <h2>Pre-request</h2>
        <p>JavaScript runs before sending the request. Use <code>pm.variables.replaceIn</code> and <code>pm.request.headers</code> to generate or update headers.</p>
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <MonacoBodyEditor label="Pre-request script" value={entry.preRequest ?? ''} format="javascript" disabled={disabled}
            onChange={preRequest => onEdit({ ...entry, preRequest })} />
        </Suspense>
        <h2>Post-response</h2>
        <Suspense fallback={<p role="status">Loading editor…</p>}>
          <MonacoBodyEditor label="Post-response script" value={entry.postResponse ?? ''} format="javascript" disabled={disabled}
            onChange={postResponse => onEdit({ ...entry, postResponse })} />
        </Suspense>
      </VscodeTabPanel>
    </VscodeTabs>
  )
  return (
    <div className="editor">
      <header className="editor-heading">
        <div>
          <p className="breadcrumb">{isEnvironment ? 'Environments' : collection && !isCollection ? collection.name : 'Collections'}</p>
          <input className="entry-name" aria-label="Name" value={entry.name} disabled={disabled}
            onChange={event => onEdit({ ...entry, name: event.target.value })} />
        </div>
        {!readOnly && <div className="entry-actions">
          {!isEnvironment && !isRequest && onAddItem && <>
            <VscodeButton secondary disabled={disabled} onClick={() => onAddItem('request')}>Add request</VscodeButton>
            <VscodeButton secondary disabled={disabled} onClick={() => onAddItem('folder')}>Add folder</VscodeButton>
          </>}
          {onDelete && <VscodeButton className="danger-action" secondary disabled={disabled} onClick={onDelete}>Delete</VscodeButton>}
        </div>}
      </header>
      {!!warnings?.length && <details className="import-notice">
        <summary>Imported content outside this editor’s supported fields ({warnings.length})</summary>
        <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </details>}
      {isEnvironment ? (
        <RowsEditor label="Environment variables" keyLabel="Variable" addLabel="Add variable" rows={entry.variables} disabled={disabled}
          onChange={variables => onEdit({ ...entry, variables })} />
      ) : <>
        {isRequest && <RequestFields entry={entry} variables={variables} onEdit={onEdit} disabled={disabled} sendButton={sendButton} />}
        {configurationTabs}
        {isRequest && !readOnly && <ResponseView result={result} error={sendError} pending={pending} />}
      </>}
    </div>
  )
}
