import { VscodeButton } from '@vscode-elements/react-elements'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { inferBodyFormat, type BodyFormat } from '../../../server/body-format.ts'

const MonacoBodyEditor = lazy(() => import('./MonacoBodyEditor'))

type Assertion = { name: string, passed: boolean, skipped?: boolean }

export type RequestResult = {
  status: number
  statusText: string
  durationMs: number
  size: number
  truncated: boolean
  headers: [string, string][]
  body: string
  sentHeaders?: [string, string][]
  sentRequest?: { method: string, url: string, body?: string }
  postResponse?: { error?: string, assertions?: Assertion[] }
}

function indentXml(element: Element, depth: number) {
  if (element.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space') === 'preserve') return

  const children = Array.from(element.childNodes)
  if (children.some(child => child.nodeType === Node.CDATA_SECTION_NODE
    || (child.nodeType === Node.TEXT_NODE && /[^\t\n\r ]/.test(child.nodeValue ?? '')))) return

  const markup = children.filter(child => child.nodeType !== Node.TEXT_NODE)
  if (!markup.length) return

  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) element.removeChild(child)
  }
  for (const child of markup) {
    element.insertBefore(element.ownerDocument.createTextNode('\n' + '  '.repeat(depth + 1)), child)
    if (child instanceof Element) indentXml(child, depth + 1)
  }
  element.appendChild(element.ownerDocument.createTextNode('\n' + '  '.repeat(depth)))
}

function formatXml(body: string) {
  const document = new DOMParser().parseFromString(body, 'application/xml')
  if (document.doctype || document.getElementsByTagNameNS('http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror').length) return body

  indentXml(document.documentElement, 0)
  const declaration = body.match(/^\uFEFF?<\?xml[\t\n\r ][\s\S]*?\?>/)?.[0]
  const serializer = new XMLSerializer()
  return [declaration, ...Array.from(document.childNodes, node => serializer.serializeToString(node))]
    .filter(Boolean).join('\n')
}

function displayBody(result: RequestResult, format: BodyFormat) {
  if (result.truncated) return result.body
  try {
    if (format === 'json') return JSON.stringify(JSON.parse(result.body), null, 2)
    if (format === 'xml') return formatXml(result.body)
  } catch {
    return result.body
  }
  return result.body
}

function headerLines(headers: [string, string][]) {
  return headers.map(([name, value]) => `${name}: ${value}`)
}

function assertionStatus(assertion: Assertion) {
  return assertion.skipped ? 'Skipped' : assertion.passed ? 'Pass' : 'Fail'
}

function CopyExchange({ result, request, body }: { result: RequestResult, request: NonNullable<RequestResult['sentRequest']>, body: string }) {
  const [status, setStatus] = useState('')

  async function copy() {
    const { error, assertions } = result.postResponse ?? {}
    const tests = assertions?.map(assertion => `${assertionStatus(assertion)}: ${assertion.name}`) ?? []
    if (error) tests.push(error)
    const text = [
      'Request', `${request.method} ${request.url}`, ...headerLines(result.sentHeaders ?? []), '', request.body ?? '', '',
      'Response', `HTTP ${result.status} ${result.statusText}`.trimEnd(), `Duration: ${result.durationMs} ms`,
      `Size: ${result.size} B${result.truncated ? ' shown (truncated)' : ''}`, ...headerLines(result.headers), '', body,
      ...(tests.length ? ['', 'Post-response tests', ...tests] : []),
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setStatus('Copied')
    } catch {
      setStatus('Could not copy')
    }
  }

  return <div className="response-copy">
    <span role="status">{status}</span>
    <VscodeButton secondary aria-label="Copy request and response" title="Copy request and response" onClick={() => void copy()}>
      Copy
    </VscodeButton>
  </div>
}

export function ResponseView({ result, error, pending }: { result?: RequestResult, error: string, pending: boolean }) {
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (result) section.current?.scrollIntoView({ block: 'start' })
  }, [result])

  const duration = result?.durationMs
  const durationBand = duration === undefined ? undefined : duration < 400 ? 'fast' : duration < 1000 ? 'moderate' : 'slow'
  const format = result ? inferBodyFormat(result.headers.map(([key, value]) => ({ key, value, enabled: true }))) : 'text'
  const body = result ? displayBody(result, format) : ''

  return <section ref={section} className="request-response" aria-label="Response" aria-busy={pending}>
    <header className="response-heading">
      <h2>Response</h2>
      {result && <p className="response-metrics" role="status">
        <strong className="response-code" data-status-group={Math.floor(result.status / 100)}>{result.status} {result.statusText}</strong>
        <strong className="response-duration" data-duration-band={durationBand}>{result.durationMs} ms</strong>
        <span>{result.size.toLocaleString()} B{result.truncated ? ' shown' : ''}</span>
      </p>}
    </header>
    {pending && <p role="status">Sending request…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!pending && !error && !result && <p>Send a request to see the response.</p>}
    {result && <>
      {result.postResponse?.error && <p role="alert">{result.postResponse.error}</p>}
      {!!result.postResponse?.assertions?.length && <details>
        <summary>Test Results ({result.postResponse.assertions.length})</summary>
        <ul>{result.postResponse.assertions.map((assertion, index) => <li key={index}>
          {assertionStatus(assertion)} · {assertion.name}
        </li>)}</ul>
      </details>}
      {!!result.sentHeaders?.length && <details>
        <summary>Sent headers ({result.sentHeaders.length})</summary>
        <dl>{result.sentHeaders.map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{value}</code></dd></div>)}</dl>
      </details>}
      <details>
        <summary>Headers ({result.headers.length})</summary>
        <dl>{result.headers.map(([name, value], index) => <div key={index}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      </details>
      <div className="response-body-heading">
        <h3>Body</h3>
        {result.sentRequest && <CopyExchange result={result} request={result.sentRequest} body={body} />}
      </div>
      {result.truncated && <p>The response body was truncated at 2 MiB.</p>}
      {result.body ? <Suspense fallback={<p role="status">Loading response editor…</p>}>
        <MonacoBodyEditor label="Response body" value={body} format={format} disabled autoHeight />
      </Suspense> : <p>No response body.</p>}
    </>}
  </section>
}

