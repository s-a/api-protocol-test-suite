import i18n from '../i18n'
import { VscodeButton } from '@vscode-elements/react-elements'
import { useEffect, useRef } from 'react'

export function ExportDialog({ name, onClose, onConfirm }: { name: string, onClose: () => void, onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => { dialog.current?.showModal() }, [])

  return <dialog ref={dialog} className="export-dialog" role="alertdialog"
    aria-labelledby="export-title" aria-describedby="export-target export-warning" onClose={onClose}>
    <h2 id="export-title">{i18n.t("Exported data may contain secrets")}</h2>
    <p id="export-target">{i18n.language === "de" ? `„${name}“ wird exportiert.` : `You are about to export “${name}”.`}</p>
    <p id="export-warning">
      {i18n.language === 'de' ? 'Die exportierten Daten können Passwörter, API-Schlüssel oder andere vertrauliche Informationen enthalten. Die Daten vor der Weitergabe prüfen und den Export nur an berechtigte Empfänger weitergeben.' : 'The exported data may contain passwords, API keys, or other confidential information. Review the data before sharing it. You are responsible for sharing the export only with authorized recipients.'}
    </p>
    <div className="export-actions">
      <VscodeButton secondary autoFocus onClick={() => dialog.current?.close()}>{i18n.t("Cancel")}</VscodeButton>
      <VscodeButton onClick={() => {
        if (!dialog.current?.open) return
        dialog.current.close()
        onConfirm()
      }}>{i18n.t("Export")}</VscodeButton>
    </div>
  </dialog>
}
