import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyRestore,
  BackupValidationError,
  createBackup,
  createFavoritesExport,
  createReadHistoryExport,
  parseBackup,
  planRestore,
  serializeBackup,
} from '@/lib/backup'
import { addFeed, db, ingestItems, setRead, setStarred } from '@/lib/db'
import { parseFeed } from '@/lib/parse'
import { fixture, resetDatabase } from './helpers'

const FEED_URL = 'https://nest.example.com/rss.xml'

async function seed() {
  const parsed = parseFeed(fixture('rss2.xml'), FEED_URL, Date.UTC(2025, 5, 15))
  const feed = await addFeed({ url: FEED_URL, parsed, categoryId: 'cat_technology' })
  await ingestItems(feed, parsed)
  const rows = await db.articles.toArray()
  await setRead([rows[0].id], true)
  await setStarred([rows[1].id], true)
  return { feed, rows }
}

beforeEach(async () => {
  await resetDatabase()
})

describe('backup creation', () => {
  it('captures feeds, categories, articles and bodies', async () => {
    await seed()
    const payload = await createBackup()
    expect(payload.schema).toBe('feednest.backup')
    expect(payload.version).toBe(1)
    expect(payload.feeds).toHaveLength(1)
    expect(payload.articles.length).toBe(6)
    expect(payload.bodies?.length).toBe(6)
    expect(payload.categories.length).toBeGreaterThan(0)
    expect(payload.settings.theme).toBe('system')
  })

  it('serialises to stable, parseable JSON', async () => {
    await seed()
    const payload = await createBackup()
    const text = serializeBackup(payload)
    expect(JSON.parse(text).schema).toBe('feednest.backup')
  })

  it('exports starred articles and read history as separate documents', async () => {
    await seed()
    const starred = await createFavoritesExport()
    expect(starred.items).toHaveLength(1)
    expect(starred.items[0].feedTitle).toBe('Nest Test Journal')

    const history = await createReadHistoryExport()
    expect(history.items).toHaveLength(1)
    expect(history.items[0].readAt).toBeTypeOf('number')
  })
})

describe('backup validation', () => {
  it('rejects unrelated JSON', () => {
    expect(() => parseBackup('{"schema":"something-else"}')).toThrow(BackupValidationError)
    expect(() => parseBackup('not json')).toThrow(BackupValidationError)
    expect(() => parseBackup('{"schema":"feednest.backup","version":99,"feeds":[],"articles":[]}')).toThrow(
      /Unsupported backup version/,
    )
  })
})

describe('restore planning', () => {
  it('reports nothing to add when restoring the same data over itself', async () => {
    await seed()
    const payload = await createBackup()
    const plan = await planRestore(payload)
    expect(plan.feedsNew).toHaveLength(0)
    expect(plan.articlesNew).toBe(0)
    expect(plan.feedsExisting).toBe(1)
    expect(plan.articlesExisting).toBe(6)
  })

  it('computes what would change for a fresh browser', async () => {
    await seed()
    const payload = await createBackup()

    db.close()
    await db.delete()
    await db.open()

    const plan = await planRestore(payload)
    expect(plan.feedsNew).toHaveLength(1)
    expect(plan.articlesNew).toBe(6)
    expect(plan.categoriesNew.length).toBeGreaterThan(0)
  })
})

describe('restore application', () => {
  it('merge restores into an empty database and keeps bodies', async () => {
    await seed()
    const payload = await createBackup()

    db.close()
    await db.delete()
    await db.open()

    const result = await applyRestore(payload, { mode: 'merge' })
    expect(result.feedsAdded).toBe(1)
    expect(result.articlesAdded).toBe(6)
    const bodies = await db.bodies.toArray()
    expect(bodies.length).toBe(6)
    const read = await db.articles.filter((row) => row.read).toArray()
    expect(read).toHaveLength(1)
  })

  it('merge leaves existing rows untouched', async () => {
    await seed()
    const payload = await createBackup()
    const before = await db.articles.count()

    const result = await applyRestore(payload, { mode: 'merge' })
    expect(result.articlesAdded).toBe(0)
    expect(result.feedsAdded).toBe(0)
    expect(await db.articles.count()).toBe(before)
  })

  it('replace clears existing data first, as the UI warns', async () => {
    await seed()
    const payload = await createBackup()

    // A second, unrelated feed that must disappear after replace.
    const other = await addFeed({ url: 'https://other.example/feed' })
    await ingestItems(other, parseFeed(fixture('atom.xml'), 'https://other.example/feed', Date.now()))
    expect(await db.feeds.count()).toBe(2)

    const result = await applyRestore(payload, { mode: 'replace' })
    expect(result.feedsAdded).toBe(1)
    const feeds = await db.feeds.toArray()
    expect(feeds).toHaveLength(1)
    expect(feeds[0].url).toBe(FEED_URL)
    expect(await db.articles.count()).toBe(6)
  })

  it('restores settings only when asked', async () => {
    await seed()
    const payload = await createBackup()
    payload.settings = { ...payload.settings, theme: 'dark', locale: 'zh' }

    await applyRestore(payload, { mode: 'merge' })
    expect((await db.settings.get('app'))?.theme).toBe('system')

    await applyRestore(payload, { mode: 'merge', restoreSettings: true })
    expect((await db.settings.get('app'))?.theme).toBe('dark')
    expect((await db.settings.get('app'))?.locale).toBe('zh')
  })
})
