import { generators } from './postman-runtime.mjs'

export function generateDynamicValue(name) {
  if (!Object.hasOwn(generators, name)) return undefined
  return String(generators[name].generator())
}
