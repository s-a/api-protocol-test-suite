import { readUserData, updateUserData } from './user-data.mjs'

const file = 'profiles.json'
const legacyJwtProfileType = process.env.LEGACY_JWT_PROFILE_TYPE
const jwtProfileType = 'merchant-jwt'
const initialProfiles = {
  revision: 0,
  connections: [],
}

class ProfileError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function invalid(message) {
  throw new ProfileError(400, message)
}

function field(value, label, limit = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
    invalid(`Ungültiges Feld: ${label}.`)
  }
  return value.trim()
}

function entries(value, label, parse) {
  if (!Array.isArray(value)) invalid(`Ungültige Liste: ${label}.`)
  const ids = new Set()
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') invalid(`Ungültiger Eintrag: ${label}.`)
    const id = field(entry.id, 'ID')
    if (ids.has(id)) invalid(`Doppelte ID: ${label}.`)
    ids.add(id)
    return { id, name: field(entry.name, 'Name'), ...parse(entry) }
  })
}

function baseUrl(value) {
  let url
  try {
    url = new URL(field(value, 'Basis-URL', 2048))
  } catch {
    invalid('Die Basis-URL muss eine gültige HTTP- oder HTTPS-URL sein.')
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    invalid('Die Basis-URL muss HTTP oder HTTPS verwenden und darf keine Zugangsdaten, Abfrageparameter oder Fragmente enthalten.')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

function variable(value) {
  const name = field(value, 'Umgebungsvariable')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    invalid('Ungültiger Name für eine Umgebungsvariable.')
  }
  return name
}

function authProfile(entry) {
  if (entry.type === 'basic') {
    return {
      type: 'basic',
      usernameVariable: variable(entry.usernameVariable),
      secretVariable: variable(entry.secretVariable),
    }
  }
  if (entry.type === 'bearer') {
    return { type: 'bearer', secretVariable: variable(entry.secretVariable) }
  }
  if (entry.type === jwtProfileType || (legacyJwtProfileType && entry.type === legacyJwtProfileType)) {
    return {
      type: jwtProfileType,
      merchantId: field(entry.merchantId, 'Händler-ID'),
      pointOfUseId: field(entry.pointOfUseId, 'Point-of-Use-ID'),
      secretVariable: variable(entry.secretVariable),
    }
  }
  invalid('Unbekanntes Anmeldeverfahren.')
}

async function readUpdate(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new ProfileError(415, 'Die Anfrage muss JSON enthalten.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 256 * 1024) {
      request.resume()
      throw new ProfileError(413, 'Die Profildaten sind zu groß.')
    }
    chunks.push(chunk)
  }
  let data
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    invalid('Ungültiges JSON.')
  }
  if (!Number.isSafeInteger(data?.revision) || data.revision < 0) invalid('Ungültige Revision.')
  return {
    revision: data.revision,
    connections: entries(data.connections, 'Verbindungen', (connection) => ({
      baseUrl: baseUrl(connection.baseUrl),
      authProfiles: entries(connection.authProfiles, 'Authentifizierungsprofile', authProfile),
    })),
  }
}

export async function handleProfiles(request, response, send, accountId) {
  const json = (status, data) => {
    response.setHeader('Cache-Control', 'no-store')
    send(request, response, status, 'application/json; charset=utf-8', JSON.stringify(data))
  }
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const profiles = await readUserData(accountId, file, initialProfiles)
      json(200, {
        ...profiles,
        connections: profiles.connections.map(connection => ({
          ...connection,
          authProfiles: connection.authProfiles.map(profile => legacyJwtProfileType && profile.type === legacyJwtProfileType
            ? { ...profile, type: jwtProfileType }
            : profile),
        })),
      })
    } else if (request.method === 'PUT') {
      const update = await readUpdate(request)
      const saved = await updateUserData(accountId, file, initialProfiles, current => {
        if (current.revision !== update.revision) {
          throw new ProfileError(409, 'Die Profile wurden inzwischen geändert. Lade die Seite neu.')
        }
        return { ...update, revision: current.revision + 1 }
      })
      json(200, saved)
    } else {
      response.setHeader('Allow', 'GET, HEAD, PUT')
      json(405, { error: 'Methode nicht erlaubt.' })
    }
  } catch (error) {
    if (error instanceof ProfileError) {
      json(error.status, { error: error.message })
    } else {
      console.error(error)
      json(500, { error: 'Die Profildaten konnten nicht verarbeitet werden.' })
    }
  }
}
