import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)
const fakerAdapter = require.resolve('./postman-faker.cjs')
const uuid = require.resolve('uuid')

// Redirect the SDK's legacy Faker import without changing any other consumer.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@faker-js/faker/locale/en' &&
        context.parentURL?.endsWith('/postman-collection/lib/superstring/dynamic-variables.js')) {
      return next(fakerAdapter, context)
    }
    return next(specifier, context)
  },
})

export let sdk, generators
try {
  sdk = require('postman-collection')
  generators = require('postman-collection/lib/superstring/dynamic-variables.js')
} finally {
  hook.deregister()
}

function replaceFactory(source, id, nextId, value) {
  const marker = `,${id}:[function(`
  const start = source.indexOf(marker)
  const end = source.indexOf(`,${nextId}:[function(`, start + marker.length)
  if (start < 0 || end < 0 || source.lastIndexOf(marker) !== start) {
    throw new Error(`Unexpected Postman Sandbox bundle for ${id}.`)
  }
  return source.slice(0, start) + `,${id}:[function(require,module){module.exports=${value}},{}]` + source.slice(end)
}

export function loadSandbox() {
  const cachePath = require.resolve('postman-sandbox/.cache/bootcode.js')
  const original = require(cachePath)
  // The Sandbox ships its own bundled Faker. Replace the entry factories
  // before starting the worker so it uses the same patched dependencies.
  require.cache[cachePath].exports = callback => original((error, source) => {
    if (error) return callback(error)
    try {
      const match = [...source.matchAll(/"@faker-js\/faker\/locale\/en":(\d+)/g)]
      if (match.length !== 1) throw new Error('Unexpected Postman Sandbox Faker module.')
      const fakerId = match[0][1]
      const patched = replaceFactory(replaceFactory(source, fakerId, String(Number(fakerId) + 1), 'workspaceFaker'),
        'uuid', 'xml2js', 'workspaceUuid')
      callback(null, `const workspaceFaker=require(${JSON.stringify(fakerAdapter)});` +
        `const workspaceUuidModule=require(${JSON.stringify(uuid)});` +
        'const workspaceUuid=Object.assign((...args)=>workspaceUuidModule.v4(...args),workspaceUuidModule);' + patched)
    } catch (reason) {
      callback(reason)
    }
  })
  return require('postman-sandbox')
}
