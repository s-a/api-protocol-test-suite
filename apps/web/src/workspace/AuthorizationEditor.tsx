import { loadMonacoBodyEditor } from './loadMonacoBodyEditor'
import i18n from '../i18n'
import { lazy, Suspense, useId } from 'react'
import { defaultJwt, jwtAlgorithms } from '../../../server/jwt-settings.ts'
import type { JwtSettings } from '../../../server/jwt-settings.ts'
import type { Auth } from './types'
import { WorkspaceLink } from './WorkspaceLink'
import { SigningKeyEditor } from './SigningKeyEditor'
import type { VariableHover } from './MonacoBodyEditor'

const MonacoBodyEditor = lazy(loadMonacoBodyEditor)

const authLabels = (): Record<Auth['type'], string> => ({
  inherit: i18n.t("Inherit auth from parent"),
  none: i18n.t("No Auth"),
  basic: i18n.t("Basic Auth"),
  bearer: i18n.t("Bearer Token"),
  jwt: i18n.t("JWT Bearer"),
})

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
    <label>{i18n.t("Add JWT token to")}
      <select value={auth.addTokenTo} disabled={disabled} onChange={event => onChange({ ...auth, addTokenTo: event.target.value === 'header' ? 'header' : 'queryParam' })}>
        <option value="header">{i18n.t("Request Header")}</option>
        <option value="queryParam">{i18n.t("Query Param")}</option>
      </select>
    </label>
    <label>{i18n.t("Algorithm")}
      <select value={auth.algorithm} disabled={disabled} onChange={event => onChange({ ...auth, algorithm: event.target.value as JwtSettings['algorithm'] })}>
        {jwtAlgorithms.map(algorithm => <option key={algorithm}>{algorithm}</option>)}
      </select>
    </label>
    <label>{hmac ? i18n.t("Secret") : i18n.t("Private key")}
      <input value={auth.secretRef} aria-describedby={keyHelp} placeholder={hmac ? i18n.t("Enter secret name") : i18n.t("Enter private key name")}
        autoComplete="off" spellCheck={false} disabled={disabled} onChange={event => onChange({ ...auth, secretRef: event.target.value })} />
    </label>
    {hmac && <label className="jwt-base64">
      <input type="checkbox" checked={auth.base64} disabled={disabled} onChange={event => onChange({ ...auth, base64: event.target.checked })} />
      {i18n.t("Secret Base64 encoded")}
    </label>}
    <p id={keyHelp}>{readOnly ? i18n.t("Signing keys are stored separately from the shared workspace.")
      : i18n.t("Enter the name configured for this signing key on the server.")}</p>
    {!readOnly && <SigningKeyEditor key={`${reference}:${auth.algorithm}`} reference={reference} algorithm={auth.algorithm}
      baseUrl={variableHover?.values.baseUrl} disabled={disabled} />}
    <h3>{i18n.t("Payload")}</h3>
    <Suspense fallback={<p role="status">{i18n.t("Loading editor…")}</p>}>
      <MonacoBodyEditor label={i18n.t("JWT payload")} value={auth.payload} format="json" disabled={disabled} variableHover={variableHover} onChange={payload => onChange({ ...auth, payload })} />
    </Suspense>
    <details>
      <summary>{i18n.t("Advanced configuration")}</summary>
      {auth.addTokenTo === 'header'
        ? <label>{i18n.t("Request header prefix")}<input value={auth.headerPrefix} disabled={disabled} onChange={event => onChange({ ...auth, headerPrefix: event.target.value })} /></label>
        : <label>{i18n.t("Query parameter key")}<input value={auth.queryParamKey} disabled={disabled} onChange={event => onChange({ ...auth, queryParamKey: event.target.value })} /></label>}
      <h3>{i18n.t("JWT headers")}</h3>
      <textarea aria-label={i18n.t("JWT headers")} spellCheck={false} value={auth.header} disabled={disabled} onChange={event => onChange({ ...auth, header: event.target.value })} />
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
      <label>{i18n.t("Auth Type")}
        <select value={auth.type} disabled={disabled} onChange={event => onChange(emptyAuth(event.target.value as Auth['type']))}>
          {Object.entries(authLabels()).map(([type, label]) => <option value={type} key={type}>{label}</option>)}
        </select>
      </label>
      <div className="auth-details">
        {auth.type === 'inherit' && (source ? <div className="inherited-auth">
          <div>
            <strong>{authLabels()[source.auth.type]}</strong>
            <div className="inherited-auth-source">{i18n.language === "de" ? "Übernommen von" : "Inherited from"} {source.name}</div>
          </div>
          <WorkspaceLink href={source.href} onNavigate={onNavigate}>{readOnly ? i18n.t("View in Parent") : i18n.t("Edit in Parent")}</WorkspaceLink>
        </div> : <p>{i18n.t("No parent authorization is configured.")}</p>)}
        {auth.type === 'none' && <p>{i18n.t("No authorization is configured.")}</p>}
        {auth.type === 'basic' && <>
          <label>{i18n.t("Username")}
            <input value={auth.username} disabled={disabled} onChange={event => onChange({ ...auth, username: event.target.value })} />
          </label>
          <label>{i18n.t("Password")}
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
