/**
 * Feed fetching.
 *
 * Two modes, exactly as the product spec demands:
 *
 *   A. direct — `fetch()` from the browser. Works only for hosts that send
 *      `Access-Control-Allow-Origin`. A CORS rejection is *indistinguishable*
 *      from a network outage in the Fetch API, so we report both possibilities
 *      instead of pretending the feed is broken.
 *
 *   B. proxy  — an optional, self-hosted Cloudflare Worker (see /proxy). It is
 *      never a general-purpose open relay: allow-listed protocols, private-IP
 *      blocking, body-size and timeout caps, per-IP rate limiting.
 *
 * Nothing here silently swallows a failure: every error carries a `kind` that
 * the UI translates into a specific, actionable message.
 */
import { normalizeUrl } from './url'
import type { FeedError, FeedErrorKind } from './types'

export const FETCH_TIMEOUT_MS = 20_000
export const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface FetchFeedOptions {
  /** Optional self-hosted proxy base URL, e.g. https://rss-proxy.example.workers.dev */
  proxyUrl?: string
  /** Force a mode; `auto` tries direct first, then the proxy when configured. */
  mode?: 'auto' | 'direct' | 'proxy'
  timeoutMs?: number
  /** Previously stored validators, for conditional requests. */
  etag?: string | null
  lastModified?: string | null
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface FetchFeedResult {
  xml: string
  status: number
  notModified: boolean
  etag: string | null
  lastModified: string | null
  /** Which transport actually produced the document. */
  transport: 'direct' | 'proxy'
  finalUrl: string
}

export class FeedFetchError extends Error {
  readonly kind: FeedErrorKind
  readonly status?: number

  constructor(kind: FeedErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'FeedFetchError'
    this.kind = kind
    this.status = status
  }
}

/** Build the proxy request URL, preserving the target as a query parameter. */
export function buildProxyRequest(proxyBase: string, target: string): string {
  const base = proxyBase.trim().replace(/\/+$/, '')
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}url=${encodeURIComponent(target)}`
}

/**
 * Fetch one feed.
 *
 * @throws {FeedFetchError} with a machine-readable `kind`.
 */
export async function fetchFeed(
  url: string,
  options: FetchFeedOptions = {},
): Promise<FetchFeedResult> {
  const normalized = normalizeUrl(url)
  if (!normalized) throw new FeedFetchError('unknown', 'Invalid feed URL')

  const mode = options.mode ?? 'auto'
  const proxyUrl = options.proxyUrl?.trim() ?? ''
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)

  const canProxy = Boolean(proxyUrl) && mode !== 'direct'
  const tryDirect = mode !== 'proxy'

  let directError: FeedFetchError | null = null
  if (tryDirect) {
    try {
      return await requestOnce(fetchImpl, normalized, {
        timeoutMs,
        etag: options.etag,
        lastModified: options.lastModified,
        signal: options.signal,
        transport: 'direct',
      })
    } catch (error) {
      directError = toFeedFetchError(error)
      // A definitive HTTP answer (404/410) does not improve by proxying.
      if (directError.kind === 'http' && [404, 410, 401, 403].includes(directError.status ?? 0)) {
        throw directError
      }
      if (!canProxy) throw directError
    }
  }

  if (!canProxy) {
    throw directError ?? new FeedFetchError('unknown', 'No fetch transport available')
  }

  try {
    return await requestOnce(fetchImpl, normalized, {
      timeoutMs,
      etag: options.etag,
      lastModified: options.lastModified,
      signal: options.signal,
      transport: 'proxy',
      proxyBase: proxyUrl,
    })
  } catch (error) {
    const proxyError = toFeedFetchError(error)
    // Report the proxy failure, but keep the direct diagnosis visible.
    const combined = new FeedFetchError(
      proxyError.kind,
      directError
        ? `${describe(directError)} | proxy: ${describe(proxyError)}`
        : `Proxy: ${describe(proxyError)}`,
      proxyError.status,
    )
    throw combined
  }
}

function describe(error: FeedFetchError): string {
  return error.status ? `${error.kind} ${error.status}` : error.kind
}

async function requestOnce(
  fetchImpl: typeof fetch,
  target: string,
  opts: {
    timeoutMs: number
    etag?: string | null
    lastModified?: string | null
    signal?: AbortSignal
    transport: 'direct' | 'proxy'
    proxyBase?: string
  },
): Promise<FetchFeedResult> {
  const requestUrl = opts.transport === 'proxy' ? buildProxyRequest(opts.proxyBase!, target) : target

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), opts.timeoutMs)
  const onAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const headers: Record<string, string> = {
    Accept:
      'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  }
  if (opts.etag) headers['If-None-Match'] = opts.etag
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified

  try {
    const response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
      // `cors` makes the browser surface an explicit failure instead of an
      // opaque one; credentials are never sent to feed hosts.
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    })

    if (response.status === 304) {
      return {
        xml: '',
        status: 304,
        notModified: true,
        etag: response.headers.get('etag') ?? opts.etag ?? null,
        lastModified: response.headers.get('last-modified') ?? opts.lastModified ?? null,
        transport: opts.transport,
        finalUrl: response.url || target,
      }
    }

    if (!response.ok) {
      throw new FeedFetchError(
        'http',
        `HTTP ${response.status} ${response.statusText}`.trim(),
        response.status,
      )
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    if (declaredLength > MAX_BODY_BYTES) {
      throw new FeedFetchError(
        'http',
        `Response too large (${Math.round(declaredLength / 1024 / 1024)} MB, limit 8 MB)`,
        response.status,
      )
    }

    const xml = await readLimited(response, MAX_BODY_BYTES)
    if (!xml.trim()) throw new FeedFetchError('parse', 'Empty response body', response.status)

    return {
      xml,
      status: response.status,
      notModified: false,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      transport: opts.transport,
      finalUrl: response.url || target,
    }
  } catch (error) {
    if (error instanceof FeedFetchError) throw error
    const name = (error as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      if (opts.signal?.aborted) {
        throw new FeedFetchError('unknown', 'Request cancelled')
      }
      throw new FeedFetchError('timeout', `Timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
    }
    // The Fetch API hides the reason for a blocked CORS request behind a bare
    // TypeError. We surface that ambiguity instead of guessing "offline".
    throw new FeedFetchError(
      'cors',
      'Browser blocked the request (CORS policy or network unreachable). This host likely needs the optional proxy.',
    )
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        throw new FeedFetchError('http', 'Response body exceeded the 8 MB limit', response.status)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(buffer)
}

export function toFeedFetchError(error: unknown): FeedFetchError {
  if (error instanceof FeedFetchError) return error
  return new FeedFetchError('unknown', (error as Error)?.message ?? 'Unknown fetch failure')
}

export function toFeedError(error: unknown): FeedError {
  const normalized = toFeedFetchError(error)
  return {
    kind: normalized.kind,
    message: normalized.message,
    at: Date.now(),
    ...(normalized.status ? { status: normalized.status } : {}),
  }
}

/**
 * Exponential backoff for failing feeds: 5, 15, 45 minutes… capped at 6 hours.
 * A feed in backoff is skipped by automatic refreshes but can always be
 * refreshed manually.
 */
export function backoffDelayMs(failureCount: number): number {
  const base = 5 * 60 * 1000
  const cap = 6 * 60 * 60 * 1000
  return Math.min(cap, base * Math.pow(3, Math.max(0, failureCount - 1)))
}

export function isInBackoff(feed: { failureCount: number; lastFetchedAt: number | null }): boolean {
  if (feed.failureCount <= 0 || !feed.lastFetchedAt) return false
  return Date.now() - feed.lastFetchedAt < backoffDelayMs(feed.failureCount)
}

/**
 * Try to discover a feed for a plain website URL.
 *
 * Strategy: fetch the page, look for <link rel="alternate" type="…rss/atom…">,
 * then fall back to the handful of well-known paths. Every attempt is a real
 * network request, so the caller must have a proxy configured for hosts that
 * block CORS — the UI explains this.
 */
export async function discoverFeedUrls(
  siteUrl: string,
  options: { proxyUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ candidates: string[]; htmlUrl: string | null }> {
  const normalized = normalizeUrl(siteUrl)
  if (!normalized) return { candidates: [], htmlUrl: null }

  const candidates: string[] = []
  let htmlUrl: string | null = null

  try {
    const result = await fetchOnceForHtml(normalized, options)
    htmlUrl = result.finalUrl
    for (const link of extractFeedLinks(result.html, result.finalUrl)) {
      if (!candidates.includes(link)) candidates.push(link)
    }
  } catch {
    // Page fetch failed (CORS / offline). Still try the conventional paths.
  }

  const origin = new URL(normalized).origin
  for (const path of ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/feeds/all.xml']) {
    const candidate = normalizeUrl(`${origin}${path}`)
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
  }

  return { candidates: candidates.slice(0, 8), htmlUrl }
}

async function fetchOnceForHtml(
  url: string,
  options: { proxyUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    options.timeoutMs ?? 12000,
  )
  const proxy = options.proxyUrl?.trim()
  const requestUrl = proxy ? buildProxyRequest(proxy, url) : url
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    })
    if (!response.ok) throw new FeedFetchError('http', `HTTP ${response.status}`, response.status)
    const html = await response.text()
    return { html: html.slice(0, 2_000_000), finalUrl: response.url || url }
  } finally {
    clearTimeout(timer)
  }
}

/** Extract <link rel="alternate"> feed URLs from an HTML document. */
export function extractFeedLinks(html: string, pageUrl: string): string[] {
  const links: string[] = []
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? []
  const typeRe = /type\s*=\s*["']?(application\/(?:rss|atom|rdf)\+xml|application\/xml|text\/xml)/i
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?[^"'>]*alternate/i.test(tag)) continue
    if (!typeRe.test(tag)) continue
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i)
    if (!hrefMatch) continue
    const href = hrefMatch[1].trim()
    if (!href) continue
    try {
      const absolute = new URL(href, pageUrl).toString()
      const normalized = normalizeUrl(absolute)
      if (normalized && !links.includes(normalized)) links.push(normalized)
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return links
}
