import { parentPort, workerData } from 'node:worker_threads'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { isBodyFormat } from './body-format.ts'
import { importGeneratedPostmanCollection, PostmanExchangeError } from './postman.mjs'
import { sdk } from './postman-runtime.mjs'

const wsdl11 = 'http://schemas.xmlsoap.org/wsdl/'
const wsdl20 = 'http://www.w3.org/ns/wsdl'
const wsdl20Soap = 'http://www.w3.org/ns/wsdl/soap'
const xsd = 'http://www.w3.org/2001/XMLSchema'
const soap11 = 'http://schemas.xmlsoap.org/soap/envelope/'
const soap12 = 'http://www.w3.org/2003/05/soap-envelope'
const soap12ContentType = 'application/soap+xml; charset=utf-8'

function decodeWsdl(bytes) {
  const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0
  const utf16be = bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c
  try {
    return new TextDecoder(utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new PostmanExchangeError('WSDL must be encoded as UTF-8 or UTF-16.')
  }
}

function parseXml(source) {
  return new DOMParser({ onError(level, message) { if (level !== 'warning') throw new Error(message) } })
    .parseFromString(source, 'application/xml')
}

function prepareWsdl(source) {
  let document
  try {
    document = parseXml(source)
  } catch {
    throw new PostmanExchangeError('Invalid WSDL XML.')
  }
  const root = document.documentElement
  if (document.doctype) throw new PostmanExchangeError('WSDL documents with a DTD are unsupported.')
  if (!(root?.namespaceURI === wsdl11 && root.localName === 'definitions' ||
        root?.namespaceURI === wsdl20 && root.localName === 'description')) {
    throw new PostmanExchangeError('Expected a WSDL 1.1 or 2.0 document.')
  }
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    const externalWsdl = (element.namespaceURI === wsdl11 || element.namespaceURI === wsdl20) &&
      ['import', 'include'].includes(element.localName) && element.hasAttribute('location')
    const externalSchema = element.namespaceURI === xsd &&
      ['import', 'include', 'redefine', 'override'].includes(element.localName) && element.hasAttribute('schemaLocation')
    if (externalWsdl || externalSchema) {
      throw new PostmanExchangeError('Select a self-contained WSDL. External WSDL and XML Schema references are unsupported.')
    }
  }
  if (root.namespaceURI !== wsdl20) return source
  const defaults = Array.from(root.getElementsByTagNameNS(wsdl20, 'binding')).filter(binding =>
    binding.getAttribute('type') === wsdl20Soap && !binding.hasAttributeNS(wsdl20Soap, 'version'))
  if (!defaults.length) return source
  let prefix = root.lookupPrefix(wsdl20Soap)
  if (!prefix) {
    prefix = 'wsoap'
    while (root.lookupNamespaceURI(prefix)) prefix += '_'
    root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, wsdl20Soap)
  }
  for (const binding of defaults) binding.setAttributeNS(wsdl20Soap, `${prefix}:version`, '1.2')
  return new XMLSerializer().serializeToString(document)
}

function rows(entries) {
  return entries?.map(({ key, value, disabled, description }) => ({ key, value, disabled, description: description?.content ?? description }))
}

function requestBody(body) {
  if (body?.mode === 'raw' && typeof body.raw === 'string') {
    const language = body.options?.raw?.language
    return { type: isBodyFormat(language) ? language : 'text', content: body.raw }
  }
  if (body?.mode === 'urlencoded') return { type: 'urlencoded', content: rows(body.urlencoded) }
}

function envelopeNamespace(body) {
  if (body?.type !== 'xml') return
  try {
    const root = parseXml(body.content).documentElement
    if (root?.localName === 'Envelope') return root.namespaceURI
  } catch {
    // Generated fault requests may contain a text placeholder.
  }
}

function soapHeaders(headers, namespace) {
  if (namespace !== soap11 && namespace !== soap12) return headers
  const action = headers.find(header => header.key.toLowerCase() === 'soapaction')?.value?.trim().replace(/^"(.*)"$/, '$1')
  if (namespace === soap11 && action && !/^[\x21\x23-\x7e]+$/.test(action) ||
      namespace === soap12 && action && !/^[A-Za-z][A-Za-z\d+.-]*:[\x21\x23-\x7e]+$/.test(action)) {
    throw new PostmanExchangeError('The WSDL contains an invalid SOAP action URI.')
  }
  const otherHeaders = headers.filter(header => !['content-type', 'soapaction'].includes(header.key.toLowerCase()))
  if (namespace === soap11) {
    return [{ key: 'Content-Type', value: 'text/xml; charset=utf-8' }, { key: 'SOAPAction', value: `"${action ?? ''}"` }, ...otherHeaders]
  }
  const contentType = action ? `${soap12ContentType}; action="${action}"` : soap12ContentType
  return [{ key: 'Content-Type', value: contentType }, ...otherHeaders]
}

function requestDefinition(request, namespace) {
  const body = requestBody(request.body)
  return {
    url: new sdk.Url(request.url).toString(), method: request.method, body,
    headers: soapHeaders(rows(request.header) ?? [], namespace),
  }
}

function itemDefinition(item) {
  const { id, name } = item
  if (item.item) return { id, name, description: item.description?.content, items: item.item.map(itemDefinition) }
  const namespace = envelopeNamespace(requestBody(item.request.body))
  return {
    id, name, description: item.request.description?.content, ...requestDefinition(item.request, namespace),
    examples: item.response.map(example => ({
      id: example.id, name: example.name, request: requestDefinition(example.originalRequest, namespace),
      response: {
        statusCode: example.code, statusText: example.status,
        headers: namespace === soap12 ? soapHeaders(rows(example.header) ?? [], soap12) : rows(example.header),
        body: { type: example._postman_previewlanguage === 'xml' ? 'xml' : 'text', content: example.body ?? '' },
      },
    })),
  }
}

async function convertWsdl(bytes) {
  const source = prepareWsdl(decodeWsdl(bytes))
  const { default: converter } = await import('@postman/wsdl-to-postman')
  let result
  try {
    result = await new Promise((resolve, reject) => {
      converter.convert({ type: 'string', data: source }, { resolveRemoteRefs: false },
        (error, converted) => error ? reject(error) : resolve(converted))
    })
  } catch {
    throw new PostmanExchangeError('Could not convert the WSDL to a collection.')
  }
  const collection = result.output?.find(output => output.type === 'collection')?.data
  if (!result.result || !collection?.item?.length) {
    throw new PostmanExchangeError(result.reason || 'The WSDL has no importable operations.')
  }
  return importGeneratedPostmanCollection({
    id: collection.info._postman_id, name: collection.info.name, description: collection.info.description?.content,
    variables: collection.variable?.map(({ key, value }) => ({ key, value: String(value) })),
    items: collection.item.map(itemDefinition),
  })
}

try {
  parentPort.postMessage({ collection: await convertWsdl(workerData) })
} catch (error) {
  if (!(error instanceof PostmanExchangeError)) throw error
  parentPort.postMessage({ error: error.message })
}
