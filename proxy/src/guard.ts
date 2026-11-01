/**
 * Security guard for the FeedNest RSS proxy.
 *
 * This file is deliberately dependency-free and side-effect-free so it can be
 * unit-tested in Node and audited in isolation. It is the only thing standing
 * between the public internet and an arbitrary-URL fetcher, so it is strict:
 *
 *   - only http/https
 *   - no credentials in the URL
 *   - no localhost / .local / .internal / metadata hostnames
 *   - no private, loopback, link-local, CGNAT, multicast or reserved IPv4/IPv6
 *   - no unusual ports
 *   - a bounded number of redirects, each re-validated
 *
 * Cloudflare Workers already cannot reach a customer's private network, but
 * these checks keep the proxy from being used as a generic relay and protect
 * against DNS tricks that resolve to internal addresses.
 */

export interface UrlCheck {
  ok: boolean
  reason?: string
}

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

export const MAX_REDIRECTS = 3
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 10_000
export const ALLOWED_CONTENT_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/xml',
  'text/xml',
  'text/html',
]

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (nums.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) return false
  const [a, b] = nums
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (bare === '::' || bare === '::1') return true
  if (bare.startsWith('fe80') || bare.startsWith('fc') || bare.startsWith('fd')) return true
  if (bare.startsWith('ff')) return true
  if (bare.startsWith('::ffff:')) {
    const rest = bare.slice('::ffff:'.length)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPrivateIpv4(rest)
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const high = Number.parseInt(hex[1], 16)
      const low = Number.parseInt(hex[2], 16)
      return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'))
    }
    return true
  }
  return false
}

/** Validate one hop of the request. Redirects are validated with this too. */
export function checkTargetUrl(raw: string): UrlCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'protocol-not-allowed' }
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials-not-allowed' }
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) {
    return { ok: false, reason: 'port-not-allowed' }
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false, reason: 'missing-host' }
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'private-host' }
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'private-host' }
  }

  const ipv6 = host.includes(':')
  if (ipv6 && isPrivateIpv6(host)) return { ok: false, reason: 'private-ip' }
  if (!ipv6 && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIpv4(host)) {
    return { ok: false, reason: 'private-ip' }
  }
  if (!ipv6 && /^(0x[0-9a-f]+|\d+)$/.test(host)) return { ok: false, reason: 'private-ip' }

  return { ok: true }
}

/**
 * Follow redirects manually so every hop is re-validated.
 * Returns the final response plus the hop count, or throws a typed error.
 */
export async function fetchWithRevalidatedRedirects(
  target: string,
  init: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ response: Response; finalUrl: string; hops: number }> {
  const fetchImpl = init.fetchImpl ?? fetch
  const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let current = target
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const check = checkTargetUrl(current)
      if (!check.ok) throw new ProxyError(`blocked:${check.reason}`, 403)

      const response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: ALLOWED_CONTENT_TYPES.map((type) => `${type};q=0.9`).join(', '),
          'User-Agent': 'FeedNestProxy/1.0 (+https://github.com/iiiiiiiiiiiiiKK/feednest)',
        },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new ProxyError('redirect-without-location', 502)
        current = new URL(location, current).toString()
        continue
      }

      if (!response.ok) throw new ProxyError(`upstream:${response.status}`, 502)
      return { response, finalUrl: current, hops: hop }
    }
    throw new ProxyError('too-many-redirects', 502)
  } finally {
    clearTimeout(timer)
  }
}

export class ProxyError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ProxyError'
    this.status = status
  }
}

/** Stream the body with a hard byte cap so a large file cannot exhaust memory. */
export async function readBodyLimited(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new ProxyError('response-too-large', 502)
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new ProxyError('response-too-large', 502)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

export function isAllowedContentType(contentType: string | null): boolean {
  if (!contentType) return true
  const type = contentType.split(';')[0].trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.includes(type)
}
