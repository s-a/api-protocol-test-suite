import { translateError } from '../i18n'
import i18n from '../i18n'
import { fetchApp } from '../app-api'
import { VscodeButton } from '@vscode-elements/react-elements'
import { useState } from 'react'
import type { JwtSettings } from '../../../server/jwt-settings.ts'

export function SigningKeyEditor({ reference, algorithm, baseUrl, disabled }: {
  reference: string, algorithm: JwtSettings['algorithm'], baseUrl?: string, disabled: boolean,
}) {
  const [mode, setMode] = useState<'show' | 'edit'>()
  const [key, setKey] = useState('')
  const [origin, setOrigin] = useState(() => {
    try { return new URL(baseUrl ?? '').origin } catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  function close() {
    setKey('')
    setMode(undefined)
  }

  async function access(reveal: boolean) {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const response = await fetchApp(reveal ? '/api/jwt-keys/reveal' : '/api/jwt-keys', {
        method: reveal ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reveal ? { reference } : { reference, origin, algorithm, key }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || i18n.t("Could not access the signing key."))
      if (reveal) {
        setKey(result.key)
        setOrigin(result.origin)
        setMode('show')
      } else {
        close()
        setMessage(i18n.t("Signing key saved on the server."))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : i18n.t("Could not access the signing key."))
    } finally {
      setBusy(false)
    }
  }

  const blocked = disabled || busy
  const named = /^[\w-]{1,128}$/.test(reference)
  return <div className="signing-key-editor">
    <div className="signing-key-actions">
      {!mode && <>
        <VscodeButton secondary disabled={blocked || !named} onClick={() => void access(true)}>{i18n.t("Show key")}</VscodeButton>
        <VscodeButton secondary disabled={blocked || !named} onClick={() => { setError(''); setMessage(''); setMode('edit') }}>{i18n.t("Set key")}</VscodeButton>
      </>}
      {mode === 'show' && <>
        <VscodeButton secondary disabled={blocked} onClick={() => setMode('edit')}>{i18n.t("Edit key")}</VscodeButton>
        <VscodeButton secondary onClick={close}>{i18n.t("Hide key")}</VscodeButton>
      </>}
    </div>
    {mode && <>
      <label>{i18n.t("Target origin")}
        <input readOnly={mode === 'show'} disabled={blocked} value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://api.example.test" />
      </label>
      <label>{i18n.t("Signing key")}
        <textarea readOnly={mode === 'show'} disabled={blocked} value={key} spellCheck={false} autoComplete="off"
          onChange={event => setKey(event.target.value)} />
      </label>
      {mode === 'edit' && <div className="signing-key-actions">
        <VscodeButton disabled={blocked || !origin.trim() || !key.trim()} onClick={() => void access(false)}>{i18n.t("Save key")}</VscodeButton>
        <VscodeButton secondary disabled={busy} onClick={close}>{i18n.t("Cancel")}</VscodeButton>
      </div>}
    </>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{translateError(error)}</p>}
  </div>
}
