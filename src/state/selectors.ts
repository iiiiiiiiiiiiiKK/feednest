/**
 * Derived article views: filtering, sorting, duplicate collapsing and search.
 * Pure functions so they are trivially unit-testable.
 */
import type { Article, FeedSource } from '@/lib/types'
import type { SearchHit } from '@/lib/search'

export type ViewKind = 'all' | 'unread' | 'starred' | 'today' | 'feed' | 'category'

export interface ArticleFilter {
  view: ViewKind
  /** Feed id for `feed`, category id for `category`. */
  scopeId?: string | null
  onlyUnread?: boolean
  onlyStarred?: boolean
  search?: string
  searchHits?: SearchHit[] | null
  sortOrder?: 'newest' | 'oldest'
  collapseDuplicates?: boolean
  now?: number
}

export interface ArticleRow {
  article: Article
  /** How many feeds carry this same article (only when collapsing). */
  duplicates: number
  /** True when the row is the "primary" copy of a duplicated article. */
  alternates: string[]
}

const startOfDay = (now: number): number => {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Apply view + filters and return display rows. */
export function selectArticles(
  articles: Article[],
  feeds: FeedSource[],
  filter: ArticleFilter,
): ArticleRow[] {
  const now = filter.now ?? Date.now()
  const feedIdsInCategory =
    filter.view === 'category' && filter.scopeId
      ? new Set(feeds.filter((feed) => feed.categoryId === filter.scopeId).map((feed) => feed.id))
      : null

  const searchIds =
    filter.searchHits && (filter.search ?? '').trim()
      ? new Map(filter.searchHits.map((hit, position) => [hit.id, position]))
      : null

  let rows = articles.filter((article) => {
    if (filter.view === 'unread' && article.read) return false
    if (filter.view === 'starred' && !article.starred) return false
    // "Today" is about publication. Items whose feed carries no date have an
    // unknown publication time, so they must not sneak into it.
    if (
      filter.view === 'today' &&
      (article.publishedAtSource !== 'feed' || article.publishedAt < startOfDay(now))
    ) {
      return false
    }
    if (filter.view === 'feed' && article.feedId !== filter.scopeId) return false
    if (feedIdsInCategory && !feedIdsInCategory.has(article.feedId)) return false
    if (filter.onlyUnread && article.read) return false
    if (filter.onlyStarred && !article.starred) return false
    if (searchIds && !searchIds.has(article.id)) return false
    return true
  })

  if (filter.collapseDuplicates) {
    rows = collapseDuplicates(rows)
  }

  const order = filter.sortOrder ?? 'newest'
  rows.sort((a, b) => {
    if (searchIds) {
      const rankA = searchIds.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const rankB = searchIds.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (rankA !== rankB) return rankA - rankB
    }
    // Articles without a real publication date sort after dated ones: we know
    // they are new to us, but claiming they are the newest would be a lie.
    const sourceA = a.publishedAtSource === 'feed' ? 0 : 1
    const sourceB = b.publishedAtSource === 'feed' ? 0 : 1
    if (sourceA !== sourceB) return sourceA - sourceB
    const delta = order === 'newest' ? b.publishedAt - a.publishedAt : a.publishedAt - b.publishedAt
    if (delta !== 0) return delta
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  })

  return rows.map((article) => ({ article, duplicates: 0, alternates: [] }))
}

/**
 * Keep one row per real-world article, merging read/star state:
 * if any copy was read, the group is read.
 */
export function collapseDuplicates(articles: Article[]): Article[] {
  const groups = new Map<string, Article[]>()
  for (const article of articles) {
    const key = article.canonicalKey || article.id
    const bucket = groups.get(key)
    if (bucket) bucket.push(article)
    else groups.set(key, [article])
  }
  if (groups.size === articles.length) return articles

  const merged: Article[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0])
      continue
    }
    const sorted = [...group].sort((a, b) => b.publishedAt - a.publishedAt)
    const primary = sorted[0]
    const readCopy = sorted.find((copy) => copy.read)
    const starCopy = sorted.find((copy) => copy.starred)
    merged.push({
      ...primary,
      // Reading the article in any feed means it is read everywhere; the same
      // applies to starring.
      read: Boolean(readCopy),
      readAt: readCopy?.readAt ?? primary.readAt,
      starred: Boolean(starCopy),
      starredAt: starCopy?.starredAt ?? primary.starredAt,
    })
  }
  return merged
}

export interface Stats {
  feeds: number
  total: number
  unread: number
  starred: number
  today: number
  last7DaysRead: number
  perDay: { day: number; count: number }[]
  perFeed: { feedId: string; total: number; unread: number }[]
}

/** Statistics computed from real local rows only. No synthetic values. */
export function computeStats(
  articles: Article[],
  feeds: FeedSource[],
  now = Date.now(),
): Stats {
  const dayStart = startOfDay(now)
  const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000

  const perDayMap = new Map<number, number>()
  for (let index = 0; index < 7; index += 1) {
    perDayMap.set(dayStart - (6 - index) * 24 * 60 * 60 * 1000, 0)
  }

  let unread = 0
  let starred = 0
  let today = 0
  let last7DaysRead = 0
  const perFeedMap = new Map<string, { total: number; unread: number }>()

  for (const article of articles) {
    if (!article.read) unread += 1
    if (article.starred) starred += 1
    // "New today" means it arrived in this browser today, which is the only
    // thing the local database can actually prove.
    if (article.fetchedAt >= dayStart) today += 1

    const bucket = perFeedMap.get(article.feedId) ?? { total: 0, unread: 0 }
    bucket.total += 1
    if (!article.read) bucket.unread += 1
    perFeedMap.set(article.feedId, bucket)

    if (article.read && article.readAt && article.readAt >= weekStart) {
      last7DaysRead += 1
      const dayKey = startOfDay(article.readAt)
      if (perDayMap.has(dayKey)) perDayMap.set(dayKey, (perDayMap.get(dayKey) ?? 0) + 1)
    }
  }

  return {
    feeds: feeds.length,
    total: articles.length,
    unread,
    starred,
    today,
    last7DaysRead,
    perDay: [...perDayMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, count]) => ({ day, count })),
    perFeed: [...perFeedMap.entries()]
      .map(([feedId, value]) => ({ feedId, ...value }))
      .sort((a, b) => b.total - a.total),
  }
}
