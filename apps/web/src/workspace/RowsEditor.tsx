import i18n from '../i18n'
import { VscodeButton } from '@vscode-elements/react-elements'
import { isDynamicReference } from '../../../server/dynamic-variables.ts'
import type { Row } from './types'
import { newId } from './id'

export function RowsEditor({ label, keyLabel, addLabel, rows, onChange, disabled, wrapFields }: {
  label: string
  keyLabel: string
  addLabel: string
  rows: Row[]
  onChange: (rows: Row[]) => void
  disabled: boolean
  wrapFields?: boolean
}) {
  function edit(row: Row, change: Partial<Row>) {
    onChange(rows.map(candidate => candidate.id === row.id ? { ...candidate, ...change } : candidate))
  }

  return (
    <div className="rows-editor">
      <h2>{label}</h2>
      <div className="rows-table">
        <table aria-label={label}>
          <thead><tr><th scope="col">{i18n.t("Enabled")}</th><th scope="col">{keyLabel}</th><th scope="col">{i18n.t("Value")}</th><th scope="col">{i18n.t("Actions")}</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="rows-empty">{i18n.t("No entries yet.")}</td></tr>}
            {rows.map((row, index) => (
              <tr key={row.id}>
                <td><input type="checkbox" aria-label={`${i18n.language === "de" ? "Zeile aktivieren" : "Enable row"} ${index + 1}`} disabled={disabled}
                  checked={row.enabled} onChange={event => edit(row, { enabled: event.target.checked })} /></td>
                {(['key', 'value'] as const).map(field => {
                  const fieldLabel = field === 'key' ? keyLabel : i18n.t("Value")
                  const Field = wrapFields ? 'textarea' : 'input'
                  return <td key={field}><Field aria-label={`${fieldLabel} ${index + 1}`} placeholder={fieldLabel} disabled={disabled}
                    value={row[field]} onChange={event => edit(row, { [field]: event.target.value.replace(/[\r\n]/g, '') })} />
                    {field === 'value' && wrapFields && [...row.value.matchAll(/\{\{([^{}]+)\}\}/g)].some(match => isDynamicReference(match[1])) &&
                      <div className="dynamic-header-help">{i18n.t("Dynamic variable · Resolved on Send")}</div>}
                  </td>
                })}
                <td><button type="button" className="row-delete" title={i18n.t("Delete")}
                  aria-label={`${i18n.language === 'de' ? 'Löschen' : 'Delete'} ${keyLabel.toLowerCase()} ${index + 1}`} disabled={disabled}
                  onClick={() => onChange(rows.filter(candidate => candidate.id !== row.id))}>
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                  </svg>
                </button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <VscodeButton secondary disabled={disabled}
        onClick={() => onChange([...rows, { id: newId(), key: '', value: '', enabled: true }])}>
        {addLabel}
      </VscodeButton>
    </div>
  )
}
