/**
 * FeedNest RSS proxy — an optional Cloudflare Worker.
 *
 * Purpose: let the browser read feeds whose hosts do not send
 * `Access-Control-Allow-Origin`. Nothing more. It is not a general-purpose
 * fetcher, it does not cache, and it stores no article content or user data.
 *
 * Deployment: see proxy/README.md. Requests look like
 *
 *   GET https://<worker>.workers.dev/?url=https%3A%2F%2Fexample.com%2Ffeed.xml
 */
import {
  checkTargetUrl,
  fetchWithRevalidatedRedirects,
  isAllowedContentType,
  ProxyError,
  readBodyLimited,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from './guard'

export interface Env {
  /** Comma-separated list of allowed browser origins; "*" allows any. */
  ALLOWED_ORIGINS?: string
  /** Requests per minute per client IP (in-memory, per isolate). */
  RATE_LIMIT_PER_MINUTE?: string
  /** Hard cap on response bytes. */
  MAX_BYTES?: string
}

/* Best-effort, per-isolate rate limiter. Cloudflare may run many isolates, so
 * this is a coarse guard, not a billing-grade limiter. It exists to make
 * accidental loops and trivial abuse expensive, not to be perfect. */
const buckets = new Map<string, { count: number; resetAt: number }>()

function rateLimited(ip: string, limit: number, now = Date.now()): boolean {
  const bucket = buckets.get(ip)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 })
    return false
  }
  bucket.count += 1
  return bucket.count > limit
}

function corsHeaders(origin: string | null, allowed: string): Record<string, string> {
  const allowedOrigin =
    allowed === '*' ? '*' : allowed.split(',').map((value) => value.trim()).filter(Boolean)
  const value =
    allowedOrigin === '*'
      ? '*'
      : Array.isArray(allowedOrigin) && origin && allowedOrigin.includes(origin)
        ? origin
        : Array.isArray(allowedOrigin) && allowedOrigin.length > 0
          ? (allowedOrigin[0] as string)
          : 'null'
  return {
    'access-control-allow-origin': value,
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Accept, If-None-Match, If-Modified-Since',
    'access-control-expose-headers': 'ETag, Last-Modified, Content-Type',
    vary: 'Origin',
  }
}

function errorResponse(status: number, code: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    const headers = corsHeaders(origin, env.ALLOWED_ORIGINS ?? '*')

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }
    if (request.method !== 'GET') {
      return errorResponse(405, 'method-not-allowed', headers)
    }

    const target = url.searchParams.get('url')
    if (!target) return errorResponse(400, 'missing-url', headers)

    const check = checkTargetUrl(target)
    if (!check.ok) return errorResponse(403, `blocked:${check.reason}`, headers)

    const limit = Number(env.RATE_LIMIT_PER_MINUTE ?? '120')
    const ip =
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      'unknown'
    if (rateLimited(ip, Number.isFinite(limit) ? limit : 120)) {
      return errorResponse(429, 'rate-limited', headers)
    }

    const maxBytes = Number(env.MAX_BYTES ?? String(MAX_RESPONSE_BYTES))

    try {
      const { response, finalUrl } = await fetchWithRevalidatedRedirects(target, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      })

      const contentType = response.headers.get('content-type')
      if (!isAllowedContentType(contentType)) {
        return errorResponse(415, 'content-type-not-allowed', headers)
      }

      const body = await readBodyLimited(response, maxBytes)
      const responseHeaders: Record<string, string> = {
        'content-type': contentType ?? 'application/xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-feednest-final-url': finalUrl,
        ...headers,
      }

      const etag = response.headers.get('etag')
      if (etag) responseHeaders.etag = etag
      const lastModified = response.headers.get('last-modified')
      if (lastModified) responseHeaders['last-modified'] = lastModified

      // Copy into a plain ArrayBuffer: `Response` does not accept a typed
      // array that might be backed by a SharedArrayBuffer.
      const payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
      return new Response(payload, { status: 200, headers: responseHeaders })
    } catch (error) {
      if (error instanceof ProxyError) {
        return errorResponse(error.status, error.message, headers)
      }
      // Timeouts surface as AbortError; anything else is an upstream failure.
      const message = (error as Error)?.name === 'AbortError' ? 'timeout' : 'upstream-unreachable'
      return errorResponse(504, message, headers)
    }
  },
}
