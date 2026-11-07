import type { Workspace, WorkspaceSection } from './types'

export function completeWorkspace(workspace: Workspace): Workspace {
  if (workspace.sections) return workspace
  const active = workspace.environments.find(({ id }) => id === workspace.activeEnvironmentId)
  const rootEnvironment = active?.id ?? workspace.environments[0]?.id
  const environment = rootEnvironment ? undefined : { id: 'root-environment', name: 'Root Environment', variables: [] }
  return {
    ...workspace,
    environments: environment ? [...workspace.environments, environment] : workspace.environments,
    sections: [
      { id: 'root', name: 'Root', collectionIds: workspace.collections.map(({ id }) => id),
        environmentId: rootEnvironment ?? environment?.id ?? null },
      ...workspace.environments.filter(({ id }) => id !== rootEnvironment).map(({ id, name }) => ({
        id: 'environment:' + id, name, collectionIds: [], environmentId: id,
      })),
    ],
  }
}

export function sectionWorkspace(workspace: Workspace, section: WorkspaceSection): Workspace {
  const collectionIds = new Set(section.collectionIds)
  return {
    ...workspace,
    collections: workspace.collections.filter(({ id }) => collectionIds.has(id)),
    environments: workspace.environments.filter(({ id }) => id === section.environmentId),
    activeEnvironmentId: section.environmentId,
  }
}
