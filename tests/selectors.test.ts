import { describe, expect, it } from 'vitest'
import { SearchIndex } from '@/lib/search'
import { collapseDuplicates, computeStats, selectArticles } from '@/state/selectors'
import type { Article, FeedSource } from '@/lib/types'

function article(overrides: Partial<Article>): Article {
  return {
    id: 'a1',
    feedId: 'f1',
    guid: 'g1',
    guidKey: 'g:g1',
    canonicalKey: 'u:https://example.com/1',
    url: 'https://example.com/1',
    title: 'Default title',
    author: null,
    summary: '',
    contentKind: 'summary',
    contentLength: 100,
    imageUrl: null,
    publishedAt: Date.UTC(2025, 5, 1),
    publishedAtSource: 'feed',
    fetchedAt: Date.UTC(2025, 5, 1),
    read: false,
    readAt: null,
    starred: false,
    starredAt: null,
    ...overrides,
  }
}

const feeds: FeedSource[] = [
  {
    id: 'f1',
    url: 'https://a.test/feed',
    siteUrl: null,
    title: 'Alpha Feed',
    customTitle: null,
    description: null,
    iconUrl: null,
    categoryId: 'cat_ai',
    paused: false,
    fetchMode: 'auto',
    addedAt: 0,
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    failureCount: 0,
    etag: null,
    lastModified: null,
  },
  {
    id: 'f2',
    url: 'https://b.test/feed',
    siteUrl: null,
    title: 'Beta Feed',
    customTitle: null,
    description: null,
    iconUrl: null,
    categoryId: null,
    paused: false,
    fetchMode: 'auto',
    addedAt: 0,
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    failureCount: 0,
    etag: null,
    lastModified: null,
  },
]

describe('SearchIndex', () => {
  const docs = [
    { id: '1', title: 'Local-first software', summary: 'ownership of data', author: 'Avery', feedTitle: 'Alpha Feed', feedId: 'f1' },
    { id: '2', title: 'RSS is still useful', summary: 'a quiet protocol that outlived its competitors', author: 'Rin', feedTitle: 'Beta Feed', feedId: 'f2' },
    { id: '3', title: 'Crypto market notes', summary: 'liquidity and funding rates', author: null, feedTitle: 'Alpha Feed', feedId: 'f1' },
  ]

  it('finds matches in titles and ranks them above summary-only hits', () => {
    const index = new SearchIndex(docs)
    const hits = index.search('local')
    expect(hits[0].id).toBe('1')
    expect(hits[0].matchedFields).toContain('title')
  })

  it('searches summaries, authors and feed names', () => {
    const index = new SearchIndex(docs)
    expect(index.search('funding').map((hit) => hit.id)).toContain('3')
    expect(index.search('Avery').map((hit) => hit.id)).toContain('1')
    expect(index.search('beta').map((hit) => hit.id)).toEqual(['2'])
  })

  it('supports prefix matching for partially typed words', () => {
    const index = new SearchIndex(docs)
    expect(index.search('protoc').map((hit) => hit.id)).toContain('2')
  })

  it('requires every term to match (AND semantics)', () => {
    const index = new SearchIndex(docs)
    expect(index.search('crypto liquidity').map((hit) => hit.id)).toEqual(['3'])
    expect(index.search('crypto ownership')).toHaveLength(0)
  })

  it('returns nothing for empty or stop-word-only queries', () => {
    const index = new SearchIndex(docs)
    expect(index.search('')).toHaveLength(0)
    expect(index.search('the of')).toHaveLength(0)
  })

  it('is case-insensitive', () => {
    const index = new SearchIndex(docs)
    expect(index.search('LOCAL').map((hit) => hit.id)).toEqual(['1'])
  })
})

describe('selectArticles', () => {
  const now = Date.UTC(2025, 5, 15, 12)
  const rows: Article[] = [
    article({ id: 'r1', publishedAt: now - 3600_000 }),
    article({ id: 'r2', feedId: 'f2', publishedAt: now - 90 * 86400_000, starred: true }),
    article({ id: 'r3', feedId: 'f2', read: true, publishedAt: now + 3600_000 }),
  ]

  it('filters unread and starred views', () => {
    expect(selectArticles(rows, feeds, { view: 'unread', now }).map((row) => row.article.id)).toEqual(['r1', 'r2'])
    expect(selectArticles(rows, feeds, { view: 'starred', now }).map((row) => row.article.id)).toEqual(['r2'])
  })

  it('restricts Today to items whose feed actually carries a date', () => {
    const withUndated = [
      ...rows,
      article({ id: 'undated', publishedAt: now, publishedAtSource: 'fetched' }),
    ]
    const today = selectArticles(withUndated, feeds, { view: 'today', now })
    expect(today.map((row) => row.article.id)).toEqual(['r3', 'r1'])
  })

  it('sorts undated items after dated ones instead of pretending they are newest', () => {
    const withUndated = [
      ...rows,
      article({ id: 'undated', publishedAt: now + 86_400_000, publishedAtSource: 'fetched' }),
    ]
    const ordered = selectArticles(withUndated, feeds, { view: 'all', now })
    expect(ordered[ordered.length - 1].article.id).toBe('undated')
  })

  it('filters by feed and by category', () => {
    expect(selectArticles(rows, feeds, { view: 'feed', scopeId: 'f2', now }).map((row) => row.article.id).sort()).toEqual([
      'r2',
      'r3',
    ])
    expect(selectArticles(rows, feeds, { view: 'category', scopeId: 'cat_ai', now }).map((row) => row.article.id)).toEqual([
      'r1',
    ])
  })

  it('sorts newest first by default and oldest first on request', () => {
    expect(selectArticles(rows, feeds, { view: 'all', now }).map((row) => row.article.id)).toEqual([
      'r3',
      'r1',
      'r2',
    ])
    expect(
      selectArticles(rows, feeds, { view: 'all', now, sortOrder: 'oldest' }).map((row) => row.article.id),
    ).toEqual(['r2', 'r1', 'r3'])
  })

  it('restricts to search hits and keeps the relevance order', () => {
    const hits = [
      { id: 'r2', score: 9, matchedFields: ['title'] as const },
      { id: 'r1', score: 4, matchedFields: ['summary'] as const },
    ].map((hit) => ({ ...hit, matchedFields: [...hit.matchedFields] }))
    const result = selectArticles(rows, feeds, { view: 'all', now, search: 'x', searchHits: hits })
    expect(result.map((row) => row.article.id)).toEqual(['r2', 'r1'])
  })

  it('applies only-unread and only-starred refinements', () => {
    expect(
      selectArticles(rows, feeds, { view: 'all', now, onlyUnread: true }).map((row) => row.article.id),
    ).toEqual(['r1', 'r2'])
    expect(
      selectArticles(rows, feeds, { view: 'all', now, onlyStarred: true }).map((row) => row.article.id),
    ).toEqual(['r2'])
  })
})

describe('duplicate collapsing', () => {
  it('keeps one row per canonical URL and merges user state', () => {
    const rows = [
      article({ id: 'a', feedId: 'f1', canonicalKey: 'u:same', read: true, readAt: 123 }),
      article({ id: 'b', feedId: 'f2', canonicalKey: 'u:same', starred: true, starredAt: 456 }),
    ]
    const collapsed = collapseDuplicates(rows)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].read).toBe(true)
    expect(collapsed[0].starred).toBe(true)
  })

  it('keeps rows that only one feed carries', () => {
    const rows = [
      article({ id: 'a', canonicalKey: 'u:one' }),
      article({ id: 'b', canonicalKey: 'u:two' }),
    ]
    expect(collapseDuplicates(rows)).toHaveLength(2)
  })

  it('treats a group as read when any copy has been read', () => {
    const rows = [
      article({ id: 'a', canonicalKey: 'u:same', read: true }),
      article({ id: 'b', canonicalKey: 'u:same', read: false }),
    ]
    expect(collapseDuplicates(rows)[0].read).toBe(true)
  })
})

describe('computeStats', () => {
  it('counts from real rows only', () => {
    const now = Date.UTC(2025, 5, 15, 12)
    const rows = [
      article({ id: 's1', publishedAt: now - 1000, fetchedAt: now - 500, read: true, readAt: now - 500 }),
      article({ id: 's2', publishedAt: now - 1000, fetchedAt: now - 400, starred: true }),
      article({
        id: 's3',
        feedId: 'f2',
        publishedAt: now - 10 * 86400_000,
        fetchedAt: now - 10 * 86400_000,
        read: true,
        readAt: now - 9 * 86400_000,
      }),
    ]
    const stats = computeStats(rows, feeds, now)
    expect(stats.feeds).toBe(2)
    expect(stats.total).toBe(3)
    expect(stats.unread).toBe(1)
    expect(stats.starred).toBe(1)
    expect(stats.today).toBe(2)
    expect(stats.last7DaysRead).toBe(1)
    expect(stats.perDay).toHaveLength(7)
    expect(stats.perFeed.find((row) => row.feedId === 'f2')?.total).toBe(1)
  })
})
