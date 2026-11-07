import { lazy, Suspense, useId } from 'react'
import { defaultJwt, jwtAlgorithms } from '../../../server/jwt-settings.ts'
import type { JwtSettings } from '../../../server/jwt-settings.ts'
import type { Auth } from './types'
import { WorkspaceLink } from './WorkspaceLink'
import { SigningKeyEditor } from './SigningKeyEditor'
import type { VariableHover } from './MonacoBodyEditor'

const MonacoBodyEditor = lazy(() => import('./MonacoBodyEditor'))

const authLabels: Record<Auth['type'], string> = {
  inherit: 'Inherit auth from parent',
  none: 'No Auth',
  basic: 'Basic Auth',
  bearer: 'Bearer Token',
  jwt: 'JWT Bearer',
}

function emptyAuth(type: Auth['type']): Auth {
  if (type === 'basic') return { type, username: '', password: '' }
  if (type === 'bearer') return { type, token: '' }
  if (type === 'jwt') return { ...defaultJwt }
  return { type }
}

function JwtEditor({ auth, onChange, disabled, readOnly, variableHover }: {
  auth: JwtSettings, onChange: (auth: Auth) => void, disabled: boolean, readOnly?: boolean, variableHover?: VariableHover,
}) {
  const hmac = auth.algorithm.startsWith('HS')
  const keyHelp = useId()
  const name = auth.secretRef.startsWith('{{') ? auth.secretRef.slice(2, -2) : auth.secretRef
  const reference = auth.secretRef.startsWith('{{') && variableHover && Object.hasOwn(variableHover.values, name)
    ? variableHover.values[name] : name
  return <div className="jwt-editor">
    <label>Add JWT token to
      <select value={auth.addTokenTo} disabled={disabled} onChange={event => onChange({ ...auth, addTokenTo: event.target.value === 'header' ? 'header' : 'queryParam' })}>
        <option value="header">Request Header</option>
        <option value="queryParam">Query Param</option>
      </select>
    </label>
    <label>Algorithm
      <select value={auth.algorithm} disabled={disabled} onChange={event => onChange({ ...auth, algorithm: event.target.value as JwtSettings['algorithm'] })}>
        {jwtAlgorithms.map(algorithm => <option key={algorithm}>{algorithm}</option>)}
      </select>
    </label>
    <label>{hmac ? 'Secret' : 'Private key'}
      <input value={auth.secretRef} aria-describedby={keyHelp} placeholder={hmac ? 'Enter secret name' : 'Enter private key name'}
        autoComplete="off" spellCheck={false} disabled={disabled} onChange={event => onChange({ ...auth, secretRef: event.target.value })} />
    </label>
    {hmac && <label className="jwt-base64">
      <input type="checkbox" checked={auth.base64} disabled={disabled} onChange={event => onChange({ ...auth, base64: event.target.checked })} />
      Secret Base64 encoded
    </label>}
    <p id={keyHelp}>{readOnly ? 'Signing keys are stored separately from the shared workspace.'
      : 'Enter the name configured for this signing key on the server.'}</p>
    {!readOnly && <SigningKeyEditor key={`${reference}:${auth.algorithm}`} reference={reference} algorithm={auth.algorithm}
      baseUrl={variableHover?.values.baseUrl} disabled={disabled} />}
    <h3>Payload</h3>
    <Suspense fallback={<p role="status">Loading editor…</p>}>
      <MonacoBodyEditor label="JWT payload" value={auth.payload} format="json" disabled={disabled} variableHover={variableHover} onChange={payload => onChange({ ...auth, payload })} />
    </Suspense>
    <details>
      <summary>Advanced configuration</summary>
      {auth.addTokenTo === 'header'
        ? <label>Request header prefix<input value={auth.headerPrefix} disabled={disabled} onChange={event => onChange({ ...auth, headerPrefix: event.target.value })} /></label>
        : <label>Query parameter key<input value={auth.queryParamKey} disabled={disabled} onChange={event => onChange({ ...auth, queryParamKey: event.target.value })} /></label>}
      <h3>JWT headers</h3>
      <textarea aria-label="JWT headers" spellCheck={false} value={auth.header} disabled={disabled} onChange={event => onChange({ ...auth, header: event.target.value })} />
    </details>
  </div>
}

export function AuthorizationEditor({ auth, source, onNavigate, onChange, disabled, readOnly, variableHover }: {
  auth: Auth
  source?: { name: string, auth: Auth, href: string }
  onNavigate: (path: string) => void
  onChange: (auth: Auth) => void
  disabled: boolean
  readOnly?: boolean
  variableHover?: VariableHover
}) {
  return (
    <div className="authorization-editor">
      <label>Auth Type
        <select value={auth.type} disabled={disabled} onChange={event => onChange(emptyAuth(event.target.value as Auth['type']))}>
          {Object.entries(authLabels).map(([type, label]) => <option value={type} key={type}>{label}</option>)}
        </select>
      </label>
      <div className="auth-details">
        {auth.type === 'inherit' && (source ? <div className="inherited-auth">
          <div>
            <strong>{authLabels[source.auth.type]}</strong>
            <div className="inherited-auth-source">Inherited from {source.name}</div>
          </div>
          <WorkspaceLink href={source.href} onNavigate={onNavigate}>{readOnly ? 'View in Parent' : 'Edit in Parent'}</WorkspaceLink>
        </div> : <p>No parent authorization is configured.</p>)}
        {auth.type === 'none' && <p>No authorization is configured.</p>}
        {auth.type === 'basic' && <>
          <label>Username
            <input value={auth.username} disabled={disabled} onChange={event => onChange({ ...auth, username: event.target.value })} />
          </label>
          <label>Password
            <input type="password" autoComplete="new-password" value={auth.password} disabled={disabled}
              onChange={event => onChange({ ...auth, password: event.target.value })} />
          </label>
        </>}
        {auth.type === 'bearer' && <label>Token
          <input type="text" autoComplete="off" spellCheck={false} value={auth.token} disabled={disabled}
            onChange={event => onChange({ ...auth, token: event.target.value })} />
        </label>}
        {auth.type === 'jwt' && <JwtEditor auth={auth} onChange={onChange} disabled={disabled} readOnly={readOnly} variableHover={variableHover} />}
      </div>
    </div>
  )
}
