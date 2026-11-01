/**
 * Date parsing that is tolerant of what real feeds actually contain.
 *
 * RSS 2.0 says RFC-822, Atom says RFC-3339, and publishers happily mix in
 * "GMT+8", "last Tuesday", epoch seconds and empty strings.
 */

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

/** Timezone abbreviations we are willing to guess. */
const TZ_OFFSETS: Record<string, number> = {
  GMT: 0,
  UT: 0,
  UTC: 0,
  Z: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  BST: 60,
  CET: 60,
  CEST: 120,
  IST: 330,
  JST: 540,
  KST: 540,
  AEST: 600,
  AEDT: 660,
}

const MIN_VALID = Date.UTC(1990, 0, 1)
/** Anything further in the future than this is treated as a broken date. */
const MAX_SKEW_MS = 48 * 60 * 60 * 1000

/**
 * Parse a feed date into epoch milliseconds.
 * Returns `null` when the value cannot be interpreted, so callers can fall
 * back to the fetch time and label it as such.
 */
export function parseFeedDate(input: string | null | undefined, now = Date.now()): number | null {
  if (input == null) return null
  let value = String(input).trim()
  if (!value) return null
  // Strip HTML that occasionally leaks into <updated>.
  value = value.replace(/<[^>]*>/g, ' ').trim()

  // Plain epoch values (seconds, ms, or microseconds).
  if (/^\d{9,16}$/.test(value)) {
    const num = Number(value)
    const ms = value.length <= 10 ? num * 1000 : value.length <= 13 ? num : num / 1000
    return finalize(ms, now)
  }

  // "2024-05-01 12:00:00 +0800" -> "2024-05-01T12:00:00+08:00"
  const isoish = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i,
  )
  if (isoish) {
    const [, y, mo, d, h, mi, s = '00', frac = '0', tz] = isoish
    let ms = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number(frac.padEnd(3, '0').slice(0, 3)),
    )
    if (tz && tz.toUpperCase() !== 'Z') {
      const sign = tz.startsWith('-') ? -1 : 1
      const digits = tz.replace(/[:+-]/g, '')
      const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))
      ms -= sign * offsetMinutes * 60 * 1000
    }
    return finalize(ms, now)
  }

  // RFC-822 / RFC-2822: "Tue, 03 Jun 2008 11:05:30 GMT+8" or "03 Jun 2008 11:05 +0200"
  const rfc = value.match(
    /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(.*)$/,
  )
  if (rfc) {
    const [, d, monName, y, h, mi, s = '00', rest] = rfc
    const month = MONTHS[monName.slice(0, 3).toLowerCase()]
    if (month === undefined) return null
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y)
    let ms = Date.UTC(year, month, Number(d), Number(h), Number(mi), Number(s))
    const tzMatch = rest.trim().match(/^(?:GMT|UTC|UT)?\s*([+-])(\d{1,2}):?(\d{2})?$/i)
    if (tzMatch) {
      const sign = tzMatch[1] === '-' ? -1 : 1
      ms -= sign * (Number(tzMatch[2]) * 60 + Number(tzMatch[3] ?? '0')) * 60 * 1000
    } else {
      const abbr = rest.trim().toUpperCase().replace(/[^A-Z]/g, '')
      if (abbr && abbr in TZ_OFFSETS) ms -= TZ_OFFSETS[abbr] * 60 * 1000
    }
    return finalize(ms, now)
  }

  // Last resort: the platform parser (handles plenty of odd ISO variants).
  const parsed = Date.parse(value)
  if (!Number.isNaN(parsed)) return finalize(parsed, now)

  return null
}

function finalize(ms: number, now: number): number | null {
  if (!Number.isFinite(ms)) return null
  if (ms < MIN_VALID) return null
  if (ms > now + MAX_SKEW_MS) return null
  return Math.round(ms)
}

/** Human-friendly absolute time, locale aware. */
export function formatDateTime(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

export function formatDate(ts: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ts))
}

/** "3m", "5h", "2d" — compact relative time for dense lists. */
export function formatRelative(ts: number, locale: string, now = Date.now()): string {
  const diff = now - ts
  if (diff < 0) return formatDate(ts, locale)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return locale === 'zh' ? '刚刚' : 'now'
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return locale === 'zh' ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return locale === 'zh' ? `${days} 天前` : `${days}d ago`
  return formatDate(ts, locale)
}

/** Start of the current day in local time. */
export function startOfToday(now = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startOfDaysAgo(days: number, now = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.getTime()
}
