import { useEffect, useRef, useState } from 'react'
import { App } from './App'
import { appTabId } from './app-api'

type Access = 'checking' | 'active' | 'occupied' | 'unavailable'
const endpoint = '/api/app-tab'

export function AppTab() {
  const [access, setAccess] = useState<Access>('checking')
  const [accountId, setAccountId] = useState<string | null>(null)
  const workbench = useRef<HTMLDivElement>(null)
  const takeOver = useRef<() => void>(undefined)

  useEffect(() => {
    if (access !== 'active') {
      workbench.current?.querySelectorAll('dialog[open]').forEach(dialog => (dialog as HTMLDialogElement).close())
      workbench.current?.querySelectorAll<HTMLElement>(':popover-open').forEach(popover => popover.hidePopover())
    }
  }, [access])

  useEffect(() => {
    const headers = { 'App-Tab-Id': appTabId }
    let paused = false
    let claimed = false
    let timer: number | undefined
    let pending: AbortController | undefined

    async function check(method = claimed ? 'PATCH' : 'PUT') {
      if (paused || pending) return
      window.clearTimeout(timer)
      const controller = new AbortController()
      pending = controller
      let next: Access = 'unavailable'
      let nextAccountId = ''
      try {
        const response = await fetch(endpoint, {
          method, headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        })
        if (response.status === 401) window.location.reload()
        if (response.status === 204) {
          next = 'active'
          nextAccountId = response.headers.get('App-Account-Id') ?? ''
        }
        if (response.status === 409) next = 'occupied'
      } catch {
        // Retry after temporary network failures.
      } finally {
        if (pending === controller) {
          pending = undefined
          setAccess(next)
          if (next === 'active') {
            claimed = true
            setAccountId(nextAccountId)
          }
          if (next !== 'occupied' || !claimed) {
            timer = window.setTimeout(() => void check(), next === 'active' ? 10_000 : 4000)
          }
        }
      }
    }

    function stop() {
      paused = true
      window.clearTimeout(timer)
      pending?.abort()
      pending = undefined
    }

    function hide() {
      stop()
      void fetch(endpoint, { method: 'DELETE', headers, keepalive: true }).catch(() => {})
    }

    function show(event: PageTransitionEvent) {
      if (!event.persisted) return
      setAccess('checking')
      paused = false
      claimed = false
      void check()
    }

    function checkWhenVisible() {
      if (!document.hidden) void check()
    }

    takeOver.current = () => {
      if (paused) return
      pending?.abort()
      pending = undefined
      setAccess('checking')
      void check('POST')
    }
    void check()
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    document.addEventListener('visibilitychange', checkWhenVisible)
    return () => {
      stop()
      takeOver.current = undefined
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
      document.removeEventListener('visibilitychange', checkWhenVisible)
    }
  }, [])

  return <>
    {access !== 'active' && <main className="empty-view" role="status">
      {access === 'occupied' ? <>
        <h1>App access paused</h1>
        <p>Another tab may still have access to this account. Open anyway to continue here and block that tab.</p>
        <button type="button" onClick={() => takeOver.current?.()}>Open anyway</button>
      </> : <p>{access === 'unavailable' ? 'The server is unavailable. Retrying…' : 'Checking app access…'}</p>}
    </main>}
    {accountId !== null && <div ref={workbench} hidden={access !== 'active'} inert={access !== 'active'}>
      <App key={accountId} accountId={accountId} />
    </div>}
  </>
}
