export function isDynamicReference(name: string): boolean {
  return name.startsWith('$')
}
