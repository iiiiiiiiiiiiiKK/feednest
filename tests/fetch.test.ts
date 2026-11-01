import { describe, expect, it, vi } from 'vitest'
import {
  backoffDelayMs,
  buildProxyRequest,
  discoverFeedUrls,
  extractFeedLinks,
  fetchFeed,
  FeedFetchError,
  isInBackoff,
  MAX_BODY_BYTES,
} from '@/lib/fetch'
import { resolveFeed } from '@/lib/addFeed'
import { fixture, jsonResponse } from './helpers'

const FEED_XML = fixture('rss2.xml')

/** Await a promise that must reject, returning the error with its real type. */
async function captureError(promise: Promise<unknown>): Promise<FeedFetchError> {
  try {
    await promise
  } catch (caught) {
    return caught as FeedFetchError
  }
  throw new Error('Expected the promise to reject, but it resolved')
}

describe('fetchFeed — direct mode', () => {
  it('returns the body and validators', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(FEED_XML, {
        headers: { 'content-type': 'application/rss+xml', etag: '"abc"', 'last-modified': 'Mon, 09 Jun 2025 10:00:00 GMT' },
      }),
    ) as unknown as typeof fetch

    const result = await fetchFeed('https://nest.example.com/rss.xml', { fetchImpl })
    expect(result.xml).toContain('<rss')
    expect(result.transport).toBe('direct')
    expect(result.etag).toBe('"abc"')
    expect(result.notModified).toBe(false)
  })

  it('sends conditional headers when validators are known', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('If-None-Match')).toBe('"abc"')
      expect(headers.get('If-Modified-Since')).toBe('Mon, 09 Jun 2025 10:00:00 GMT')
      return new Response(null, { status: 304 })
    }) as unknown as typeof fetch

    const result = await fetchFeed('https://nest.example.com/rss.xml', {
      fetchImpl,
      etag: '"abc"',
      lastModified: 'Mon, 09 Jun 2025 10:00:00 GMT',
    })
    expect(result.notModified).toBe(true)
    expect(result.xml).toBe('')
  })

  it('classifies a CORS/network rejection instead of pretending the feed is broken', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    await expect(fetchFeed('https://nest.example.com/rss.xml', { fetchImpl })).rejects.toMatchObject({
      kind: 'cors',
    })
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1)
  })

  it('classifies HTTP errors and does not retry them through the proxy', async () => {
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    const error = await captureError(
      fetchFeed('https://nest.example.com/rss.xml', {
        fetchImpl,
        proxyUrl: 'https://proxy.example/feed?',
      }),
    )
    expect(error).toBeInstanceOf(FeedFetchError)
    expect(error.kind).toBe('http')
    expect(error.status).toBe(404)
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1)
  })

  it('times out with a timeout kind', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch

    const error = await captureError(
      fetchFeed('https://nest.example.com/rss.xml', { fetchImpl, timeoutMs: 40 }),
    )
    expect(error).toBeInstanceOf(FeedFetchError)
    expect(error.kind).toBe('timeout')
  })

  it('refuses responses larger than the body limit', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(FEED_XML, {
          headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
        }),
    ) as unknown as typeof fetch
    const error = await captureError(
      fetchFeed('https://nest.example.com/rss.xml', { fetchImpl }),
    )
    expect(error.kind).toBe('http')
    expect(error.message).toContain('too large')
  })

  it('reports an empty body as a parse failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('')) as unknown as typeof fetch
    const error = await captureError(
      fetchFeed('https://nest.example.com/rss.xml', { fetchImpl }),
    )
    expect(error.kind).toBe('parse')
  })

  it('rejects invalid URLs before any request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(fetchFeed('not a url', { fetchImpl })).rejects.toMatchObject({ kind: 'unknown' })
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled()
  })
})

describe('fetchFeed — proxy mode', () => {
  it('falls back to the proxy after a CORS failure', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (!url.includes('proxy.example')) throw new TypeError('Failed to fetch')
      return jsonResponse(FEED_XML)
    }) as unknown as typeof fetch

    const result = await fetchFeed('https://nest.example.com/rss.xml', {
      fetchImpl,
      proxyUrl: 'https://proxy.example/rss',
    })
    expect(result.transport).toBe('proxy')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(
      `https://proxy.example/rss?url=${encodeURIComponent('https://nest.example.com/rss.xml')}`,
    )
  })

  it('skips the direct attempt when the feed is pinned to proxy mode', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(FEED_XML)) as unknown as typeof fetch
    await fetchFeed('https://nest.example.com/rss.xml', {
      fetchImpl,
      mode: 'proxy',
      proxyUrl: 'https://proxy.example/rss',
    })
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('proxy.example')
  })

  it('reports both the direct and the proxy failure', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('proxy.example')) return new Response('bad', { status: 502 })
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch

    const error = await captureError(
      fetchFeed('https://nest.example.com/rss.xml', {
        fetchImpl,
        proxyUrl: 'https://proxy.example/rss',
      }),
    )
    expect(error.kind).toBe('http')
    expect(error.message).toContain('proxy')
  })

  it('builds proxy URLs without duplicating the query separator', () => {
    expect(buildProxyRequest('https://p.example/rss', 'https://a.test/feed')).toBe(
      'https://p.example/rss?url=https%3A%2F%2Fa.test%2Ffeed',
    )
    expect(buildProxyRequest('https://p.example/?key=1', 'https://a.test/feed')).toBe(
      'https://p.example/?key=1&url=https%3A%2F%2Fa.test%2Ffeed',
    )
    expect(buildProxyRequest('https://p.example/rss/', 'https://a.test/feed')).toBe(
      'https://p.example/rss?url=https%3A%2F%2Fa.test%2Ffeed',
    )
  })
})

describe('backoff', () => {
  it('grows exponentially and caps at six hours', () => {
    expect(backoffDelayMs(1)).toBe(5 * 60 * 1000)
    expect(backoffDelayMs(2)).toBe(15 * 60 * 1000)
    expect(backoffDelayMs(3)).toBe(45 * 60 * 1000)
    expect(backoffDelayMs(12)).toBe(6 * 60 * 60 * 1000)
  })

  it('only applies while the last attempt is recent', () => {
    expect(isInBackoff({ failureCount: 0, lastFetchedAt: Date.now() })).toBe(false)
    expect(isInBackoff({ failureCount: 2, lastFetchedAt: Date.now() })).toBe(true)
    expect(isInBackoff({ failureCount: 2, lastFetchedAt: Date.now() - 60 * 60 * 1000 })).toBe(false)
  })
})

describe('feed discovery', () => {
  it('extracts rel=alternate links and resolves them against the page URL', () => {
    const links = extractFeedLinks(fixture('page.html'), 'https://example.com/blog/')
    expect(links).toEqual([
      'https://example.com/feeds/main.xml',
      'https://example.com/atom.xml',
    ])
  })

  it('ignores non-feed and non-alternate links', () => {
    const html =
      '<link rel="stylesheet" href="/style.css"><link rel="alternate" type="application/json" href="/feed.json">'
    expect(extractFeedLinks(html, 'https://example.com/')).toEqual([])
  })

  it('falls back to well-known paths when the page cannot be read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const discovered = await discoverFeedUrls('https://example.com/', { fetchImpl })
    expect(discovered.candidates).toContain('https://example.com/feed')
    expect(discovered.candidates).toContain('https://example.com/rss.xml')
  })

  it('resolves a homepage to a feed through discovery', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/blog') || url.endsWith('/blog/')) {
        return new Response(fixture('page.html'), {
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url.endsWith('/feeds/main.xml')) return jsonResponse(FEED_XML)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const resolved = await resolveFeed('https://example.com/blog/', { fetchImpl })
    expect(resolved.url).toBe('https://example.com/feeds/main.xml')
    expect(resolved.parsed.title).toBe('Nest Test Journal')
    expect(resolved.attempts).toBeGreaterThan(1)
  })

  it('surfaces CORS instead of trying more paths when the host blocks the browser', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(resolveFeed('https://blocked.example/', { fetchImpl })).rejects.toMatchObject({
      kind: 'cors',
    })
  })
})
