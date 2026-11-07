import { fetchApp } from '../app-api'
import { useEffect, useState } from 'react'
import { VscodeButton } from '@vscode-elements/react-elements'
import { ProfileExplorer } from './ProfileExplorer'

import type { Connection, ProfileDocument } from './profileTypes'
import { AuthFields, ConnectionFields } from './ProfileFields'

function newId() {
  return crypto.getRandomValues(new Uint32Array(4)).join('-')
}

async function requestProfiles(options: RequestInit): Promise<ProfileDocument> {
  const response = await fetchApp('/api/profiles', options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Die Profildaten konnten nicht geladen werden.')
  return data
}

export function Profiles() {
  const [saved, setSaved] = useState<ProfileDocument>()
  const [draft, setDraft] = useState<ProfileDocument>()
  const [selectedId, setSelectedId] = useState('')
  const [selectedAuthId, setSelectedAuthId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    requestProfiles({ signal: controller.signal }).then((data) => {
      setSaved(data)
      setDraft(data)
      setSelectedId(data.connections[0]?.id ?? '')
    }).catch(() => {
      if (!controller.signal.aborted) setError('Die Profile konnten nicht geladen werden.')
    })
    return () => controller.abort()
  }, [])

  if (!draft) return <main><p role={error ? 'alert' : 'status'}>{error || 'Profile werden geladen …'}</p></main>

  const activeDraft = draft
  const connection = draft.connections.find((item) => item.id === selectedId)
  const authProfile = connection?.authProfiles.find((item) => item.id === selectedAuthId)

  function select(connectionId: string, authId = '') {
    setSelectedId(connectionId)
    setSelectedAuthId(authId)
  }

  function changeConnections(connections: Connection[]) {
    setDraft({ ...activeDraft, connections })
    setMessage('')
  }

  function changeConnection(updated: Connection) {
    changeConnections(activeDraft.connections.map((item) => item.id === updated.id ? updated : item))
  }

  function addConnection() {
    const id = newId()
    changeConnections([...activeDraft.connections, { id, name: '', baseUrl: '', authProfiles: [] }])
    select(id)
  }

  function addAuthProfile(parent: Connection) {
    const id = newId()
    changeConnection({
      ...parent,
      authProfiles: [...parent.authProfiles, { id, name: '', type: 'bearer', secretVariable: '' }],
    })
    select(parent.id, id)
  }

  async function save() {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const data = await requestProfiles({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(activeDraft),
        signal: AbortSignal.timeout(10000),
      })
      setSaved(data)
      setDraft(data)
      setMessage('Profile gespeichert.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Die Profile konnten nicht gespeichert werden.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <ProfileExplorer connections={draft.connections} selectedId={selectedId}
        selectedAuthId={selectedAuthId} onSelect={select} onAdd={addConnection} saving={saving} />
      <main>
        <p className="profile-kind">{authProfile ? `Anmeldung für ${connection?.name || 'neue Verbindung'}` : 'Verbindung'}</p>
        <h1>{authProfile ? authProfile.name || 'Neue Anmeldung' : connection ? connection.name || 'Neue Verbindung' : 'Verbindungen'}</h1>
        <form className="profiles" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <fieldset disabled={saving} className="profile-editor">
            <legend>{authProfile ? 'Anmeldedaten' : 'Verbindungsdaten'}</legend>
            {connection && authProfile && (
              <AuthFields profile={authProfile} onChange={(updated) => changeConnection({
                ...connection,
                authProfiles: connection.authProfiles.map((item) => item.id === updated.id ? updated : item),
              })} />
            )}
            {connection && !authProfile && (
              <>
                <ConnectionFields connection={connection} onChange={changeConnection} />
                <p>Wähle links eine Anmeldung aus oder füge eine neue hinzu.</p>
                <VscodeButton type="button" secondary disabled={saving} onClick={() => addAuthProfile(connection)}>
                  Neue Anmeldung
                </VscodeButton>
              </>
            )}
            {!connection && <p>Lege links eine Verbindung an, um ihre Basis-URL und Anmeldungen zu verwalten.</p>}
          </fieldset>
          <div className="profile-actions">
            <VscodeButton disabled={saving || saved === draft} type="submit">
              {saving ? 'Speichert …' : 'Profile speichern'}
            </VscodeButton>
            <VscodeButton secondary disabled={saving || saved === draft} type="button" onClick={() => {
              setDraft(saved)
              select(saved?.connections[0]?.id ?? '')
              setError('')
              setMessage('')
            }}>Änderungen verwerfen</VscodeButton>
            {connection && (
              <VscodeButton secondary disabled={saving} type="button" onClick={() => {
                if (authProfile) {
                  changeConnection({ ...connection, authProfiles: connection.authProfiles.filter((item) => item.id !== authProfile.id) })
                  select(connection.id)
                } else {
                  const remaining = draft.connections.filter((item) => item.id !== connection.id)
                  changeConnections(remaining)
                  select(remaining[0]?.id ?? '')
                }
              }}>{authProfile ? 'Anmeldung entfernen' : 'Verbindung entfernen'}</VscodeButton>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
        </form>
      </main>
    </>
  )
}
