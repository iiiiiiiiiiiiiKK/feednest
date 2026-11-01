/**
 * "Add feed" orchestration: turn whatever the user pasted (feed URL, site
 * homepage, or bare domain) into a parsed feed, without touching the database.
 */
import { discoverFeedUrls, fetchFeed, FeedFetchError, type FetchFeedResult } from './fetch'
import { parseFeed, FeedParseError } from './parse'
import { normalizeUrl } from './url'
import type { ParsedFeed } from './types'

export interface ResolvedFeed {
  /** URL that actually produced the document. */
  url: string
  parsed: ParsedFeed
  transport: 'direct' | 'proxy'
  /** How many candidate URLs were attempted before success. */
  attempts: number
}

export interface ResolveOptions {
  proxyUrl?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onAttempt?: (url: string, attempt: number) => void
}

/**
 * Resolve a URL to a parseable feed.
 *
 * Strategy:
 *   1. try the URL as a feed;
 *   2. if the body is HTML / unparsable, look for <link rel=alternate> and the
 *      usual /feed, /rss.xml … paths, and try those in order.
 */
export async function resolveFeed(input: string, options: ResolveOptions = {}): Promise<ResolvedFeed> {
  const normalized = normalizeUrl(input)
  if (!normalized) throw new FeedFetchError('unknown', 'Please enter a valid http(s) URL')

  let attempts = 0
  const firstError: unknown[] = []

  const tryUrl = async (url: string): Promise<ResolvedFeed | null> => {
    attempts += 1
    options.onAttempt?.(url, attempts)
    try {
      const result: FetchFeedResult = await fetchFeed(url, {
        proxyUrl: options.proxyUrl,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      })
      const parsed = parseFeed(result.xml, result.finalUrl)
      return { url: result.finalUrl, parsed, transport: result.transport, attempts }
    } catch (error) {
      firstError.push(error)
      return null
    }
  }

  const direct = await tryUrl(normalized)
  if (direct) return direct

  const onlyParseOrHttpFailure = firstError.every((error) => {
    if (error instanceof FeedParseError) return true
    if (error instanceof FeedFetchError) return error.kind === 'parse' || error.kind === 'http'
    return false
  })

  // A CORS/network failure will not be fixed by trying more paths on the same
  // origin, so surface it immediately with the honest explanation.
  if (!onlyParseOrHttpFailure) {
    throw firstError[0]
  }

  const discovered = await discoverFeedUrls(normalized, {
    proxyUrl: options.proxyUrl,
    fetchImpl: options.fetchImpl,
  })
  for (const candidate of discovered.candidates) {
    if (candidate === normalized) continue
    if (attempts >= 6) break
    const resolved = await tryUrl(candidate)
    if (resolved) return resolved
  }

  const detail = firstError
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .filter(Boolean)
    .slice(0, 2)
    .join(' / ')
  throw new FeedFetchError(
    'parse',
    detail
      ? `No RSS/Atom feed found at that address (${detail})`
      : 'No RSS/Atom feed found at that address',
  )
}

/** A few real, CORS-friendly feeds so a first-time user can start instantly. */
export const STARTER_FEEDS: { url: string; label: string }[] = [
  { url: 'https://github.blog/feed/', label: 'GitHub Blog' },
  { url: 'https://simonwillison.net/atom/everything/', label: 'Simon Willison' },
  { url: 'https://blog.google/technology/ai/rss/', label: 'Google · AI' },
  { url: 'https://sspai.com/feed', label: '少数派' },
  { url: 'https://overreacted.io/rss.xml', label: 'Overreacted' },
  { url: 'https://dev.to/feed', label: 'DEV Community' },
]
