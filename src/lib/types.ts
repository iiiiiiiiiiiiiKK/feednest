/**
 * FeedNest domain model.
 *
 * The whole app is local-first: every entity below lives in the browser's
 * IndexedDB (via Dexie) and is never uploaded anywhere.
 */

/** How an article's body arrived. RSS feeds frequently only ship a summary. */
export type ContentKind = 'full' | 'summary'

/** Where the timestamp used for sorting came from. */
export type PublishedAtSource = 'feed' | 'fetched'

/** How we are allowed to talk to a feed host. */
export type FetchMode = 'auto' | 'direct' | 'proxy'

export type FeedErrorKind =
  | 'cors'
  | 'network'
  | 'timeout'
  | 'http'
  | 'parse'
  | 'blocked'
  | 'unknown'

export interface FeedError {
  kind: FeedErrorKind
  message: string
  at: number
  status?: number
}

/** A subscription. */
export interface FeedSource {
  id: string
  /** Canonical feed URL used for fetching (normalised). */
  url: string
  /** Website the feed belongs to, when discoverable. */
  siteUrl: string | null
  /** Title from the feed itself. */
  title: string
  /** User override; wins over `title` in the UI. */
  customTitle: string | null
  description: string | null
  iconUrl: string | null
  categoryId: string | null
  paused: boolean
  fetchMode: FetchMode
  addedAt: number
  lastFetchedAt: number | null
  lastSuccessAt: number | null
  lastError: FeedError | null
  /** Consecutive failure count, used for exponential backoff. */
  failureCount: number
  etag: string | null
  lastModified: string | null
}

/** Read marker for an article. */
export interface ReadState {
  read: boolean
  readAt: number | null
}

/** Star marker for an article. */
export interface FavoriteState {
  starred: boolean
  starredAt: number | null
}

export interface Article extends ReadState, FavoriteState {
  /** `${feedId}:${guidKey}` — stable, deterministic, dedupe-safe. */
  id: string
  feedId: string
  /** Raw GUID from the feed, if any. */
  guid: string | null
  /** Deterministic identity used inside the feed: `g:`/`u:`/`h:` prefixed. */
  guidKey: string
  /** Cross-feed identity (normalised URL) used to collapse duplicates. */
  canonicalKey: string
  url: string | null
  title: string
  author: string | null
  /** Plain-text excerpt (never HTML). */
  summary: string
  contentKind: ContentKind
  /** Character length of the sanitised body, used to spot stubs. */
  contentLength: number
  imageUrl: string | null
  publishedAt: number
  publishedAtSource: PublishedAtSource
  fetchedAt: number
}

/**
 * Article bodies live in their own table: list views then never pay for the
 * full HTML of thousands of items, only the reader loads one body on demand.
 */
export interface ArticleBody {
  id: string
  html: string
}

export interface Category {
  id: string
  name: string
  /** Lower-cased name; used to keep the default set unique. */
  slug: string
  order: number
  /** Built-in categories cannot be deleted while they hold feeds. */
  builtIn: boolean
  createdAt: number
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type Locale = 'en' | 'zh'
export type SortOrder = 'newest' | 'oldest'
export type RefreshInterval = 0 | 15 | 30 | 60 | 360 | 720

export interface UserSettings {
  id: 'app'
  theme: ThemeMode
  locale: Locale
  /** Minutes between automatic refreshes while the tab is open; 0 = manual. */
  refreshInterval: RefreshInterval
  sortOrder: SortOrder
  /** Optional self-hosted RSS proxy (Cloudflare Worker). Empty = disabled. */
  proxyUrl: string
  /** Default fetch mode for newly added feeds. */
  defaultFetchMode: FetchMode
  /** Collapse articles that appear in more than one feed. */
  collapseDuplicates: boolean
  /** Mark an article read when it is opened in the reader. */
  markReadOnOpen: boolean
  /** Strip images from the reader for a calmer reading layout. */
  hideImages: boolean
  proxyConfiguredAt: number | null
}

export const DEFAULT_SETTINGS: UserSettings = {
  id: 'app',
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

/** Result of parsing one feed document. */
export interface ParsedFeed {
  title: string
  description: string | null
  siteUrl: string | null
  iconUrl: string | null
  items: ParsedItem[]
  /** Detected dialect, useful for diagnostics in the UI. */
  format: 'rss' | 'atom' | 'rdf' | 'unknown'
}

export interface ParsedItem {
  guid: string | null
  url: string | null
  title: string
  author: string | null
  summary: string
  contentHtml: string
  contentKind: ContentKind
  imageUrl: string | null
  publishedAt: number | null
  /** Raw date string kept for troubleshooting only. */
  rawDate: string | null
}

export type BackfillMode = 'merge' | 'replace'

export interface BackupPayload {
  schema: 'feednest.backup'
  version: 1
  exportedAt: number
  settings: Omit<UserSettings, 'id'>
  categories: Category[]
  feeds: FeedSource[]
  articles: Article[]
  /** Sanitised article bodies, keyed by article id. Optional in older files. */
  bodies?: ArticleBody[]
}
