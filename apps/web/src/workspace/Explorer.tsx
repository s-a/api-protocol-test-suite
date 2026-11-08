import i18n from '../i18n'
import { VscodeButton, VscodeTreeItem } from '@vscode-elements/react-elements'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { restoreOpenTreeItem, SidebarTree } from '../SidebarTree'
import { moveSection, orderSections, readSectionOrder } from './section-order'
import { searchWorkspace } from './search'
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
  searchSource?: Workspace
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
      {item.name || i18n.t("Untitled")}
      {item.type === 'folder' && item.items.map(child =>
        <ItemBranch key={child.id} item={child} collectionId={collectionId} selection={selection} />,
      )}
    </VscodeTreeItem>
  )
}

export function Explorer({ workspace, searchSource, selection, onSelect, onAddCollection,
  onImport, onExport, exportCollections = [], dirty, disabled, sectionControls }: Props) {
  const directExport = exportCollections.length === 1 ? exportCollections[0] : undefined
  const exportLabel = directExport ? `${i18n.t("Export collection")}: ${directExport.name || i18n.t("Untitled collection")}` : i18n.t("Export collection")
  const exportTitle = exportCollections.length === 0 ? i18n.t("Save a collection in this section before exporting")
    : dirty ? exportLabel + (i18n.language === "de" ? " (gespeicherte Version)" : " (saved version)") : exportLabel
  const collectionsHeading = useId()
  const environmentsHeading = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const revealTarget = useRef<Selection | null>(null)
  const [menu, setMenu] = useState<{ x: number, y: number, actions: MenuAction[] }>()
  const orderKey = sectionControls?.orderKey
  const [order, setOrder] = useState(() => readSectionOrder(orderKey))
  const sections = orderSections(sectionControls?.sections ?? [], order)
  const draggedSection = useRef<string>(undefined)
  const [dropTarget, setDropTarget] = useState<{ id: string, after: boolean }>()
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchWorkspace(searchSource ?? workspace, query)
    .filter(result => sectionControls || !result.section), [searchSource, workspace, query, sectionControls])
  const searching = query.trim().length > 0

  useLayoutEffect(() => {
    const target = revealTarget.current
    if (searching || !target || !selection || target.kind !== selection.kind) return
    if (target.kind === 'environment') {
      if (selection.kind !== 'environment' || target.environmentId !== selection.environmentId) return
    } else if (selection.kind === 'environment' || target.collectionId !== selection.collectionId ||
      (target.kind === 'item' && (selection.kind !== 'item' || target.itemId !== selection.itemId))) return

    const items = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('vscode-tree-item') ?? [])
    const selected = target.kind === 'environment' ? undefined : items.find(item =>
      item.dataset.collection === target.collectionId &&
      (target.kind === 'item' ? item.dataset.item === target.itemId : !item.dataset.item))
    if (target.kind !== 'environment' && !selected) return
    for (const item of items) {
      if (!item.querySelector('vscode-tree-item')) continue
      const open = Boolean(selected && (item === selected || item.contains(selected)))
      ;(item as HTMLElement & { open: boolean }).open = open
    }
    revealTarget.current = null
    selected?.scrollIntoView({ block: 'nearest' })
  })

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
    const actions = [{ id: 'add', label: i18n.t("Add section"), run: sectionControls.onAdd }]
    if (section) {
      const index = sections.indexOf(section)
      const previous = sections[index - 1]
      const next = sections[index + 1]
      if (previous) actions.push({ id: 'up', label: i18n.t("Move up"), run: () => reorder(section.id, previous.id, false) })
      if (next) actions.push({ id: 'down', label: i18n.t("Move down"), run: () => reorder(section.id, next.id, true) })
      actions.push(
        { id: 'rename', label: i18n.t("Rename section"), run: () => sectionControls.onRename(section) },
        { id: 'delete', label: i18n.t("Delete section"), run: () => sectionControls.onDelete(section) },
      )
    }
    openMenu(event, actions)
  }

  function collectionMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, id: string) {
    const target = event.nativeEvent.composedPath().find(node =>
      node instanceof HTMLElement && node.localName === 'vscode-tree-item')
    if (!sectionControls || target !== event.currentTarget) return
    openMenu(event, sectionControls.sections.filter(section => section !== sectionControls.current).map(section => ({
      id: section.id, label: `${i18n.language === "de" ? "Verschieben nach" : "Move to"} ${section.name}`, run: () => sectionControls.onMoveCollection(id, section.id),
    })))
  }

  const contents = <>
      <section aria-labelledby={collectionsHeading}>
        <div className="explorer-heading">
          <h2 id={collectionsHeading}><svg className="explorer-heading-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 13a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 16 13V6a1.5 1.5 0 0 0-1.5-1.5h-13A1.5 1.5 0 0 0 0 6zM2 3a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 0-1h-11A.5.5 0 0 0 2 3m2-2a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 0-1h-7A.5.5 0 0 0 4 1" /></svg>{i18n.t("Collections")}</h2>
          <div className="explorer-actions">
            {onAddCollection && <VscodeButton secondary aria-label={i18n.t("Add collection")} title={i18n.t("Add collection")} disabled={disabled} onClick={onAddCollection}>+</VscodeButton>}
            {onImport && <VscodeButton secondary aria-label={i18n.t("Import")}
              title={dirty ? i18n.t("Save or discard changes before importing") : i18n.t("Import")}
              disabled={disabled || dirty} onClick={onImport}>
              <TransferIcon direction="in" />
            </VscodeButton>}
            {onExport && <VscodeButton secondary aria-label={exportLabel} title={exportTitle}
              disabled={disabled || exportCollections.length === 0}
              onClick={event => {
                if (directExport) onExport(directExport.id)
                else openMenu(event, exportCollections.map(({ id, name }) => ({
                  id, label: name || i18n.t("Untitled collection"), run: () => onExport(id),
                })))
              }}>
              <TransferIcon direction="out" />
            </VscodeButton>}
          </div>
        </div>
        {workspace.collections.length === 0 && <p className="explorer-empty">{i18n.t("No collections")}</p>}
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
              {collection.name || i18n.t("Untitled collection")}
              {collection.items.map(item => (
                <ItemBranch key={item.id} item={item} collectionId={collection.id} selection={selection} />
              ))}
            </VscodeTreeItem>
          ))}
        </SidebarTree>
      </section>
      <section aria-labelledby={environmentsHeading}>
        <div className="explorer-heading">
          <h2 id={environmentsHeading}><svg className="explorer-heading-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" /></svg>{i18n.t("Environment")}</h2>
        </div>
        {workspace.environments.length === 0 && <p className="explorer-empty">{i18n.t("No environment")}</p>}
        <ul className="environment-list">
          {workspace.environments.map(environment => (
            <li key={environment.id}>
              <button type="button" aria-current={selection?.kind === 'environment' && selection.environmentId === environment.id}
                onClick={() => onSelect({ kind: 'environment', environmentId: environment.id })}>
                <span className="environment-name">{environment.name || i18n.t("Untitled environment")}</span>
                {environment.id === workspace.activeEnvironmentId && <span className="active-indicator">{i18n.t("Active")}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
  </>

  return (
    <aside ref={sidebarRef} className="sidebar workspace-explorer" aria-label={i18n.t("Workspace explorer")}>
      <div className="workspace-search">
        <svg className="workspace-search-icon" aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
        <input type="search" value={query} autoComplete="off" spellCheck={false}
          aria-label={i18n.language === 'de' ? 'Arbeitsbereich durchsuchen' : 'Search workspace'}
          placeholder={i18n.language === 'de' ? 'Arbeitsbereich durchsuchen…' : 'Search workspace…'}
          onChange={event => setQuery(event.target.value)} />
      </div>
      {searching ? <div className="workspace-search-results" aria-live="polite">
        <p className="workspace-search-count">{results.length === 0 ? (i18n.language === 'de' ? 'Keine Treffer' : 'No results')
          : i18n.language === 'de' ? `${results.length} Treffer` : `${results.length} results`}</p>
        <ul>{results.slice(0, 50).map((result, index) => <li key={index}>
          <button type="button" disabled={disabled} onClick={() => {
            if (result.selection) {
              revealTarget.current = result.selection
              onSelect(result.selection)
            } else if (result.section) {
              const { collectionIds, environmentId } = result.section
              revealTarget.current = collectionIds.length ? { kind: 'collection', collectionId: collectionIds[0] }
                : environmentId ? { kind: 'environment', environmentId } : null
              sectionControls?.onOpen(result.section)
            }
            setQuery('')
          }}>
            <span className="workspace-search-name">{result.name || i18n.t('Untitled')}</span>
            {result.path && <small>{result.path}</small>}
          </button>
        </li>)}</ul>
        {results.length > 50 && <p>{i18n.language === 'de' ? 'Die ersten 50 Treffer werden angezeigt.' : 'Showing the first 50 results.'}</p>}
      </div> : sectionControls ? (
        sections.length ? <ul className="workspace-sections" aria-label={i18n.t("Workspace sections")}>
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
              <svg className="workspace-section-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 7H5A2 2 0 0 0 3 9V17H5V13H7V17H9V9A2 2 0 0 0 7 7M7 11H5V9H7M14 7H10V17H12V13H14A2 2 0 0 0 16 11V9A2 2 0 0 0 14 7M14 11H12V9H14M20 9V15H21V17H17V15H18V9H17V7H21V9Z" />
              </svg>
              {section.name}
            </button>
            {section === sectionControls.current && <div className="workspace-section-contents">{contents}</div>}
          </li>)}
        </ul> : <p className="explorer-empty" tabIndex={0}
          onContextMenu={event => sectionMenu(event)} onKeyDown={event => sectionMenu(event)}>
          {i18n.t("No sections. Right-click here to add one.")}
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
