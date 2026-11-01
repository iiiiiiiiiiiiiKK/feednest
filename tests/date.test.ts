import { describe, expect, it } from 'vitest'
import { parseFeedDate, startOfDaysAgo, startOfToday, formatRelative } from '@/lib/date'
import { fixture } from './helpers'
import { parseFeed } from '@/lib/parse'

const NOW = Date.UTC(2025, 5, 15, 12, 0, 0)

describe('parseFeedDate', () => {
  it('parses RFC-822 with GMT', () => {
    expect(parseFeedDate('Tue, 03 Jun 2025 11:05:30 GMT', NOW)).toBe(Date.UTC(2025, 5, 3, 11, 5, 30))
  })

  it('parses RFC-822 with a numeric offset', () => {
    expect(parseFeedDate('Wed, 04 Jun 2025 08:00:00 +0800', NOW)).toBe(Date.UTC(2025, 5, 4, 0, 0, 0))
  })

  it('parses RFC-822 with a timezone abbreviation', () => {
    expect(parseFeedDate('Mon, 09 Jun 2025 10:00:00 PDT', NOW)).toBe(Date.UTC(2025, 5, 9, 17, 0, 0))
  })

  it('parses RFC-3339 / ISO 8601', () => {
    expect(parseFeedDate('2025-06-09T10:00:00Z', NOW)).toBe(Date.UTC(2025, 5, 9, 10, 0, 0))
    expect(parseFeedDate('2025-06-09T10:00:00+02:00', NOW)).toBe(Date.UTC(2025, 5, 9, 8, 0, 0))
    expect(parseFeedDate('2025-06-09T10:00:00.500Z', NOW)).toBe(Date.UTC(2025, 5, 9, 10, 0, 0, 500))
  })

  it('parses the space-separated variant', () => {
    expect(parseFeedDate('2025-06-09 10:00:00 +0800', NOW)).toBe(Date.UTC(2025, 5, 9, 2, 0, 0))
  })

  it('parses epoch seconds, milliseconds and microseconds', () => {
    expect(parseFeedDate('1749463200', NOW)).toBe(1749463200000)
    expect(parseFeedDate('1749463200000', NOW)).toBe(1749463200000)
    expect(parseFeedDate('1749463200000000', NOW)).toBe(1749463200000)
  })

  it('returns null for garbage instead of throwing', () => {
    expect(parseFeedDate('not a date', NOW)).toBeNull()
    expect(parseFeedDate('', NOW)).toBeNull()
    expect(parseFeedDate(null, NOW)).toBeNull()
    expect(parseFeedDate(undefined, NOW)).toBeNull()
  })

  it('rejects dates that are implausibly far in the future', () => {
    expect(parseFeedDate('2999-01-01T00:00:00Z', NOW)).toBeNull()
  })

  it('rejects dates before 1990', () => {
    expect(parseFeedDate('1970-01-01T00:00:00Z', NOW)).toBeNull()
  })

  it('strips stray markup', () => {
    expect(parseFeedDate('<span>2025-06-09T10:00:00Z</span>', NOW)).toBe(Date.UTC(2025, 5, 9, 10, 0, 0))
  })
})

describe('date helpers', () => {
  it('startOfToday is midnight local time', () => {
    const start = startOfToday(new Date(2025, 5, 15, 23, 59, 59))
    expect(start).toBe(new Date(2025, 5, 15, 0, 0, 0).getTime())
  })

  it('startOfDaysAgo walks back whole days', () => {
    expect(startOfDaysAgo(7, new Date(2025, 5, 15, 18, 0, 0))).toBe(
      new Date(2025, 5, 8, 0, 0, 0).getTime(),
    )
  })

  it('formatRelative degrades gracefully', () => {
    const now = Date.UTC(2025, 5, 15, 12, 0, 0)
    expect(formatRelative(now - 30_000, 'en', now)).toMatch(/now|0m/)
    expect(formatRelative(now - 3 * 3600_000, 'en', now)).toMatch(/3h/)
    expect(formatRelative(now - 2 * 86400_000, 'zh', now)).toContain('2')
    expect(formatRelative(now - 40 * 86400_000, 'en', now)).toMatch(/2025/)
  })
})

describe('dates inside the sample RSS feed', () => {
  it('parses every dated item and leaves undated ones null', () => {
    const feed = parseFeed(fixture('rss2.xml'), 'https://nest.example.com/rss.xml', NOW)
    const dated = feed.items.filter((item) => item.publishedAt !== null)
    expect(dated.length).toBeGreaterThanOrEqual(4)
    for (const item of dated) {
      expect(item.publishedAt).toBeGreaterThan(Date.UTC(2025, 0, 1))
      expect(item.publishedAt).toBeLessThanOrEqual(NOW)
    }
  })
})
