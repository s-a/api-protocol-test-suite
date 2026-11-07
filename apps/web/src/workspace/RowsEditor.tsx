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
          <thead><tr><th scope="col">Enabled</th><th scope="col">{keyLabel}</th><th scope="col">Value</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="rows-empty">No entries yet.</td></tr>}
            {rows.map((row, index) => (
              <tr key={row.id}>
                <td><input type="checkbox" aria-label={`Enable row ${index + 1}`} disabled={disabled}
                  checked={row.enabled} onChange={event => edit(row, { enabled: event.target.checked })} /></td>
                {(['key', 'value'] as const).map(field => {
                  const fieldLabel = field === 'key' ? keyLabel : 'Value'
                  const Field = wrapFields ? 'textarea' : 'input'
                  return <td key={field}><Field aria-label={`${fieldLabel} ${index + 1}`} placeholder={fieldLabel} disabled={disabled}
                    value={row[field]} onChange={event => edit(row, { [field]: event.target.value.replace(/[\r\n]/g, '') })} />
                    {field === 'value' && wrapFields && [...row.value.matchAll(/\{\{([^{}]+)\}\}/g)].some(match => isDynamicReference(match[1])) &&
                      <div className="dynamic-header-help">Dynamic variable · Resolved on Send</div>}
                  </td>
                })}
                <td><VscodeButton secondary aria-label={`Delete ${keyLabel.toLowerCase()} ${index + 1}`} disabled={disabled}
                  onClick={() => onChange(rows.filter(candidate => candidate.id !== row.id))}>Delete</VscodeButton></td>
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
