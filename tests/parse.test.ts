import { describe, expect, it } from 'vitest'
import { parseFeed, FeedParseError, htmlToText, sanitizeHtml, itemGuidKey } from '@/lib/parse'
import { normalizeUrl } from '@/lib/url'
import { fixture } from './helpers'

const NOW = Date.UTC(2025, 5, 15)

describe('RSS 2.0 parsing', () => {
  const feed = parseFeed(fixture('rss2.xml'), 'https://nest.example.com/rss.xml', NOW)

  it('reads channel metadata', () => {
    expect(feed.format).toBe('rss')
    expect(feed.title).toBe('Nest Test Journal')
    expect(feed.siteUrl).toBe('https://nest.example.com/')
    expect(feed.description).toContain('RSS 2.0 sample')
    expect(feed.iconUrl).toBe('https://nest.example.com/logo.png')
  })

  it('reads every item', () => {
    expect(feed.items).toHaveLength(6)
  })

  it('prefers content:encoded over description and marks it full', () => {
    const item = feed.items[0]
    expect(item.title).toBe('Why local-first software feels different')
    expect(item.contentKind).toBe('full')
    expect(item.contentHtml).toContain('Local-first is a promise')
    expect(item.summary).not.toContain('<p>')
    expect(item.author).toBe('Avery Lin')
    expect(item.imageUrl).toBe('https://nest.example.com/images/local-first.jpg')
  })

  it('normalises tracking parameters out of the article URL', () => {
    expect(feed.items[0].url).toBe('https://nest.example.com/posts/local-first')
  })

  it('parses RFC-822 dates with GMT', () => {
    expect(feed.items[0].publishedAt).toBe(Date.UTC(2025, 5, 3, 11, 5, 30))
  })

  it('parses RFC-822 dates with a numeric offset', () => {
    expect(feed.items[1].publishedAt).toBe(Date.UTC(2025, 5, 4, 0, 0, 0))
  })

  it('flags summary-only items instead of inventing content', () => {
    const item = feed.items[1]
    expect(item.contentKind).toBe('summary')
    expect(item.contentHtml).toContain('Only a short excerpt')
    expect(item.summary.length).toBeLessThan(320)
  })

  it('leaves publishedAt null when the item has no date', () => {
    const item = feed.items.find((entry) => entry.title === 'Item without a publication date')
    expect(item).toBeTruthy()
    expect(item!.publishedAt).toBeNull()
    expect(item!.rawDate).toBeNull()
  })

  it('keeps going when a single date is malformed', () => {
    const item = feed.items.find((entry) => entry.title === 'Item with a broken date')
    expect(item).toBeTruthy()
    expect(item!.publishedAt).toBeNull()
    expect(item!.rawDate).toBe('not a real date')
  })

  it('makes relative links absolute and removes scripts', () => {
    const item = feed.items.find((entry) => entry.title === 'Relative links and unsafe markup')!
    expect(item.contentHtml).toContain('href="https://nest.example.com/about"')
    expect(item.contentHtml).toContain('src="https://nest.example.com/img/chart.png"')
    expect(item.contentHtml).not.toContain('onerror')
    expect(item.contentHtml).not.toContain('<script')
  })
})

describe('Atom 1.0 parsing', () => {
  const feed = parseFeed(fixture('atom.xml'), 'https://atom.example.org/feed.xml', NOW)

  it('detects the dialect and metadata', () => {
    expect(feed.format).toBe('atom')
    expect(feed.title).toBe('Nest Atom Notes')
    expect(feed.siteUrl).toBe('https://atom.example.org/')
    expect(feed.iconUrl).toBe('https://atom.example.org/icon.png')
  })

  it('uses rel=alternate links and entry ids', () => {
    expect(feed.items).toHaveLength(3)
    const first = feed.items[0]
    expect(first.url).toBe('https://atom.example.org/entries/atom-full')
    expect(first.guid).toBe('tag:atom.example.org,2025:entry-1')
    expect(first.author).toBe('Rin Okafor')
    expect(first.contentKind).toBe('full')
  })

  it('parses RFC-3339 timestamps', () => {
    expect(feed.items[0].publishedAt).toBe(Date.UTC(2025, 5, 9, 10, 0, 0))
  })

  it('treats summary-only entries as summaries', () => {
    expect(feed.items[1].contentKind).toBe('summary')
  })

  it('falls back to the fetch time when an entry has no timestamp', () => {
    expect(feed.items[2].publishedAt).toBeNull()
  })
})

describe('RSS 1.0 (RDF) parsing', () => {
  it('parses channels and items with dc:date', () => {
    const feed = parseFeed(fixture('rdf.xml'), 'https://rdf.example.net/rss', NOW)
    expect(feed.format).toBe('rdf')
    expect(feed.title).toBe('Nest RDF Feed')
    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].author).toBe('Priya Raman')
    expect(feed.items[0].publishedAt).toBe(Date.UTC(2025, 4, 20, 7, 45, 0))
  })
})

describe('invalid documents', () => {
  it('rejects HTML pages with an actionable message', () => {
    expect(() => parseFeed(fixture('page.html'), 'https://example.com/')).toThrow(FeedParseError)
    expect(() => parseFeed(fixture('page.html'), 'https://example.com/')).toThrow(/HTML page/)
  })

  it('rejects empty bodies', () => {
    expect(() => parseFeed('', 'https://example.com/feed')).toThrow(/Empty response/)
  })

  it('rejects XML without a feed root', () => {
    expect(() => parseFeed('<?xml version="1.0"?><note><to>x</to></note>', 'https://x.test/')).toThrow(
      /No <rss>/,
    )
  })

  it('rejects feeds with no usable items', () => {
    const empty = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'
    expect(() => parseFeed(empty, 'https://x.test/feed')).toThrow(/no items/)
  })

  it('rejects unparsable XML', () => {
    expect(() => parseFeed(fixture('invalid.xml'), 'https://broken.example/rss')).toThrow(FeedParseError)
  })
})

describe('identity keys', () => {
  it('prefers the GUID', () => {
    const feed = parseFeed(fixture('rss2.xml'), 'https://nest.example.com/rss.xml', NOW)
    expect(itemGuidKey(feed.items[0], 'feed_1')).toBe('g:nest-post-001')
  })

  it('falls back to the normalised URL when the GUID is missing', () => {
    const feed = parseFeed(fixture('rss2.xml'), 'https://nest.example.com/rss.xml', NOW)
    const item = feed.items.find((entry) => entry.title === 'Item without a GUID')!
    expect(itemGuidKey(item, 'feed_1')).toBe('u:https://nest.example.com/posts/no-guid')
  })

  it('produces a stable hash when both GUID and URL are missing', () => {
    const keyA = itemGuidKey(
      { guid: null, url: null, title: 'Same title', publishedAt: 1, summary: 'x' } as never,
      'feed_1',
    )
    const keyB = itemGuidKey(
      { guid: null, url: null, title: 'Same title', publishedAt: 1, summary: 'x' } as never,
      'feed_1',
    )
    expect(keyA).toBe(keyB)
    expect(keyA.startsWith('h:')).toBe(true)
  })
})

describe('HTML utilities', () => {
  it('converts HTML to readable text', () => {
    expect(htmlToText('<p>Hello <b>world</b> &amp; friends</p>')).toBe('Hello world & friends')
  })

  it('does not throw on an empty string', () => {
    expect(sanitizeHtml('', null)).toBe('')
  })

  it('keeps safe markup but strips iframes and style', () => {
    const clean = sanitizeHtml(
      '<p style="color:red">ok</p><iframe src="https://evil.test"></iframe><img src="https://x.test/a.png">',
      'https://x.test/',
    )
    expect(clean).toContain('<p>ok</p>')
    expect(clean).not.toContain('iframe')
    expect(clean).not.toContain('style=')
    expect(clean).toContain('src="https://x.test/a.png"')
  })
})

describe('URL normalisation used by the parser', () => {
  it('strips tracking parameters and default ports', () => {
    expect(normalizeUrl('https://Example.com:443/a/?utm_source=x&b=2&a=1#frag')).toBe(
      'https://example.com/a?a=1&b=2',
    )
  })
})
