import { describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../proxy/src/index'
import {
  checkTargetUrl,
  fetchWithRevalidatedRedirects,
  isAllowedContentType,
  ProxyError,
  readBodyLimited,
} from '../proxy/src/guard'

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>x</title><link>https://a.test/1</link></item></channel></rss>`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, init)
}

describe('proxy URL guard', () => {
  it('accepts public http(s) targets', () => {
    expect(checkTargetUrl('https://example.com/feed.xml').ok).toBe(true)
    expect(checkTargetUrl('http://example.com:8080/feed').ok).toBe(true)
  })

  it('rejects anything that could reach the inside of a network', () => {
    for (const url of [
      'http://localhost/feed',
      'http://127.0.0.1/feed',
      'http://10.1.2.3/feed',
      'http://192.168.0.1/feed',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/feed',
      'http://[fd00::1]/feed',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://2130706433/feed',
    ]) {
      expect(checkTargetUrl(url).ok, url).toBe(false)
    }
  })

  it('rejects non-http protocols and embedded credentials', () => {
    expect(checkTargetUrl('file:///etc/passwd').ok).toBe(false)
    expect(checkTargetUrl('ftp://example.com/feed').ok).toBe(false)
    expect(checkTargetUrl('https://user:pass@example.com/feed').ok).toBe(false)
    expect(checkTargetUrl('https://example.com:22/feed').ok).toBe(false)
  })
})

describe('redirect handling', () => {
  it('re-validates every hop and refuses a redirect into private space', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://example.com/feed') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
      }
      return new Response(FEED)
    }) as unknown as typeof fetch

    await expect(
      fetchWithRevalidatedRedirects('https://example.com/feed', { fetchImpl }),
    ).rejects.toMatchObject({ message: expect.stringContaining('blocked:private-ip') })
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1)
  })

  it('follows a safe relative redirect', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://example.com/feed') {
        return new Response(null, { status: 301, headers: { location: '/feed.xml' } })
      }
      return new Response(FEED, { headers: { 'content-type': 'application/rss+xml' } })
    }) as unknown as typeof fetch

    const result = await fetchWithRevalidatedRedirects('https://example.com/feed', { fetchImpl })
    expect(result.finalUrl).toBe('https://example.com/feed.xml')
    expect(result.hops).toBe(1)
  })

  it('gives up after the redirect budget', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    ) as unknown as typeof fetch
    await expect(
      fetchWithRevalidatedRedirects('https://example.com/feed', { fetchImpl }),
    ).rejects.toBeInstanceOf(ProxyError)
  })
})

describe('response limits', () => {
  it('rejects oversized declared bodies', async () => {
    const response = new Response(FEED, { headers: { 'content-length': '9000000' } })
    await expect(readBodyLimited(response, 1024)).rejects.toMatchObject({
      message: 'response-too-large',
    })
  })

  it('rejects bodies that exceed the cap while streaming', async () => {
    const body = new Uint8Array(4096).fill(65)
    const response = new Response(body)
    await expect(readBodyLimited(response, 1024)).rejects.toMatchObject({
      message: 'response-too-large',
    })
  })

  it('allows feedish content types only', () => {
    expect(isAllowedContentType('application/rss+xml')).toBe(true)
    expect(isAllowedContentType('text/xml; charset=utf-8')).toBe(true)
    expect(isAllowedContentType('image/png')).toBe(false)
    expect(isAllowedContentType('application/octet-stream')).toBe(false)
  })
})

describe('worker handler', () => {
  const env: Env = { ALLOWED_ORIGINS: '*', RATE_LIMIT_PER_MINUTE: '1000' }

  it('answers CORS preflight', async () => {
    const response = await worker.fetch(
      request('https://proxy.test/?url=https://example.com/feed', { method: 'OPTIONS' }),
      env,
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('rejects missing and blocked targets', async () => {
    const missing = await worker.fetch(request('https://proxy.test/'), env)
    expect(missing.status).toBe(400)

    const blocked = await worker.fetch(
      request('https://proxy.test/?url=http%3A%2F%2F127.0.0.1%2Ffeed'),
      env,
    )
    expect(blocked.status).toBe(403)
    expect(await blocked.text()).toContain('blocked:private-ip')
  })

  it('rejects methods other than GET/HEAD', async () => {
    const response = await worker.fetch(
      request('https://proxy.test/?url=https://example.com/feed', { method: 'POST' }),
      env,
    )
    expect(response.status).toBe(405)
  })

  it('returns feed bytes with CORS headers on success', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(FEED, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"x"' },
      }),
    ) as unknown as typeof fetch

    try {
      const response = await worker.fetch(
        request('https://proxy.test/?url=https://example.com/feed', {
          headers: { origin: 'https://app.test', 'cf-connecting-ip': '203.0.113.9' },
        }),
        env,
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('etag')).toBe('"x"')
      expect(response.headers.get('x-feednest-final-url')).toBe('https://example.com/feed')
      expect(await response.text()).toContain('<rss')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refuses non-feed content types', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response('PNG', { headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        request('https://proxy.test/?url=https://example.com/feed'),
        env,
      )
      expect(response.status).toBe(415)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rate limits per client IP', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(
      async () => new Response(FEED, { headers: { 'content-type': 'application/rss+xml' } }),
    ) as unknown as typeof fetch
    try {
      const limited: Env = { RATE_LIMIT_PER_MINUTE: '1' }
      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`
      const call = () =>
        worker.fetch(
          request('https://proxy.test/?url=https://example.com/feed', {
            headers: { 'cf-connecting-ip': ip },
          }),
          limited,
        )
      expect((await call()).status).toBe(200)
      expect((await call()).status).toBe(429)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps upstream failures to a 502 without leaking details', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    try {
      const response = await worker.fetch(
        request('https://proxy.test/?url=https://example.com/feed'),
        env,
      )
      expect(response.status).toBe(502)
      expect(await response.text()).toContain('upstream:500')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
