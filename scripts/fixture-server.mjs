#!/usr/bin/env node
/**
 * Static fixture server for the Playwright suite.
 *
 * It exists so end-to-end tests never depend on third-party feeds being up.
 * Fixtures are served with and without CORS headers so both the happy path
 * and the "browser blocked this feed" path can be tested deterministically.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'tests', 'fixtures')
const port = Number(process.env.FIXTURE_PORT ?? 4179)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'If-None-Match, If-Modified-Since, Accept',
  'access-control-expose-headers': 'ETag, Last-Modified',
}

const routes = new Map([
  ['/rss.xml', { file: 'rss2.xml', type: 'application/rss+xml', cors: true, etag: '"rss-v1"' }],
  ['/atom.xml', { file: 'atom.xml', type: 'application/atom+xml', cors: true, etag: '"atom-v1"' }],
  ['/rdf.xml', { file: 'rdf.xml', type: 'application/rdf+xml', cors: true, etag: null }],
  ['/invalid.xml', { file: 'invalid.xml', type: 'application/xml', cors: true, etag: null }],
  ['/page.html', { file: 'page.html', type: 'text/html', cors: true, etag: null }],
  ['/no-cors.xml', { file: 'rss2.xml', type: 'application/rss+xml', cors: false, etag: null }],
  ['/missing.xml', { status: 404, cors: true }],
])

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)

  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS)
    response.end()
    return
  }

  const route = routes.get(url.pathname)
  if (!route) {
    response.writeHead(404, { 'content-type': 'text/plain', ...CORS })
    response.end('not found')
    return
  }

  const headers = { 'content-type': route.type ?? 'text/plain', 'cache-control': 'no-store' }
  if (route.cors) Object.assign(headers, CORS)
  if (route.etag) {
    headers.etag = route.etag
    if (request.headers['if-none-match'] === route.etag) {
      response.writeHead(304, headers)
      response.end()
      return
    }
  }
  if (route.status) {
    response.writeHead(route.status, headers)
    response.end('missing')
    return
  }

  let body = ''
  try {
    body = await readFile(join(fixtures, route.file), 'utf8')
  } catch {
    response.writeHead(500, headers)
    response.end('fixture read error')
    return
  }

  // The page fixture links to a relative feed path; rewrite it so discovery
  // finds the fixture server rather than example.com.
  if (route.file === 'page.html') {
    body = body.replace('href="/feeds/main.xml"', 'href="/rss.xml"')
  }

  response.writeHead(200, headers)
  response.end(body)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fixtures] http://127.0.0.1:${port} ready`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
