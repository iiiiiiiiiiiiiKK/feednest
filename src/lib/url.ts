/**
 * URL normalisation + SSRF guards.
 *
 * The same helpers are used by the browser fetch layer (to decide whether a
 * URL is even worth trying) and by the optional Cloudflare Worker proxy
 * (where they become a hard security boundary).
 */

/** Query parameters that only track the reader, never identify the article. */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'source',
  'spm',
  'wt_mc',
  'igshid',
]

/**
 * Normalise an article/feed URL so that the same resource always produces the
 * same string: lower-cased scheme + host, no default port, no fragment, no
 * tracking parameters, no trailing slash on non-root paths, sorted query.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let candidate = raw.trim()
  if (!candidate) return null
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = ''
  }
  url.hash = ''

  const kept: [string, string][] = []
  url.searchParams.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (TRACKING_PARAMS.includes(lower)) return
    if (lower.startsWith('utm_')) return
    kept.push([key, value])
  })
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const search = new URLSearchParams()
  for (const [key, value] of kept) search.append(key, value)
  url.search = search.toString()

  let path = url.pathname.replace(/\/{2,}/g, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '')
  url.pathname = path || '/'

  // `URL` re-encodes some characters; keep the canonical form.
  return url.toString().replace(/\/$/, (match) => (url.pathname === '/' ? match : ''))
}

/** True when the URL looks like an RSS/Atom/XML document by extension. */
export function looksLikeFeedUrl(raw: string): boolean {
  let pathname: string
  try {
    pathname = new URL(raw).pathname.toLowerCase()
  } catch {
    return false
  }
  return /(\.(rss|atom|rdf|xml)$|\/(feed|rss|atom|feeds|index\.xml)(\/)?$)/.test(pathname)
}

/** Hostnames that must never be reachable through the proxy. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
])

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  if (a === 0) return true // "this" network
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

function isPrivateIpv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (bare === '::' || bare === '::1') return true
  if (bare.startsWith('fe80')) return true // link-local
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true // unique local
  if (bare.startsWith('ff')) return true // multicast
  if (bare.startsWith('::ffff:')) {
    // WHATWG URL rewrites IPv4-mapped addresses to hex ("::ffff:7f00:1"),
    // while hand-written inputs may keep the dotted form.
    const rest = bare.slice('::ffff:'.length)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPrivateIpv4(rest)
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const high = Number.parseInt(hex[1], 16)
      const low = Number.parseInt(hex[2], 16)
      const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
      return isPrivateIpv4(dotted)
    }
    return true
  }
  return false
}

export interface UrlGuardResult {
  ok: boolean
  reason?: string
}

/**
 * SSRF guard: reject non-HTTP(S), credentials in the URL, odd ports and any
 * host that points at the local machine, a private network or a metadata
 * service. Deliberately conservative — the proxy is not a general-purpose
 * open relay.
 */
export function assertSafeRemoteUrl(raw: string): UrlGuardResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'protocol-not-allowed' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials-not-allowed' }
  }
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) {
    return { ok: false, reason: 'port-not-allowed' }
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false, reason: 'missing-host' }
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'private-host' }
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'private-host' }
  }

  const isIpv6Literal = host.includes(':')
  if (isIpv6Literal && isPrivateIpv6(host)) return { ok: false, reason: 'private-ip' }
  if (!isIpv6Literal && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIpv4(host)) {
    return { ok: false, reason: 'private-ip' }
  }
  // Decimal / octal / hex IPv4 shorthands ("2130706433", "0x7f.0.0.1").
  if (!isIpv6Literal && /^(0x[0-9a-f]+|\d+)$/.test(host.replace(/\.$/, ''))) {
    return { ok: false, reason: 'private-ip' }
  }

  return { ok: true }
}

/** Same-origin-ish host label for display. */
export function hostOf(raw: string | null): string {
  if (!raw) return ''
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
