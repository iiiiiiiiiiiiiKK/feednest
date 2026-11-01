import { describe, expect, it } from 'vitest'
import { assertSafeRemoteUrl, hostOf, looksLikeFeedUrl, normalizeUrl } from '@/lib/url'

describe('normalizeUrl', () => {
  it('canonicalises scheme, host, port and trailing slash', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/Path/')).toBe('https://example.com/Path')
  })

  it('removes tracking parameters but keeps meaningful ones', () => {
    expect(normalizeUrl('https://a.test/p?utm_source=x&id=7&fbclid=1&page=2')).toBe(
      'https://a.test/p?id=7&page=2',
    )
  })

  it('sorts query parameters for stability', () => {
    expect(normalizeUrl('https://a.test/p?b=2&a=1')).toBe(normalizeUrl('https://a.test/p?a=1&b=2'))
  })

  it('drops fragments', () => {
    expect(normalizeUrl('https://a.test/p#section')).toBe('https://a.test/p')
  })

  it('assumes https when the scheme is missing', () => {
    expect(normalizeUrl('example.com/feed.xml')).toBe('https://example.com/feed.xml')
  })

  it('handles protocol-relative URLs', () => {
    expect(normalizeUrl('//example.com/feed')).toBe('https://example.com/feed')
  })

  it('rejects non-http schemes and garbage', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull()
    expect(normalizeUrl('not a url at all')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl(null)).toBeNull()
  })
})

describe('assertSafeRemoteUrl (SSRF guard)', () => {
  it('allows ordinary public HTTP(S) URLs', () => {
    expect(assertSafeRemoteUrl('https://example.com/feed.xml').ok).toBe(true)
    expect(assertSafeRemoteUrl('http://example.com:8080/feed').ok).toBe(true)
  })

  it('blocks non-HTTP protocols', () => {
    expect(assertSafeRemoteUrl('ftp://example.com/feed').ok).toBe(false)
    expect(assertSafeRemoteUrl('file:///etc/passwd').ok).toBe(false)
    expect(assertSafeRemoteUrl('gopher://example.com/').ok).toBe(false)
  })

  it('blocks loopback and localhost names', () => {
    for (const url of [
      'http://localhost/feed',
      'http://127.0.0.1/feed',
      'http://127.1.2.3/feed',
      'http://0.0.0.0/feed',
      'http://app.localhost/feed',
      'http://printer.local/feed',
      'http://service.internal/feed',
    ]) {
      expect(assertSafeRemoteUrl(url).ok, url).toBe(false)
    }
  })

  it('blocks private and link-local ranges (cloud metadata included)', () => {
    for (const url of [
      'http://10.0.0.5/feed',
      'http://172.16.4.1/feed',
      'http://172.31.255.254/feed',
      'http://192.168.1.1/feed',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/feed',
      'http://224.0.0.1/feed',
    ]) {
      expect(assertSafeRemoteUrl(url).ok, url).toBe(false)
    }
  })

  it('blocks IPv6 loopback, unique-local and IPv4-mapped private addresses', () => {
    for (const url of [
      'http://[::1]/feed',
      'http://[fd00::1]/feed',
      'http://[fe80::1]/feed',
      'http://[::ffff:127.0.0.1]/feed',
    ]) {
      expect(assertSafeRemoteUrl(url).ok, url).toBe(false)
    }
  })

  it('blocks numeric/octal IPv4 shorthands and metadata hostnames', () => {
    expect(assertSafeRemoteUrl('http://2130706433/feed').ok).toBe(false)
    expect(assertSafeRemoteUrl('http://0x7f000001/feed').ok).toBe(false)
    expect(assertSafeRemoteUrl('http://metadata.google.internal/').ok).toBe(false)
  })

  it('blocks credentials in the URL and unusual ports', () => {
    expect(assertSafeRemoteUrl('https://user:pass@example.com/feed').ok).toBe(false)
    expect(assertSafeRemoteUrl('http://example.com:22/feed').ok).toBe(false)
  })

  it('allows public IPv4 literals', () => {
    expect(assertSafeRemoteUrl('https://93.184.216.34/feed').ok).toBe(true)
  })
})

describe('small URL helpers', () => {
  it('detects feed-looking paths', () => {
    expect(looksLikeFeedUrl('https://a.test/rss.xml')).toBe(true)
    expect(looksLikeFeedUrl('https://a.test/feed')).toBe(true)
    expect(looksLikeFeedUrl('https://a.test/blog/atom.xml')).toBe(true)
    expect(looksLikeFeedUrl('https://a.test/about')).toBe(false)
  })

  it('extracts a display host', () => {
    expect(hostOf('https://www.example.com/a')).toBe('example.com')
    expect(hostOf('nonsense')).toBe('')
    expect(hostOf(null)).toBe('')
  })
})
