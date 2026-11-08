import i18n from '../i18n'

let loadedLanguage: string | undefined
let editorModule: Promise<typeof import('./MonacoBodyEditor')> | undefined

export function monacoLanguage() {
  return loadedLanguage
}

export function loadMonacoBodyEditor() {
  if (!editorModule) {
    loadedLanguage = i18n.resolvedLanguage ?? 'en'
    editorModule = (async () => {
      if (loadedLanguage === 'de') await import('monaco-editor/esm/nls.messages.de.js')
      return import('./MonacoBodyEditor')
    })()
  }
  return editorModule
}
