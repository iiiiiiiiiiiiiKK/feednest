import { beforeEach, describe, expect, it } from 'vitest'
import { buildOpml, parseOpml } from '@/lib/opml'
import { addFeed, db, ingestItems } from '@/lib/db'
import { parseFeed } from '@/lib/parse'
import { fixture, resetDatabase } from './helpers'

const OPML = fixture('subscriptions.opml')

describe('OPML import parsing', () => {
  it('reads nested outlines and assigned categories', () => {
    const parsed = parseOpml(OPML)
    expect(parsed.title).toBe('Imported subscriptions')
    expect(parsed.entries).toHaveLength(6)

    const tech = parsed.entries.find((entry) => entry.title === 'Nest Test Journal')!
    expect(tech.xmlUrl).toBe('https://nest.example.com/rss.xml')
    expect(tech.categoryPath).toEqual(['Technology'])

    const deep = parsed.entries.find((entry) => entry.title === 'Deep feed')!
    expect(deep.categoryPath).toEqual(['Blogs', 'Nested group'])

    const loose = parsed.entries.find((entry) => entry.title === 'Loose feed')!
    expect(loose.categoryPath).toEqual([])
  })

  it('flags duplicates inside the file instead of importing them twice', () => {
    const parsed = parseOpml(OPML)
    const duplicate = parsed.entries.find((entry) => entry.title === 'Duplicate of Nest')!
    expect(duplicate.duplicateOf).toContain('duplicate in file')
    expect(duplicate.error).toBeNull()
  })

  it('reports invalid entries individually', () => {
    const parsed = parseOpml(OPML)
    const broken = parsed.entries.find((entry) => entry.title === 'Broken entry')!
    expect(broken.error).toMatch(/Invalid/)
    expect(broken.duplicateOf).toBeNull()
  })

  it('rejects files that are not OPML', () => {
    expect(() => parseOpml('<html><body>nope</body></html>')).toThrow(/OPML/)
    expect(() => parseOpml('')).toThrow(/empty/)
    expect(() => parseOpml('{ "not": "xml" }')).toThrow()
  })

  it('warns when a valid OPML file has no feeds', () => {
    const empty =
      '<?xml version="1.0"?><opml version="2.0"><head/><body><outline text="Folder"/></body></opml>'
    const parsed = parseOpml(empty)
    expect(parsed.entries).toHaveLength(0)
    expect(parsed.warnings.length).toBe(1)
  })
})

describe('OPML export', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('groups feeds by category and round-trips through the parser', async () => {
    const techId = 'cat_technology'
    const feedA = await addFeed({ url: 'https://a.example/feed', categoryId: techId })
    const feedB = await addFeed({ url: 'https://b.example/feed' })
    await db.feeds.update(feedA.id, { title: 'A & B "quoted"' })

    const categories = await db.categories.toArray()
    const feeds = await db.feeds.toArray()
    const xml = buildOpml(feeds, categories)

    expect(xml).toContain('<opml version="2.0">')
    expect(xml).toContain('xmlUrl="https://a.example/feed"')
    expect(xml).toContain('xmlUrl="https://b.example/feed"')
    expect(xml).toContain('&amp;')
    expect(xml).not.toContain('& B')

    const roundTrip = parseOpml(xml)
    const urls = roundTrip.entries.map((entry) => entry.xmlUrl).sort()
    expect(urls).toEqual(['https://a.example/feed', 'https://b.example/feed'])
    expect(roundTrip.entries.find((entry) => entry.xmlUrl.includes('a.example'))?.categoryPath).toEqual([
      'Technology',
    ])
    expect(feedB.id).toBeTruthy()
  })

  it('includes htmlUrl when a site URL is known', async () => {
    const parsed = parseFeed(fixture('rss2.xml'), 'https://nest.example.com/rss.xml', Date.now())
    await addFeed({ url: parsed.siteUrl ? `${parsed.siteUrl}rss.xml` : 'https://nest.example.com/rss.xml', parsed })
    await ingestItems((await db.feeds.toArray())[0], parsed)
    const xml = buildOpml(await db.feeds.toArray(), await db.categories.toArray())
    expect(xml).toContain('htmlUrl="https://nest.example.com/"')
  })

  it('produces a document with no feeds without crashing', async () => {
    const xml = buildOpml([], [])
    expect(xml).toContain('</opml>')
    expect(parseOpml(xml).entries).toHaveLength(0)
  })
})
