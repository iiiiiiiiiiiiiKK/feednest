/**
 * IndexedDB layer (Dexie).
 *
 * Tables
 * ------
 *   feeds       subscriptions
 *   articles    metadata + read/star state (small rows, indexed)
 *   bodies      sanitised article HTML, one row per article
 *   categories  user categories
 *   settings    singleton row
 *
 * Splitting bodies out keeps list rendering cheap: loading 20k article rows
 * never pulls megabytes of HTML into memory.
 */
import Dexie, { type Table } from 'dexie'
import { hashString, uid } from './hash'
import { normalizeUrl } from './url'
import { itemCanonicalKey, itemGuidKey } from './parse'
import {
  DEFAULT_SETTINGS,
  type Article,
  type ArticleBody,
  type Category,
  type FeedSource,
  type ParsedFeed,
  type ParsedItem,
  type UserSettings,
} from './types'

export const DEFAULT_CATEGORIES: { name: string; slug: string }[] = [
  { name: 'AI', slug: 'ai' },
  { name: 'Crypto', slug: 'crypto' },
  { name: 'Technology', slug: 'technology' },
  { name: 'Development', slug: 'development' },
  { name: 'News', slug: 'news' },
  { name: 'Blogs', slug: 'blogs' },
  { name: 'Other', slug: 'other' },
]

export class FeedNestDB extends Dexie {
  feeds!: Table<FeedSource, string>
  articles!: Table<Article, string>
  bodies!: Table<ArticleBody, string>
  categories!: Table<Category, string>
  settings!: Table<UserSettings, string>

  constructor(name = 'feednest') {
    super(name)
    this.version(1).stores({
      feeds: 'id, &url, categoryId, paused, addedAt',
      articles:
        'id, feedId, canonicalKey, publishedAt, read, starred, fetchedAt, readAt, starredAt, [feedId+publishedAt]',
      bodies: 'id',
      categories: 'id, &slug, order',
      settings: 'id',
    })
  }
}

export const db = new FeedNestDB()

let readyPromise: Promise<void> | null = null

/** Open the database and seed defaults once. */
export function ensureDbReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.open()
      await db.transaction('rw', db.settings, db.categories, async () => {
        const settings = await db.settings.get('app')
        if (!settings) await db.settings.put({ ...DEFAULT_SETTINGS })
        if ((await db.categories.count()) === 0) {
          const now = Date.now()
          await db.categories.bulkPut(
            DEFAULT_CATEGORIES.map((entry, index) => ({
              id: `cat_${entry.slug}`,
              name: entry.name,
              slug: entry.slug,
              order: index,
              builtIn: true,
              createdAt: now,
            })),
          )
        }
      })
    })()
  }
  return readyPromise
}

/* ------------------------------------------------------------------ feeds */

export interface AddFeedOptions {
  url: string
  parsed?: ParsedFeed | null
  categoryId?: string | null
  title?: string | null
}

export class DuplicateFeedError extends Error {
  readonly existing: FeedSource

  constructor(existing: FeedSource) {
    super(`Feed already subscribed: ${existing.url}`)
    this.name = 'DuplicateFeedError'
    this.existing = existing
  }
}

export async function findFeedByUrl(rawUrl: string): Promise<FeedSource | undefined> {
  const normalized = normalizeUrl(rawUrl)
  if (!normalized) return undefined
  const exact = await db.feeds.where('url').equals(normalized).first()
  if (exact) return exact
  const all = await db.feeds.toArray()
  return all.find((feed) => normalizeUrl(feed.url) === normalized)
}

export async function addFeed(options: AddFeedOptions): Promise<FeedSource> {
  const normalized = normalizeUrl(options.url)
  if (!normalized) throw new Error('Invalid feed URL')
  const existing = await findFeedByUrl(normalized)
  if (existing) throw new DuplicateFeedError(existing)

  const parsed = options.parsed ?? null
  const feed: FeedSource = {
    id: uid('feed'),
    url: normalized,
    siteUrl: parsed?.siteUrl ?? null,
    title: options.title?.trim() || parsed?.title || normalized,
    customTitle: null,
    description: parsed?.description ?? null,
    iconUrl: parsed?.iconUrl ?? null,
    categoryId: options.categoryId ?? null,
    paused: false,
    fetchMode: 'auto',
    addedAt: Date.now(),
    lastFetchedAt: null,
    lastSuccessAt: null,
    lastError: null,
    failureCount: 0,
    etag: null,
    lastModified: null,
  }
  await db.feeds.put(feed)
  return feed
}

export async function updateFeed(id: string, patch: Partial<FeedSource>): Promise<void> {
  await db.feeds.update(id, patch)
}

export async function deleteFeed(id: string): Promise<void> {
  await db.transaction('rw', db.feeds, db.articles, db.bodies, async () => {
    const ids = (await db.articles.where('feedId').equals(id).primaryKeys()) as string[]
    await db.bodies.bulkDelete(ids)
    await db.articles.where('feedId').equals(id).delete()
    await db.feeds.delete(id)
  })
}

/* --------------------------------------------------------------- articles */

export interface IngestResult {
  inserted: number
  updated: number
  skipped: number
}

/**
 * Store parsed items for a feed.
 *
 * Dedupe authority order: feed GUID -> normalised URL -> title+date hash.
 * Existing read/star flags are never resurrected: a refresh must not make a
 * read article unread again.
 */
export async function ingestItems(
  feed: FeedSource,
  parsed: ParsedFeed,
  fetchedAt = Date.now(),
): Promise<IngestResult> {
  const result: IngestResult = { inserted: 0, updated: 0, skipped: 0 }
  const incoming = parsed.items.map((item) => toArticle(feed, item, fetchedAt))

  await db.transaction('rw', db.articles, db.bodies, async () => {
    const effective = new Map<string, Article>()
    const bodies = new Map<string, string>()

    // Duplicate GUIDs inside one document must collapse before the write.
    parsed.items.forEach((item, index) => {
      const article = incoming[index]
      if (!effective.has(article.id)) {
        effective.set(article.id, article)
        bodies.set(article.id, item.contentHtml)
      }
    })

    const ids = [...effective.keys()]
    const existingRows = await db.articles.bulkGet(ids)
    const existing = new Map<string, Article>()
    existingRows.forEach((row) => {
      if (row) existing.set(row.id, row)
    })

    for (const id of ids) {
      const article = effective.get(id)!
      const previous = existing.get(id)
      if (previous) {
        // Items without a feed date keep the timestamp they were first seen
        // with; otherwise every refresh would push them back to the top.
        const publishedAt =
          article.publishedAtSource === 'fetched' ? previous.publishedAt : article.publishedAt

        const changed =
          previous.title !== article.title ||
          previous.contentLength !== article.contentLength ||
          previous.publishedAt !== publishedAt ||
          previous.imageUrl !== article.imageUrl ||
          previous.url !== article.url
        if (changed) {
          await db.articles.update(id, {
            title: article.title,
            summary: article.summary,
            contentKind: article.contentKind,
            contentLength: article.contentLength,
            imageUrl: article.imageUrl,
            publishedAt,
            url: article.url,
            author: article.author,
          })
          await db.bodies.put({ id, html: bodies.get(id) ?? '' })
          result.updated += 1
        } else {
          result.skipped += 1
        }
        continue
      }
      await db.articles.add(article)
      await db.bodies.put({ id, html: bodies.get(id) ?? '' })
      result.inserted += 1
    }
  })

  return result
}

function toArticle(feed: FeedSource, item: ParsedItem, fetchedAt: number): Article {
  const guidKey = itemGuidKey(item, feed.id)
  const canonicalKey = itemCanonicalKey(item, feed.id)
  const publishedAt = item.publishedAt ?? fetchedAt
  return {
    id: `${feed.id}:${guidKey}`,
    feedId: feed.id,
    guid: item.guid,
    guidKey,
    canonicalKey,
    url: item.url,
    title: item.title,
    author: item.author,
    summary: item.summary,
    contentKind: item.contentKind,
    contentLength: item.contentHtml.length,
    imageUrl: item.imageUrl,
    publishedAt,
    publishedAtSource: item.publishedAt ? 'feed' : 'fetched',
    fetchedAt,
    read: false,
    readAt: null,
    starred: false,
    starredAt: null,
  }
}

export function articleIdFor(feedId: string, item: ParsedItem): string {
  return `${feedId}:${itemGuidKey(item, feedId)}`
}

export async function setRead(ids: string[], read: boolean): Promise<void> {
  if (ids.length === 0) return
  const at = read ? Date.now() : null
  await db.articles.bulkUpdate(ids.map((id) => ({ key: id, changes: { read, readAt: at } })))
}

export async function setStarred(ids: string[], starred: boolean): Promise<void> {
  if (ids.length === 0) return
  const at = starred ? Date.now() : null
  await db.articles.bulkUpdate(
    ids.map((id) => ({ key: id, changes: { starred, starredAt: at } })),
  )
}

/** Mark unread articles at or before `before` as read. Returns the count. */
export async function markAllRead(filter?: { feedId?: string; before?: number }): Promise<number> {
  const now = Date.now()
  const before = filter?.before ?? now
  const rows = await db.articles.where('publishedAt').belowOrEqual(before).toArray()
  const targets = rows.filter((row) => !row.read && (!filter?.feedId || row.feedId === filter.feedId))
  if (targets.length === 0) return 0
  await db.articles.bulkUpdate(
    targets.map((row) => ({ key: row.id, changes: { read: true, readAt: now } })),
  )
  return targets.length
}

/* ------------------------------------------------------------- categories */

export class DuplicateCategoryError extends Error {
  readonly existing: Category

  constructor(existing: Category) {
    super(`Category already exists: ${existing.name}`)
    this.name = 'DuplicateCategoryError'
    this.existing = existing
  }
}

export function slugifyCategory(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `cat-${hashString(name)}`
}

export async function createCategory(name: string): Promise<Category> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Category name is required')
  if (trimmed.length > 40) throw new Error('Category name is too long')
  const slug = slugifyCategory(trimmed)
  const existing = await db.categories.where('slug').equals(slug).first()
  if (existing) throw new DuplicateCategoryError(existing)
  const maxOrder = (await db.categories.toArray()).reduce(
    (max, category) => Math.max(max, category.order),
    -1,
  )
  const category: Category = {
    id: uid('cat'),
    name: trimmed,
    slug,
    order: maxOrder + 1,
    builtIn: false,
    createdAt: Date.now(),
  }
  await db.categories.put(category)
  return category
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Category name is required')
  const category = await db.categories.get(id)
  if (!category) throw new Error('Category not found')
  const slug = slugifyCategory(trimmed)
  const clash = await db.categories.where('slug').equals(slug).first()
  if (clash && clash.id !== id) throw new DuplicateCategoryError(clash)
  await db.categories.update(id, { name: trimmed, slug })
}

/**
 * Deleting a category never deletes feeds or articles — those simply become
 * uncategorised. Enforced here, not only in the UI.
 */
export async function deleteCategory(id: string): Promise<void> {
  await db.transaction('rw', db.categories, db.feeds, async () => {
    const affected = await db.feeds.where('categoryId').equals(id).toArray()
    if (affected.length > 0) {
      await db.feeds.bulkUpdate(
        affected.map((feed) => ({ key: feed.id, changes: { categoryId: null } })),
      )
    }
    await db.categories.delete(id)
  })
}

export async function assignFeedCategory(feedId: string, categoryId: string | null): Promise<void> {
  await db.feeds.update(feedId, { categoryId })
}

/* ---------------------------------------------------------------- settings */

export async function saveSettings(patch: Partial<UserSettings>): Promise<void> {
  const current = (await db.settings.get('app')) ?? { ...DEFAULT_SETTINGS }
  await db.settings.put({ ...current, ...patch, id: 'app' })
}

/* ------------------------------------------------------------- maintenance */

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.feeds, db.articles, db.bodies, db.categories, db.settings, async () => {
    await db.bodies.clear()
    await db.articles.clear()
    await db.feeds.clear()
    await db.categories.clear()
    await db.settings.clear()
  })
  readyPromise = null
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  try {
    const estimate = await navigator.storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}
