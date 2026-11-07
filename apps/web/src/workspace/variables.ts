import { isDynamicReference } from '../../../server/dynamic-variables.ts'

export function previewVariables(value: string, variables: Record<string, string>, keepDynamic = false) {
  const unresolved = new Set<string>()
  const resolved = value.replace(/\{\{([^{}]+)\}\}/g, (reference, name: string) => {
    if (keepDynamic && isDynamicReference(name)) return reference
    if (Object.hasOwn(variables, name)) return variables[name]
    unresolved.add(name)
    return reference
  })
  return { value: resolved, unresolved: [...unresolved] }
}
