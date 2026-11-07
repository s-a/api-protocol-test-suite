export function orderSections<T extends { id: string }>(sections: T[], order: string[]): T[] {
  const remaining = new Map(sections.map(section => [section.id, section]))
  const ordered: T[] = []
  for (const id of order) {
    const section = remaining.get(id)
    if (!section) continue
    ordered.push(section)
    remaining.delete(id)
  }
  return [...ordered, ...remaining.values()]
}

export function moveSection(order: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return order
  const next = order.filter(id => id !== source)
  next.splice(next.indexOf(target) + Number(after), 0, source)
  return next
}

export function readSectionOrder(key: string | undefined): string[] {
  if (!key) return []
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}
