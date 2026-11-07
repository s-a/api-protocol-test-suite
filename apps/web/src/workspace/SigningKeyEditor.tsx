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
      if (!response.ok) throw new Error(result.error || 'Could not access the signing key.')
      if (reveal) {
        setKey(result.key)
        setOrigin(result.origin)
        setMode('show')
      } else {
        close()
        setMessage('Signing key saved on the server.')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not access the signing key.')
    } finally {
      setBusy(false)
    }
  }

  const blocked = disabled || busy
  const named = /^[\w-]{1,128}$/.test(reference)
  return <div className="signing-key-editor">
    <div className="signing-key-actions">
      {!mode && <>
        <VscodeButton secondary disabled={blocked || !named} onClick={() => void access(true)}>Show key</VscodeButton>
        <VscodeButton secondary disabled={blocked || !named} onClick={() => { setError(''); setMessage(''); setMode('edit') }}>Set key</VscodeButton>
      </>}
      {mode === 'show' && <>
        <VscodeButton secondary disabled={blocked} onClick={() => setMode('edit')}>Edit key</VscodeButton>
        <VscodeButton secondary onClick={close}>Hide key</VscodeButton>
      </>}
    </div>
    {mode && <>
      <label>Target origin
        <input readOnly={mode === 'show'} disabled={blocked} value={origin} onChange={event => setOrigin(event.target.value)} placeholder="https://api.example.test" />
      </label>
      <label>Signing key
        <textarea readOnly={mode === 'show'} disabled={blocked} value={key} spellCheck={false} autoComplete="off"
          onChange={event => setKey(event.target.value)} />
      </label>
      {mode === 'edit' && <div className="signing-key-actions">
        <VscodeButton disabled={blocked || !origin.trim() || !key.trim()} onClick={() => void access(false)}>Save key</VscodeButton>
        <VscodeButton secondary disabled={busy} onClick={close}>Cancel</VscodeButton>
      </div>}
    </>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
