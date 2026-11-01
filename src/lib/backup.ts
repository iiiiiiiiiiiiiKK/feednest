/**
 * JSON backup / restore.
 *
 * Restore is non-destructive by construction: `planRestore` computes what
 * *would* happen and the UI shows that plan before anything is written.
 */
import { db } from './db'
import { normalizeUrl } from './url'
import type {
  Article,
  BackupPayload,
  Category,
  FeedSource,
  UserSettings,
} from './types'

export const BACKUP_SCHEMA = 'feednest.backup' as const
export const BACKUP_VERSION = 1

export async function createBackup(): Promise<BackupPayload> {
  const [settings, categories, feeds, articles, bodies] = await Promise.all([
    db.settings.get('app'),
    db.categories.toArray(),
    db.feeds.toArray(),
    db.articles.toArray(),
    db.bodies.toArray(),
  ])
  const settingsCopy: Omit<UserSettings, 'id'> = settings
    ? {
        theme: settings.theme,
        locale: settings.locale,
        refreshInterval: settings.refreshInterval,
        sortOrder: settings.sortOrder,
        proxyUrl: settings.proxyUrl,
        defaultFetchMode: settings.defaultFetchMode,
        collapseDuplicates: settings.collapseDuplicates,
        markReadOnOpen: settings.markReadOnOpen,
        hideImages: settings.hideImages,
        proxyConfiguredAt: settings.proxyConfiguredAt,
      }
    : { ...DEFAULT_SETTINGS_SNAPSHOT }
  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    settings: settingsCopy,
    categories,
    feeds,
    articles,
    bodies,
  }
}

const DEFAULT_SETTINGS_SNAPSHOT: Omit<UserSettings, 'id'> = {
  theme: 'system',
  locale: 'en',
  refreshInterval: 0,
  sortOrder: 'newest',
  proxyUrl: '',
  defaultFetchMode: 'auto',
  collapseDuplicates: true,
  markReadOnOpen: true,
  hideImages: false,
  proxyConfiguredAt: null,
}

export function serializeBackup(payload: BackupPayload): string {
  return JSON.stringify(payload, null, 2)
}

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupValidationError'
  }
}

export function validateBackup(raw: unknown): BackupPayload {
  if (!raw || typeof raw !== 'object') throw new BackupValidationError('Backup is not an object')
  const payload = raw as Partial<BackupPayload>
  if (payload.schema !== BACKUP_SCHEMA) {
    throw new BackupValidationError('Unrecognised file: not a FeedNest backup')
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new BackupValidationError(`Unsupported backup version: ${String(payload.version)}`)
  }
  if (!Array.isArray(payload.feeds) || !Array.isArray(payload.articles)) {
    throw new BackupValidationError('Backup is missing feeds or articles')
  }
  return payload as BackupPayload
}

export function parseBackup(text: string): BackupPayload {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupValidationError('File is not valid JSON')
  }
  return validateBackup(raw)
}

export interface RestorePlan {
  feedsNew: FeedSource[]
  feedsExisting: number
  articlesNew: number
  articlesExisting: number
  categoriesNew: Category[]
  categoriesExisting: number
  settings: BackupPayload['settings'] | null
}

/**
 * Work out which records would be created or skipped. Nothing is written.
 */
export async function planRestore(payload: BackupPayload): Promise<RestorePlan> {
  const [existingFeeds, existingCategories] = await Promise.all([
    db.feeds.toArray(),
    db.categories.toArray(),
  ])
  const feedUrlSet = new Set(
    existingFeeds.map((feed) => normalizeUrl(feed.url)).filter((url): url is string => Boolean(url)),
  )
  const categorySlugSet = new Set(existingCategories.map((category) => category.slug))

  const feedsNew = payload.feeds.filter((feed) => {
    const normalized = normalizeUrl(feed.url)
    return normalized ? !feedUrlSet.has(normalized) : false
  })
  const categoriesNew = payload.categories.filter(
    (category) => !categorySlugSet.has(category.slug),
  )

  const articleIds = payload.articles.map((article) => article.id)
  const existingArticles = await db.articles.bulkGet(articleIds)

  return {
    feedsNew,
    feedsExisting: payload.feeds.length - feedsNew.length,
    articlesNew: existingArticles.filter((row) => !row).length,
    articlesExisting: existingArticles.filter(Boolean).length,
    categoriesNew,
    categoriesExisting: payload.categories.length - categoriesNew.length,
    settings: payload.settings ?? null,
  }
}

export interface RestoreOptions {
  /** `merge` keeps current data and adds what is missing. */
  mode: 'merge' | 'replace'
  /** Restore the settings block too. Defaults to false (safer). */
  restoreSettings?: boolean
}

export interface RestoreResult {
  feedsAdded: number
  articlesAdded: number
  categoriesAdded: number
  settingsRestored: boolean
}

/**
 * Apply a backup. `replace` clears feeds/articles/categories first, so the UI
 * must require an explicit confirmation for it.
 */
export async function applyRestore(
  payload: BackupPayload,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const plan = await planRestore(payload)
  const result: RestoreResult = {
    feedsAdded: 0,
    articlesAdded: 0,
    categoriesAdded: 0,
    settingsRestored: false,
  }

  await db.transaction('rw', db.feeds, db.articles, db.bodies, db.categories, db.settings, async () => {
    if (options.mode === 'replace') {
      await db.bodies.clear()
      await db.articles.clear()
      await db.feeds.clear()
      await db.categories.clear()
    }

    const replacing = options.mode === 'replace'

    // In replace mode every record in the file is written, because the tables
    // were just emptied; in merge mode only the missing ones are.
    const categoriesToAdd = replacing ? payload.categories : plan.categoriesNew
    for (const category of categoriesToAdd) await db.categories.put(category)
    result.categoriesAdded = categoriesToAdd.length

    const feedsToAdd = replacing ? payload.feeds : plan.feedsNew
    for (const feed of feedsToAdd) await db.feeds.put(feed)
    result.feedsAdded = feedsToAdd.length

    const articlesToAdd = replacing ? payload.articles : await filterNewArticles(payload.articles)
    if (articlesToAdd.length > 0) await db.articles.bulkPut(articlesToAdd)
    result.articlesAdded = articlesToAdd.length

    const addedIds = new Set(articlesToAdd.map((article) => article.id))
    const bodiesToAdd = (payload.bodies ?? []).filter((body) => addedIds.has(body.id))
    if (bodiesToAdd.length > 0) await db.bodies.bulkPut(bodiesToAdd)

    if (options.restoreSettings && payload.settings) {
      await db.settings.put({ ...payload.settings, id: 'app' } as UserSettings)
      result.settingsRestored = true
    }
  })

  return result
}

async function filterNewArticles(articles: Article[]): Promise<Article[]> {
  const ids = articles.map((article) => article.id)
  const existing = await db.articles.bulkGet(ids)
  return articles.filter((_, index) => !existing[index])
}

export interface FavoritesExport {
  schema: 'feednest.favorites'
  exportedAt: number
  items: {
    title: string
    url: string | null
    feedTitle: string
    author: string | null
    publishedAt: number
    starredAt: number | null
    summary: string
  }[]
}

export async function createFavoritesExport(): Promise<FavoritesExport> {
  const [starred, feeds] = await Promise.all([
    db.articles.filter((article) => article.starred).toArray(),
    db.feeds.toArray(),
  ])
  const feedTitles = new Map(feeds.map((feed) => [feed.id, feed.customTitle || feed.title]))
  return {
    schema: 'feednest.favorites',
    exportedAt: Date.now(),
    items: starred
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .map((article) => ({
        title: article.title,
        url: article.url,
        feedTitle: feedTitles.get(article.feedId) ?? 'Unknown feed',
        author: article.author,
        publishedAt: article.publishedAt,
        starredAt: article.starredAt,
        summary: article.summary,
      })),
  }
}

export interface ReadHistoryExport {
  schema: 'feednest.read-history'
  exportedAt: number
  items: { articleId: string; title: string; readAt: number | null; url: string | null }[]
}

export async function createReadHistoryExport(): Promise<ReadHistoryExport> {
  const read = await db.articles.filter((article) => article.read).toArray()
  return {
    schema: 'feednest.read-history',
    exportedAt: Date.now(),
    items: read
      .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))
      .map((article) => ({
        articleId: article.id,
        title: article.title,
        readAt: article.readAt,
        url: article.url,
      })),
  }
}
