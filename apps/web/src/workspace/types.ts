import type { BodyFormat } from '../../../server/body-format.ts'
import type { JwtSettings } from '../../../server/jwt-settings.ts'

export type Auth =
  | { type: 'none' | 'inherit' }
  | { type: 'basic', username: string, password: string }
  | { type: 'bearer', token: string }
  | JwtSettings

export type Row = { id: string, key: string, value: string, enabled: boolean }
type Named = { id: string, name: string }
type Authorized = Named & { auth: Auth, preRequest?: string, postResponse?: string }

export type Folder = Authorized & { type: 'folder', items: CollectionItem[] }
export type Request = Authorized & {
  type: 'request'
  method: string
  url: string
  headers: Row[]
  body?: string
  bodyFormat?: BodyFormat
}
export type CollectionItem = Folder | Request
export type Collection = Authorized & {
  items: CollectionItem[]
  exchange?: { warnings?: string[], variables?: Record<string, string> }
}
export type Environment = Named & { variables: Row[] }
export type WorkspaceSection = Named & { collectionIds: string[], environmentId: string | null }
export type Workspace = {
  collections: Collection[]
  environments: Environment[]
  activeEnvironmentId: string | null
  sections?: WorkspaceSection[]
}

export type Selection =
  | { kind: 'collection', collectionId: string }
  | { kind: 'item', collectionId: string, itemId: string }
  | { kind: 'environment', environmentId: string }
