import i18n from '../i18n'
import { useEffect, useEffectEvent, useId, useRef } from 'react'
import { editor, languages } from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/edcore.main.js'
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker'
import type { BodyFormat } from '../../../server/body-format.ts'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    return label === 'json' ? new JsonWorker() : new EditorWorker()
  },
}

function applyEditorTheme() {
  const style = getComputedStyle(document.documentElement)
  const color = (name: string) => {
    const value = style.getPropertyValue(name).trim()
    return /^#[\da-f]{3,4}$/i.test(value)
      ? '#' + [...value.slice(1)].map(digit => digit + digit).join('')
      : value
  }
  editor.defineTheme('workspace-theme', {
    base: style.colorScheme.includes('light') && !style.colorScheme.includes('dark') ? 'vs' : 'vs-dark',
    inherit: true, rules: [],
    colors: {
      'editor.background': color('--vscode-editor-background'),
      'editor.foreground': color('--vscode-foreground'),
      'editorLineNumber.foreground': color('--editor-line-number'),
      'editorLineNumber.activeForeground': color('--vscode-foreground'),
      'editorWidget.background': color('--editor-widget-background'),
    },
  })
  editor.setTheme('workspace-theme')
}

export type VariableHover = { href?: string, values: Record<string, string>, onNavigate: (path: string) => void }

export default function MonacoBodyEditor({ value, format, disabled, onChange, label = i18n.language === 'de' ? 'Request-Body' : 'Request body', variableHover, autoHeight = false }: {
  value: string, format: BodyFormat, disabled: boolean, onChange?: (value: string) => void, label?: string,
  variableHover?: VariableHover,
  autoHeight?: boolean,
}) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor>(null)
  const syncing = useRef(false)
  const command = `workspace.openVariables.${useId().replace(/[^\w-]/g, '')}`
  const editable = onChange !== undefined
  const reportChange = useEffectEvent((updated: string) => {
    if (updated !== value) onChange?.(updated)
  })
  const openVariables = useEffectEvent(() => {
    if (variableHover?.href) variableHover.onNavigate(variableHover.href)
  })
  const describeVariable = useEffectEvent((name: string) => {
    if (!variableHover) return []
    const value = Object.hasOwn(variableHover.values, name) ? variableHover.values[name] : undefined
    const display = value === undefined ? (i18n.language === 'de' ? 'Variable ist nicht verfügbar.' : 'Variable is unavailable.') : (() => {
      const preview = value.length > 1000 ? `${value.slice(0, 1000)}…` : value
      const fence = '`'.repeat(Math.max(3, ...Array.from(preview.matchAll(/`+/g), match => match[0].length + 1)))
      return value === '' ? (i18n.language === 'de' ? 'Wert ist leer.' : 'Value is empty.') : `${i18n.t("Value")}\n\n${fence}text\n${preview}\n${fence}`
    })()
    return variableHover.href
      ? [{ value: display }, { value: `[${i18n.language === "de" ? "Umgebungsvariablen anzeigen" : "View environment variables"}](command:${command})`, isTrusted: { enabledCommands: [command] } }]
      : [{ value: display }]
  })

  useEffect(() => {
    if (!container.current) return
    applyEditorTheme()
    const themeObserver = new MutationObserver(applyEditorTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const control = editor.create(container.current, {
      theme: 'workspace-theme', automaticLayout: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono-font').trim(),
      minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on',
      tabSize: 2, padding: { top: 8, bottom: 8 },
    })
    instance.current = control
    const listener = control.onDidChangeModelContent(() => {
      if (!syncing.current) reportChange(control.getValue())
    })
    const jump = editable ? editor.registerCommand(command, () => openVariables()) : undefined
    const hover = editable ? languages.registerHoverProvider('*', {
      provideHover(model, position) {
        if (control.getModel() !== model) return
        const { lineNumber, column } = position
        for (const match of model.getLineContent(lineNumber).matchAll(/\{\{([^{}]+)\}\}/g)) {
          const startColumn = match.index + 1
          const endColumn = startColumn + match[0].length
          if (column < startColumn || column >= endColumn) continue
          return { range: { startLineNumber: lineNumber, endLineNumber: lineNumber, startColumn, endColumn }, contents: describeVariable(match[1]) }
        }
      },
    }) : undefined
    return () => {
      themeObserver.disconnect()
      hover?.dispose()
      jump?.dispose()
      listener.dispose()
      control.getModel()?.dispose()
      control.dispose()
      instance.current = null
    }
  }, [command, editable])

  useEffect(() => {
    const control = instance.current
    if (control && control.getValue() !== value) {
      syncing.current = true
      try {
        control.setValue(value)
      } finally {
        syncing.current = false
      }
    }
  }, [value])

  useEffect(() => {
    const model = instance.current?.getModel()
    if (model) editor.setModelLanguage(model, format === 'text' ? 'plaintext' : format)
  }, [format])

  useEffect(() => instance.current?.updateOptions({ readOnly: disabled || !editable, ariaLabel: label }), [disabled, editable, label])

  useEffect(() => {
    const control = instance.current
    const element = container.current
    if (!autoHeight || !control || !element) return
    const resize = () => { element.style.height = `${control.getContentHeight()}px` }
    const listener = control.onDidContentSizeChange(event => {
      if (event.contentHeightChanged) resize()
    })
    resize()
    return () => {
      listener.dispose()
      element.style.removeProperty('height')
    }
  }, [autoHeight])

  return <div className="monaco-body-editor" ref={container} />
}
