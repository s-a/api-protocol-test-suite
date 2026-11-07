import { VscodeTree } from '@vscode-elements/react-elements'
import type { VscodeTreeItem } from '@vscode-elements/react-elements'
import { useLayoutEffect, useRef } from 'react'
import type { ComponentProps, ComponentRef } from 'react'

type TreeItem = ComponentRef<typeof VscodeTreeItem>

function storageKey(item: HTMLElement) {
  const { collection, item: itemId, connection, auth } = item.dataset
  const path = collection ? ['collection', collection, itemId] : ['connection', connection, auth]
  return `api-protocol-test-suite:sidebar:${JSON.stringify(path)}`
}

function restoreOpenState(item: TreeItem | null, defaultOpen: boolean) {
  if (!item) return
  let saved: string | null = null
  try {
    saved = localStorage.getItem(storageKey(item))
  } catch {
    // The tree remains usable when browser storage is unavailable.
  }
  item.open = saved === null ? defaultOpen : saved === 'true'
}

export function restoreOpenTreeItem(item: TreeItem | null) {
  restoreOpenState(item, true)
}

export function restoreClosedTreeItem(item: TreeItem | null) {
  restoreOpenState(item, false)
}

function observeOpenState(tree: ComponentRef<typeof VscodeTree> | null) {
  if (!tree) return
  const observer = new MutationObserver(changes => {
    for (const { target } of changes) {
      if (!(target instanceof HTMLElement) || !target.matches('vscode-tree-item')) continue
      try {
        localStorage.setItem(storageKey(target), String(target.hasAttribute('open')))
      } catch {
        // The tree remains usable when browser storage is unavailable.
      }
    }
  })
  observer.observe(tree, { subtree: true, attributeFilter: ['open'] })
  return () => observer.disconnect()
}

export function SidebarTree(props: ComponentProps<typeof VscodeTree>) {
  const tree = useRef<ComponentRef<typeof VscodeTree>>(null)
  useLayoutEffect(() => observeOpenState(tree.current), [])
  return <VscodeTree {...props} ref={tree} expandMode="singleClick" indentGuides="always" />
}
