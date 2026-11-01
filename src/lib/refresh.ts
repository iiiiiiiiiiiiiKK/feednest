/**
 * Refresh engine: fetch -> parse -> store, with concurrency limits, per-feed
 * isolation (one broken feed never stops the others) and honest status
 * reporting for the UI.
 */
import { db, ingestItems, updateFeed } from './db'
import { backoffDelayMs, fetchFeed, isInBackoff, toFeedError } from './fetchErrors'
import { parseFeed } from './parse'
import type { FeedSource } from './types'

export const MAX_CONCURRENT_FETCHES = 4

export interface RefreshOutcome {
  feedId: string
  feedTitle: string
  ok: boolean
  inserted: number
  updated: number
  notModified: boolean
  transport: 'direct' | 'proxy' | null
  error: string | null
  errorKind: string | null
}

export interface RefreshSummary {
  startedAt: number
  finishedAt: number
  outcomes: RefreshOutcome[]
  inserted: number
  failed: number
}

export interface RefreshOptions {
  proxyUrl?: string
  feedIds?: string[]
  /** Refresh even when the feed is in backoff. */
  force?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number, last: RefreshOutcome) => void
}

/** Run tasks with a bounded number of in-flight promises. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onDone?: (result: R, done: number) => void,
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  let done = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const result = await worker(items[index])
      results[index] = result
      done += 1
      onDone?.(result, done)
    }
  })
  await Promise.all(runners)
  return results
}

export async function refreshFeeds(options: RefreshOptions = {}): Promise<RefreshSummary> {
  const startedAt = Date.now()
  const feeds = await db.feeds.toArray()
  const selected = (options.feedIds
    ? feeds.filter((feed) => options.feedIds!.includes(feed.id))
    : feeds.filter((feed) => !feed.paused)
  ).filter((feed) => options.force || !isInBackoff(feed))

  const outcomes = await runWithConcurrency<FeedSource, RefreshOutcome>(
    selected,
    MAX_CONCURRENT_FETCHES,
    (feed) => refreshOneFeed(feed, options),
    (result, done) => options.onProgress?.(done, selected.length, result),
  )

  return {
    startedAt,
    finishedAt: Date.now(),
    outcomes,
    inserted: outcomes.reduce((sum, outcome) => sum + outcome.inserted, 0),
    failed: outcomes.filter((outcome) => !outcome.ok).length,
  }
}

export async function refreshOneFeed(
  feed: FeedSource,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const base: RefreshOutcome = {
    feedId: feed.id,
    feedTitle: feed.customTitle || feed.title,
    ok: false,
    inserted: 0,
    updated: 0,
    notModified: false,
    transport: null,
    error: null,
    errorKind: null,
  }

  try {
    const result = await fetchFeed(feed.url, {
      proxyUrl: options.proxyUrl ?? '',
      mode: feed.fetchMode,
      etag: feed.etag,
      lastModified: feed.lastModified,
      signal: options.signal,
    })

    if (result.notModified) {
      await updateFeed(feed.id, {
        lastFetchedAt: Date.now(),
        lastSuccessAt: Date.now(),
        failureCount: 0,
        lastError: null,
      })
      return { ...base, ok: true, notModified: true, transport: result.transport }
    }

    const parsed = parseFeed(result.xml, result.finalUrl)
    const ingest = await ingestItems(feed, parsed, Date.now())

    await updateFeed(feed.id, {
      title: feed.customTitle ? feed.title : parsed.title || feed.title,
      siteUrl: parsed.siteUrl ?? feed.siteUrl,
      description: parsed.description ?? feed.description,
      iconUrl: parsed.iconUrl ?? feed.iconUrl,
      lastFetchedAt: Date.now(),
      lastSuccessAt: Date.now(),
      failureCount: 0,
      lastError: null,
      etag: result.etag,
      lastModified: result.lastModified,
    })

    return {
      ...base,
      ok: true,
      inserted: ingest.inserted,
      updated: ingest.updated,
      transport: result.transport,
    }
  } catch (error) {
    const feedError = toFeedError(error)
    const failureCount = feed.failureCount + 1
    await updateFeed(feed.id, {
      lastFetchedAt: Date.now(),
      lastError: feedError,
      failureCount,
    })
    return {
      ...base,
      error: feedError.message,
      errorKind: feedError.kind,
    }
  }
}

export { backoffDelayMs, isInBackoff }
