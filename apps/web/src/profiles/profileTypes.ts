export type AuthProfile = {
  id: string
  name: string
  type: 'basic' | 'bearer' | 'merchant-jwt'
  usernameVariable?: string
  merchantId?: string
  pointOfUseId?: string
  secretVariable: string
}

export type Connection = {
  id: string
  name: string
  baseUrl: string
  authProfiles: AuthProfile[]
}

export type ProfileDocument = {
  revision: number
  connections: Connection[]
}
