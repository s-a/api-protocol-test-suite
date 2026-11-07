import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultDirectory = fileURLToPath(new URL('../../data/', import.meta.url))

export function dataDirectory() {
  return resolve(process.env.DATA_DIR || defaultDirectory)
}
