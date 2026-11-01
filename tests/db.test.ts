import { beforeEach, describe, expect, it } from 'vitest'
import {
  addFeed,
  articleIdFor,
  createCategory,
  db,
  deleteCategory,
  deleteFeed,
  DuplicateCategoryError,
  DuplicateFeedError,
  ensureDbReady,
  findFeedByUrl,
  ingestItems,
  markAllRead,
  renameCategory,
  setRead,
  setStarred,
  updateFeed,
} from '@/lib/db'
import { parseFeed } from '@/lib/parse'
import { fixture, resetDatabase } from './helpers'

const FEED_URL = 'https://nest.example.com/rss.xml'
const parsed = parseFeed(fixture('rss2.xml'), FEED_URL, Date.UTC(2025, 5, 15))

async function seedFeed() {
  return addFeed({ url: FEED_URL, parsed })
}

beforeEach(async () => {
  await resetDatabase()
})

describe('subscriptions', () => {
  it('adds a feed with metadata parsed from the document', async () => {
    const feed = await seedFeed()
    expect(feed.id).toMatch(/^feed_/)
    expect(feed.title).toBe('Nest Test Journal')
    expect(feed.siteUrl).toBe('https://nest.example.com/')
    expect(feed.paused).toBe(false)
    expect(feed.lastFetchedAt).toBeNull()
  })

  it('refuses the same feed twice', async () => {
    await seedFeed()
    await expect(addFeed({ url: FEED_URL })).rejects.toBeInstanceOf(DuplicateFeedError)
  })

  it('detects duplicates across tracking parameters and slash variants', async () => {
    await seedFeed()
    expect(await findFeedByUrl('https://NEST.example.com/rss.xml?utm_source=x')).toBeTruthy()
    await expect(addFeed({ url: `${FEED_URL}/` })).rejects.toBeInstanceOf(DuplicateFeedError)
  })

  it('deletes a feed together with its articles and bodies', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    expect(await db.articles.count()).toBeGreaterThan(0)
    await deleteFeed(feed.id)
    expect(await db.feeds.count()).toBe(0)
    expect(await db.articles.count()).toBe(0)
    expect(await db.bodies.count()).toBe(0)
  })

  it('keeps custom titles when the feed title changes', async () => {
    const feed = await seedFeed()
    await updateFeed(feed.id, { customTitle: 'My journal', paused: true })
    const stored = await db.feeds.get(feed.id)
    expect(stored?.customTitle).toBe('My journal')
    expect(stored?.paused).toBe(true)
  })
})

describe('article ingestion and deduplication', () => {
  it('stores all usable items on first ingest', async () => {
    const feed = await seedFeed()
    const result = await ingestItems(feed, parsed)
    expect(result.inserted).toBe(parsed.items.length)
    expect(result.updated).toBe(0)
    expect(await db.articles.count()).toBe(parsed.items.length)
    expect(await db.bodies.count()).toBe(parsed.items.length)
  })

  it('does not duplicate on a second ingest of the same document', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const second = await ingestItems(feed, parsed)
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
    expect(await db.articles.count()).toBe(parsed.items.length)
  })

  it('uses the GUID as identity and keeps it stable across URL edits', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const first = parsed.items[0]
    const originalId = articleIdFor(feed.id, first)
    expect(await db.articles.get(originalId)).toBeTruthy()

    const edited = parseFeed(
      fixture('rss2.xml').replace(
        'https://nest.example.com/posts/local-first?utm_source=rss&amp;utm_medium=feed',
        'https://nest.example.com/posts/local-first-renamed',
      ),
      FEED_URL,
      Date.UTC(2025, 5, 15),
    )
    const second = await ingestItems(feed, edited)
    expect(second.inserted).toBe(0)
    const row = await db.articles.get(originalId)
    expect(row?.url).toBe('https://nest.example.com/posts/local-first-renamed')
  })

  it('falls back to the normalised URL when a GUID is missing', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const noGuid = parsed.items.find((item) => item.title === 'Item without a GUID')!
    const expected = `u:${noGuid.url}`
    const row = await db.articles.get(`${feed.id}:${expected}`)
    expect(row).toBeTruthy()
    expect(row?.url).toBe('https://nest.example.com/posts/no-guid')
  })

  it('never resurrects a read article as unread on refresh', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const ids = (await db.articles.toArray()).map((row) => row.id)
    await setRead(ids, true)
    await setStarred([ids[0]], true)

    await ingestItems(feed, parsed)
    const rows = await db.articles.toArray()
    expect(rows.every((row) => row.read)).toBe(true)
    expect(rows.find((row) => row.id === ids[0])?.starred).toBe(true)
  })

  it('updates mutable fields without touching user state', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const full = parsed.items.find((item) => item.title === 'Why local-first software feels different')!
    const id = articleIdFor(feed.id, full)
    await setRead([id], true)

    const edited = parseFeed(
      fixture('rss2.xml').replace(
        'Why local-first software feels different',
        'Why local-first software feels different (updated)',
      ),
      FEED_URL,
      Date.UTC(2025, 5, 15),
    )
    const result = await ingestItems(feed, edited)
    expect(result.updated).toBeGreaterThanOrEqual(1)
    const row = await db.articles.get(id)
    expect(row?.title).toContain('(updated)')
    expect(row?.read).toBe(true)
  })

  it('stores the body separately from the article row', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const rows = await db.articles.toArray()
    const body = await db.bodies.get(rows[0].id)
    expect(body?.html.length).toBeGreaterThan(0)
    expect((rows[0] as unknown as Record<string, unknown>).contentHtml).toBeUndefined()
  })

  it('falls back to the fetch time but labels it', async () => {
    const feed = await seedFeed()
    const fetchedAt = Date.UTC(2025, 5, 20)
    await ingestItems(feed, parsed, fetchedAt)
    const undated = await db.articles
      .filter((row) => row.title === 'Item without a publication date')
      .first()
    expect(undated?.publishedAt).toBe(fetchedAt)
    expect(undated?.publishedAtSource).toBe('fetched')
  })
})

describe('read and favourite state', () => {
  it('persists read state per article', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const ids = (await db.articles.toArray()).slice(0, 3).map((row) => row.id)
    await setRead(ids, true)
    const rows = await db.articles.bulkGet(ids)
    expect(rows.every((row) => row?.read && typeof row.readAt === 'number')).toBe(true)

    await setRead([ids[0]], false)
    expect((await db.articles.get(ids[0]))?.read).toBe(false)
    expect((await db.articles.get(ids[0]))?.readAt).toBeNull()
  })

  it('persists favourite state per article', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const [first] = await db.articles.toArray()
    await setStarred([first.id], true)
    const starred = await db.articles.get(first.id)
    expect(starred?.starred).toBe(true)
    expect(starred?.starredAt).toBeTypeOf('number')
    await setStarred([first.id], false)
    expect((await db.articles.get(first.id))?.starred).toBe(false)
  })

  it('marks everything before a timestamp read, optionally per feed', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const other = await addFeed({ url: 'https://other.test/feed' })
    await ingestItems(other, parseFeed(fixture('atom.xml'), 'https://other.test/feed', Date.now()))

    const cutoff = Date.UTC(2025, 5, 5)
    const marked = await markAllRead({ before: cutoff })
    expect(marked).toBeGreaterThan(0)

    const remaining = await db.articles.filter((row) => !row.read).toArray()
    expect(remaining.every((row) => row.publishedAt > cutoff)).toBe(true)

    const second = await markAllRead({ feedId: other.id })
    expect(second).toBeGreaterThan(0)
    const otherUnread = await db.articles
      .where('feedId')
      .equals(other.id)
      .filter((row) => !row.read)
      .count()
    expect(otherUnread).toBe(0)
  })
})

describe('categories', () => {
  it('creates categories and refuses duplicates by slug', async () => {
    const created = await createCategory('Design')
    expect(created.slug).toBe('design')
    await expect(createCategory('design')).rejects.toBeInstanceOf(DuplicateCategoryError)
    await expect(createCategory('  ')).rejects.toThrow(/required/)
  })

  it('renames a category', async () => {
    const created = await createCategory('Design')
    await renameCategory(created.id, 'Product Design')
    const row = await db.categories.get(created.id)
    expect(row?.name).toBe('Product Design')
    expect(row?.slug).toBe('product-design')
  })

  it('refuses to rename onto an existing slug', async () => {
    await createCategory('Design')
    const second = await createCategory('Engineering')
    await expect(renameCategory(second.id, 'Design')).rejects.toBeInstanceOf(DuplicateCategoryError)
  })

  it('deleting a category keeps feeds and articles, only clearing the link', async () => {
    const category = await createCategory('Design')
    const feed = await addFeed({ url: 'https://keep.example/feed', categoryId: category.id })
    await ingestItems(feed, parseFeed(fixture('atom.xml'), 'https://keep.example/feed', Date.now()))
    const articlesBefore = await db.articles.count()

    await deleteCategory(category.id)

    expect(await db.categories.get(category.id)).toBeUndefined()
    expect((await db.feeds.get(feed.id))?.categoryId).toBeNull()
    expect(await db.articles.count()).toBe(articlesBefore)
  })
})

describe('IndexedDB persistence', () => {
  it('survives a close/reopen cycle', async () => {
    const feed = await seedFeed()
    await ingestItems(feed, parsed)
    const ids = (await db.articles.toArray()).slice(0, 2).map((row) => row.id)
    await setRead(ids, true)
    await setStarred([ids[0]], true)

    db.close()
    await db.open()

    expect(await db.feeds.count()).toBe(1)
    expect(await db.articles.count()).toBe(parsed.items.length)
    expect((await db.articles.get(ids[0]))?.read).toBe(true)
    expect((await db.articles.get(ids[0]))?.starred).toBe(true)
    expect((await db.bodies.get(ids[0]))?.html).toContain('Ownership of data')
  })

  it('seeds the default categories on first run', async () => {
    db.close()
    await db.delete()
    await ensureDbReady()
    const categories = await db.categories.toArray()
    expect(categories.map((row) => row.name)).toEqual(
      expect.arrayContaining(['AI', 'Crypto', 'Technology', 'Development', 'News', 'Blogs', 'Other']),
    )
    const settings = await db.settings.get('app')
    expect(settings?.theme).toBe('system')
  })
})
