import { VscodeButton } from '@vscode-elements/react-elements'
import { useEffect, useRef, useState } from 'react'

export function ImportDialog({ onImport, onClose }: { onImport: (source: File | string) => void, onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')

  useEffect(() => { dialog.current?.showModal() }, [])

  return <dialog ref={dialog} className="import-dialog" aria-labelledby="import-title" onClose={onClose}>
    <header className="editor-toolbar">
      <h2 id="import-title">Import</h2>
      <VscodeButton secondary onClick={() => dialog.current?.close()}>Close</VscodeButton>
    </header>
    <div className="import-options">
      <input ref={fileInput} type="file" accept=".zip,.wsdl,.xml" hidden onChange={event => {
        const file = event.currentTarget.files?.[0]
        if (file) onImport(file)
      }} />
      <div>
        <VscodeButton secondary onClick={() => fileInput.current?.click()}>Select file</VscodeButton>
        <p>Choose a WSDL file or a collection ZIP.</p>
      </div>
      <form onSubmit={event => { event.preventDefault(); if (url.trim()) onImport(url.trim()) }}>
        <label htmlFor="import-wsdl-url">WSDL URL</label>
        <input id="import-wsdl-url" type="url" value={url} onChange={event => setUrl(event.target.value)}
          placeholder="https://example.com/service?WSDL" required />
        <VscodeButton type="submit" disabled={!url.trim()}>Import</VscodeButton>
      </form>
    </div>
  </dialog>
}
