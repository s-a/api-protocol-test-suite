import { VscodeButton, VscodeTreeItem } from '@vscode-elements/react-elements'
import { useState } from 'react'
import { restoreClosedTreeItem, restoreOpenTreeItem, SidebarTree } from '../SidebarTree'
import type { Connection } from './profileTypes'

export function ProfileExplorer({ connections, selectedId, selectedAuthId, onSelect, onAdd, saving }: {
  connections: Connection[]
  selectedId: string
  selectedAuthId: string
  onSelect: (connectionId: string, authId?: string) => void
  onAdd: () => void
  saving: boolean
}) {
  const [initialSelectedId] = useState(selectedId)

  return (
    <aside className="sidebar" aria-label="Profile">
      <div className="profile-explorer-heading">
        <h2>Verbindungen</h2>
        <VscodeButton secondary disabled={saving} onClick={onAdd}>Neue Verbindung</VscodeButton>
      </div>
      {connections.length === 0 && <p>Keine Verbindungen vorhanden.</p>}
      <SidebarTree aria-label="Verbindungen und Anmeldungen"
        onVscTreeSelect={(event) => {
          // This version emits an array even though its declaration describes an object.
          const items = Array.isArray(event.detail) ? event.detail : event.detail.selectedItems
          const item = items[0]
          if (!saving && item?.dataset.connection) onSelect(item.dataset.connection, item.dataset.auth)
        }}>
        {connections.map((connection) => (
          <VscodeTreeItem key={connection.id} data-connection={connection.id}
            ref={initialSelectedId === connection.id ? restoreOpenTreeItem : restoreClosedTreeItem}
            selected={selectedId === connection.id && !selectedAuthId}
            className="connection-item">
            {connection.name || 'Neue Verbindung'}
            {connection.authProfiles.map((profile) => (
              <VscodeTreeItem key={profile.id} data-connection={connection.id} data-auth={profile.id}
                selected={selectedId === connection.id && selectedAuthId === profile.id}>
                {profile.name || 'Neue Anmeldung'}
              </VscodeTreeItem>
            ))}
          </VscodeTreeItem>
        ))}
      </SidebarTree>
    </aside>
  )
}
