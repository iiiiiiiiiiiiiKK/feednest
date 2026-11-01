/**
 * Live data selectors built on Dexie's `useLiveQuery`.
 *
 * The app is small enough to hold article *metadata* in memory (bodies are
 * loaded per article), which makes filtering, search and statistics instant
 * without a server round-trip.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/lib/db'
import { DEFAULT_SETTINGS, type Article, type Category, type FeedSource, type UserSettings } from '@/lib/types'

export interface Library {
  loading: boolean
  settings: UserSettings
  feeds: FeedSource[]
  categories: Category[]
  articles: Article[]
  feedById: Map<string, FeedSource>
  categoryById: Map<string, Category>
  feedTitle: (feedId: string) => string
  unreadByFeed: Map<string, number>
  totalByFeed: Map<string, number>
  unreadTotal: number
  starredTotal: number
  todayCount: number
}

export function useLibrary(): Library {
  const settings = useLiveQuery(() => db.settings.get('app'), [], undefined)
  const feeds = useLiveQuery(() => db.feeds.toArray(), [], undefined)
  const categories = useLiveQuery(() => db.categories.toArray(), [], undefined)
  const articles = useLiveQuery(() => db.articles.toArray(), [], undefined)

  const loading = settings === undefined || feeds === undefined || categories === undefined || articles === undefined

  const safeFeeds = feeds ?? []
  const safeCategories = (categories ?? []).slice().sort((a, b) => a.order - b.order)
  const safeArticles = articles ?? []

  const feedById = new Map(safeFeeds.map((feed) => [feed.id, feed]))
  const categoryById = new Map(safeCategories.map((category) => [category.id, category]))

  const unreadByFeed = new Map<string, number>()
  const totalByFeed = new Map<string, number>()
  let unreadTotal = 0
  let starredTotal = 0
  let todayCount = 0

  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayStartMs = dayStart.getTime()

  for (const article of safeArticles) {
    totalByFeed.set(article.feedId, (totalByFeed.get(article.feedId) ?? 0) + 1)
    if (!article.read) {
      unreadTotal += 1
      unreadByFeed.set(article.feedId, (unreadByFeed.get(article.feedId) ?? 0) + 1)
    }
    if (article.starred) starredTotal += 1
    // Mirrors the "Today" view: only articles with a real feed date today.
    if (article.publishedAtSource === 'feed' && article.publishedAt >= dayStartMs) todayCount += 1
  }

  return {
    loading,
    settings: settings ?? DEFAULT_SETTINGS,
    feeds: safeFeeds,
    categories: safeCategories,
    articles: safeArticles,
    feedById,
    categoryById,
    feedTitle: (feedId: string) => {
      const feed = feedById.get(feedId)
      if (!feed) return 'Unknown feed'
      return feed.customTitle || feed.title
    },
    unreadByFeed,
    totalByFeed,
    unreadTotal,
    starredTotal,
    todayCount,
  }
}
