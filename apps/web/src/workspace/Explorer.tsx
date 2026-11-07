import { VscodeButton, VscodeTreeItem } from '@vscode-elements/react-elements'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { restoreOpenTreeItem, SidebarTree } from '../SidebarTree'
import { moveSection, orderSections, readSectionOrder } from './section-order'
import type { Collection, CollectionItem, Selection, Workspace, WorkspaceSection } from './types'

type MenuAction = { id: string, label: string, run: () => void }
type SectionControls = {
  current?: WorkspaceSection
  sections: WorkspaceSection[]
  orderKey?: string
  onOpen: (section: WorkspaceSection) => void
  onAdd: () => void
  onRename: (section: WorkspaceSection) => void
  onDelete: (section: WorkspaceSection) => void
  onMoveCollection: (collectionId: string, destinationId: string) => void
}

type Props = {
  workspace: Workspace
  selection: Selection | null
  onSelect: (selection: Selection) => void
  onAddCollection?: () => void
  onImport?: () => void
  onExport?: (collectionId: string) => void
  exportCollections?: Collection[]
  dirty?: boolean
  disabled?: boolean
  sectionControls?: SectionControls
}

function TransferIcon({ direction }: { direction: 'in' | 'out' }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2.5 10v3.5h11V10" />
    <path d={direction === 'in' ? 'M8 2v8m-3-3 3 3 3-3' : 'M8 10V2m-3 3 3-3 3 3'} />
  </svg>
}

function ItemBranch({ item, collectionId, selection }: {
  item: CollectionItem
  collectionId: string
  selection: Selection | null
}) {
  return (
    <VscodeTreeItem data-collection={collectionId} data-item={item.id}
      aria-label={item.type === 'request' ? `${item.method} ${item.name}` : item.name}
      ref={item.type === 'folder' ? restoreOpenTreeItem : undefined}
      selected={selection?.kind === 'item' && selection.collectionId === collectionId && selection.itemId === item.id}>
      {item.type === 'request' && <span className="method-label" data-method={item.method}>{item.method}</span>}
      {item.name || 'Untitled'}
      {item.type === 'folder' && item.items.map(child =>
        <ItemBranch key={child.id} item={child} collectionId={collectionId} selection={selection} />,
      )}
    </VscodeTreeItem>
  )
}

export function Explorer({ workspace, selection, onSelect, onAddCollection,
  onImport, onExport, exportCollections = [], dirty, disabled, sectionControls }: Props) {
  const directExport = exportCollections.length === 1 ? exportCollections[0] : undefined
  const exportLabel = directExport ? `Export collection: ${directExport.name || 'Untitled collection'}` : 'Export collection'
  const exportTitle = exportCollections.length === 0 ? 'Save a collection in this section before exporting'
    : dirty ? exportLabel + ' (saved version)' : exportLabel
  const collectionsHeading = useId()
  const environmentsHeading = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number, y: number, actions: MenuAction[] }>()
  const orderKey = sectionControls?.orderKey
  const [order, setOrder] = useState(() => readSectionOrder(orderKey))
  const sections = orderSections(sectionControls?.sections ?? [], order)
  const draggedSection = useRef<string>(undefined)
  const [dropTarget, setDropTarget] = useState<{ id: string, after: boolean }>()

  function reorder(source: string, target: string, after: boolean) {
    const ids = sections.map(({ id }) => id)
    const next = moveSection(ids, source, target, after)
    if (next === ids) return
    setOrder(next)
    try {
      if (orderKey) localStorage.setItem(orderKey, JSON.stringify(next))
    } catch {
      // The order still applies for the current page.
    }
  }

  function dropPosition(event: DragEvent<HTMLButtonElement>) {
    const row = event.currentTarget.getBoundingClientRect()
    return event.clientY >= row.top + row.height / 2
  }

  function clearDrag() {
    draggedSection.current = undefined
    setDropTarget(undefined)
  }

  useLayoutEffect(() => {
    const panel = menuRef.current
    if (!menu || !panel) return
    panel.showPopover()
    const { width, height } = panel.getBoundingClientRect()
    panel.style.left = Math.max(0, Math.min(menu.x, window.innerWidth - width)) + 'px'
    panel.style.top = Math.max(0, Math.min(menu.y, window.innerHeight - height)) + 'px'
    panel.querySelector('button')?.focus()
  }, [menu])

  function openMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, actions: MenuAction[]) {
    if (disabled || !actions.length) return
    if ('key' in event && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    const anchor = event.currentTarget.getBoundingClientRect()
    const [x, y] = 'clientX' in event ? [event.clientX, event.clientY] : [anchor.left, anchor.bottom]
    setMenu({ x, y, actions })
  }

  function sectionMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, section?: WorkspaceSection) {
    if (!sectionControls) return
    const actions = [{ id: 'add', label: 'Add section', run: sectionControls.onAdd }]
    if (section) {
      const index = sections.indexOf(section)
      const previous = sections[index - 1]
      const next = sections[index + 1]
      if (previous) actions.push({ id: 'up', label: 'Move up', run: () => reorder(section.id, previous.id, false) })
      if (next) actions.push({ id: 'down', label: 'Move down', run: () => reorder(section.id, next.id, true) })
      actions.push(
        { id: 'rename', label: 'Rename section', run: () => sectionControls.onRename(section) },
        { id: 'delete', label: 'Delete section', run: () => sectionControls.onDelete(section) },
      )
    }
    openMenu(event, actions)
  }

  function collectionMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, id: string) {
    const target = event.nativeEvent.composedPath().find(node =>
      node instanceof HTMLElement && node.localName === 'vscode-tree-item')
    if (!sectionControls || target !== event.currentTarget) return
    openMenu(event, sectionControls.sections.filter(section => section !== sectionControls.current).map(section => ({
      id: section.id, label: `Move to ${section.name}`, run: () => sectionControls.onMoveCollection(id, section.id),
    })))
  }

  const contents = <>
      <section aria-labelledby={collectionsHeading}>
        <div className="explorer-heading">
          <h2 id={collectionsHeading}>Collections</h2>
          <div className="explorer-actions">
            {onAddCollection && <VscodeButton secondary aria-label="Add collection" title="Add collection" disabled={disabled} onClick={onAddCollection}>+</VscodeButton>}
            {onImport && <VscodeButton secondary aria-label="Import"
              title={dirty ? 'Save or discard changes before importing' : 'Import'}
              disabled={disabled || dirty} onClick={onImport}>
              <TransferIcon direction="in" />
            </VscodeButton>}
            {onExport && <VscodeButton secondary aria-label={exportLabel} title={exportTitle}
              disabled={disabled || exportCollections.length === 0}
              onClick={event => {
                if (directExport) onExport(directExport.id)
                else openMenu(event, exportCollections.map(({ id, name }) => ({
                  id, label: name || 'Untitled collection', run: () => onExport(id),
                })))
              }}>
              <TransferIcon direction="out" />
            </VscodeButton>}
          </div>
        </div>
        {workspace.collections.length === 0 && <p className="explorer-empty">No collections</p>}
        <SidebarTree aria-labelledby={collectionsHeading}
          onVscTreeSelect={event => {
            const items = Array.isArray(event.detail) ? event.detail : event.detail.selectedItems
            const item = items[0]
            if (item?.dataset.collection) {
              const { collection: collectionId, item: itemId } = item.dataset
              onSelect(itemId ? { kind: 'item', collectionId, itemId } : { kind: 'collection', collectionId })
            }
          }}>
          {workspace.collections.map(collection => (
            <VscodeTreeItem key={collection.id} data-collection={collection.id} aria-label={collection.name} ref={restoreOpenTreeItem}
              onContextMenu={event => collectionMenu(event, collection.id)} onKeyDown={event => collectionMenu(event, collection.id)}
              selected={selection?.kind === 'collection' && selection.collectionId === collection.id}>
              {collection.name || 'Untitled collection'}
              {collection.items.map(item => (
                <ItemBranch key={item.id} item={item} collectionId={collection.id} selection={selection} />
              ))}
            </VscodeTreeItem>
          ))}
        </SidebarTree>
      </section>
      <section aria-labelledby={environmentsHeading}>
        <div className="explorer-heading">
          <h2 id={environmentsHeading}>Environment</h2>
        </div>
        {workspace.environments.length === 0 && <p className="explorer-empty">No environment</p>}
        <ul className="environment-list">
          {workspace.environments.map(environment => (
            <li key={environment.id}>
              <button type="button" aria-current={selection?.kind === 'environment' && selection.environmentId === environment.id}
                onClick={() => onSelect({ kind: 'environment', environmentId: environment.id })}>
                <span className="environment-name">{environment.name || 'Untitled environment'}</span>
                {environment.id === workspace.activeEnvironmentId && <span className="active-indicator">Active</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
  </>

  return (
    <aside className="sidebar workspace-explorer" aria-label="Workspace explorer">
      {sectionControls ? (
        sections.length ? <ul className="workspace-sections" aria-label="Workspace sections">
          {sections.map(section => <li key={section.id}>
            <button type="button" className="workspace-section-row" disabled={disabled}
              aria-current={section === sectionControls.current}
              draggable={!disabled && sections.length > 1}
              data-drop={dropTarget?.id === section.id ? (dropTarget.after ? 'after' : 'before') : undefined}
              onDragStart={event => {
                draggedSection.current = section.id
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('application/x-workspace-section', section.id)
              }}
              onDragOver={event => {
                if (disabled || !draggedSection.current || draggedSection.current === section.id) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const after = dropPosition(event)
                if (dropTarget?.id !== section.id || dropTarget.after !== after) setDropTarget({ id: section.id, after })
              }}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={event => {
                const source = draggedSection.current
                if (disabled || !source) return
                event.preventDefault()
                reorder(source, section.id, dropPosition(event))
                clearDrag()
              }}
              onDragEnd={clearDrag}
              onClick={() => sectionControls.onOpen(section)}
              onContextMenu={event => sectionMenu(event, section)} onKeyDown={event => sectionMenu(event, section)}>
              {section.name}
            </button>
            {section === sectionControls.current && <div className="workspace-section-contents">{contents}</div>}
          </li>)}
        </ul> : <p className="explorer-empty" tabIndex={0}
          onContextMenu={event => sectionMenu(event)} onKeyDown={event => sectionMenu(event)}>
          No sections. Right-click here to add one.
        </p>
      ) : contents}
      {menu && <div ref={menuRef} className="workspace-context-menu" popover="auto"
        onToggle={event => { if (event.newState === 'closed') setMenu(undefined) }}>
        {menu.actions.map(action => <button type="button" key={action.id} disabled={disabled} onClick={() => {
          menuRef.current?.hidePopover()
          action.run()
        }}>{action.label}</button>)}
      </div>}
    </aside>
  )
}
