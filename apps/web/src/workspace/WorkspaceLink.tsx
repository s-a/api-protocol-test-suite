import type { ReactNode } from 'react'

export function WorkspaceLink({ href, onNavigate, children }: {
  href: string, onNavigate: (path: string) => void, children: ReactNode,
}) {
  return <a className="workspace-link" href={href} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onNavigate(href)
  }}>{children}</a>
}
