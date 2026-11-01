/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 parsing.
 *
 * Design notes
 * ------------
 * - We use `fast-xml-parser` (MIT, maintained) instead of DOMParser so the same
 *   code path runs in workers, tests and browsers, and so we get predictable
 *   handling of the deeply malformed XML that real feeds contain.
 * - Every piece of text that can contain HTML is sanitised with DOMPurify
 *   before it ever reaches React. Nothing from a feed is trusted.
 * - Nothing here invents content: if a feed only ships a summary, the article
 *   is flagged `contentKind: 'summary'` and the UI says so.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import DOMPurify, { type Config } from 'dompurify'
import { hashString, squash, truncate } from './hash'
import { normalizeUrl } from './url'
import { parseFeedDate } from './date'
import type { ContentKind, ParsedFeed, ParsedItem } from './types'

type XmlNode = unknown

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  allowBooleanAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) =>
    ['item', 'entry', 'link', 'category', 'enclosure', 'author'].includes(name.toLowerCase()),
})

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedParseError'
  }
}

function lowerKeys(node: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const [key, value] of Object.entries(node)) {
    map.set(key.toLowerCase(), value)
  }
  return map
}

/** Read the first child matching any of the given (case-insensitive) names. */
function child(node: XmlNode, ...names: string[]): unknown {
  if (!node || typeof node !== 'object') return undefined
  const map = lowerKeys(node as Record<string, unknown>)
  for (const name of names) {
    if (name.includes(':')) {
      if (map.has(name.toLowerCase())) return map.get(name.toLowerCase())
      continue
    }
    // Match "encoded" against "content:encoded" as well.
    for (const [key, value] of map) {
      if (key === name || key.endsWith(`:${name}`)) return value
    }
  }
  return undefined
}

/** Flatten a parsed node into plain text. */
function text(node: XmlNode): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return text(node[0] as XmlNode)
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (typeof obj['#text'] === 'string') return obj['#text']
    if (typeof obj['#text'] === 'number') return String(obj['#text'])
  }
  return ''
}

/** Read an attribute case-insensitively. */
function attr(node: XmlNode, name: string): string | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  const direct = obj[`@_${name}`]
  if (typeof direct === 'string') return direct
  if (typeof direct === 'number') return String(direct)
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === `@_${lower}` && typeof value === 'string') return value
  }
  return null
}

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy')
    node.setAttribute('decoding', 'async')
    node.setAttribute('referrerpolicy', 'no-referrer')
  }
})

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark',
    'small', 'sub', 'sup', 'blockquote', 'q', 'cite', 'code', 'pre', 'kbd', 'samp',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'a', 'img', 'figure', 'figcaption', 'picture', 'source',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'video', 'audio', 'track', 'abbr', 'time',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'srcset', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan',
    'class', 'id', 'datetime', 'lang', 'dir', 'loading', 'decoding', 'referrerpolicy',
    'controls', 'poster', 'type', 'sizes', 'media', 'target', 'rel',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style', 'srcdoc'],
}

/** Sanitise feed HTML and make relative links/images absolute. */
export function sanitizeHtml(html: string, baseUrl: string | null): string {
  if (!html) return ''
  const absolute = absolutize(html, baseUrl)
  // DOMPurify returns a TrustedHTML type in newer typings; coerce to string.
  const clean = DOMPurify.sanitize(absolute, SANITIZE_CONFIG) as unknown as string
  return stripEmptyParagraphs(clean)
}

function absolutize(html: string, baseUrl: string | null): string {
  if (!baseUrl) return html
  return html
    .replace(/\s(href|src)\s*=\s*(["'])(\/\/[^"']*)\2/gi, (_m, attrName, q, url) => ` ${attrName}=${q}https:${url}${q}`)
    .replace(/\s(href|src)\s*=\s*(["'])(\/(?!\/)[^"']*)\2/gi, (_m, attrName, q, url) => {
      try {
        return ` ${attrName}=${q}${new URL(url, baseUrl).toString()}${q}`
      } catch {
        return ` ${attrName}=${q}${url}${q}`
      }
    })
}

function stripEmptyParagraphs(html: string): string {
  return html.replace(/<p>\s*(?:&nbsp;|\s)*<\/p>/gi, '').trim()
}

/** HTML -> readable plain text, used for list excerpts and search. */
export function htmlToText(html: string): string {
  if (!html) return ''
  let out = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  out = decodeEntities(out)
  return squash(out)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()]
    return named ?? match
  })
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (code <= 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** Best-effort first image, used as a list thumbnail. */
function firstImage(html: string): string | null {
  const match = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i)
  if (!match) return null
  const src = match[1].trim()
  if (!src || src.startsWith('data:')) return null
  return src
}

function mediaImage(item: Record<string, unknown>): string | null {
  const mediaContent = asArray(item['media:content'] as XmlNode)
  for (const node of mediaContent) {
    const type = attr(node, 'type') ?? ''
    const url = attr(node, 'url')
    if (url && (type.startsWith('image') || !type)) return url
  }
  const thumbnails = asArray(item['media:thumbnail'] as XmlNode)
  for (const node of thumbnails) {
    const url = attr(node, 'url')
    if (url) return url
  }
  const enclosure = asArray(item.enclosure as XmlNode)
  for (const node of enclosure) {
    const type = attr(node, 'type') ?? ''
    const url = attr(node, 'url')
    if (url && type.startsWith('image')) return url
  }
  const itunes = item['itunes:image']
  if (itunes) {
    const href = attr(itunes, 'href')
    if (href) return href
  }
  return null
}

function atomLink(item: Record<string, unknown>): string | null {
  const links = asArray(item.link as XmlNode)
  let fallback: string | null = null
  for (const node of links) {
    if (typeof node === 'string') {
      if (!fallback) fallback = node
      continue
    }
    const href = attr(node, 'href')
    if (!href) continue
    const rel = (attr(node, 'rel') ?? 'alternate').toLowerCase()
    const type = (attr(node, 'type') ?? '').toLowerCase()
    if (rel === 'alternate' && (type === '' || type.includes('html'))) return href
    if (rel === 'alternate' && !fallback) fallback = href
  }
  return fallback ?? text(firstOf(item.link as XmlNode)) ?? null
}

function detectFormat(root: Record<string, unknown>): 'rss' | 'atom' | 'rdf' | 'unknown' {
  const keys = Object.keys(root).map((k) => k.toLowerCase())
  if (keys.includes('rss')) return 'rss'
  if (keys.includes('feed')) return 'atom'
  if (keys.some((k) => k === 'rdf:rdf' || k === 'rdf')) return 'rdf'
  return 'unknown'
}

function channelOf(root: Record<string, unknown>, format: string): Record<string, unknown> {
  if (format === 'rss') {
    const rss = root.rss ?? root.RSS
    const channel = firstOf(child(rss as XmlNode, 'channel') as XmlNode)
    return (channel && typeof channel === 'object' ? channel : {}) as Record<string, unknown>
  }
  if (format === 'rdf') {
    const rdf = (root['rdf:RDF'] ?? root['RDF'] ?? root.rdf) as Record<string, unknown> | undefined
    const channel = rdf ? child(rdf, 'channel') : undefined
    return (channel && typeof channel === 'object' ? channel : {}) as Record<string, unknown>
  }
  if (format === 'atom') {
    return root.feed as Record<string, unknown>
  }
  return {}
}

function itemsOf(root: Record<string, unknown>, format: string): Record<string, unknown>[] {
  if (format === 'rss') {
    const channel = channelOf(root, format)
    return asArray(child(channel, 'item') as XmlNode).filter(
      (n): n is Record<string, unknown> => !!n && typeof n === 'object',
    )
  }
  if (format === 'rdf') {
    const rdf = (root['rdf:RDF'] ?? root['RDF'] ?? root.rdf) as Record<string, unknown> | undefined
    const direct = rdf ? child(rdf, 'item') : undefined
    const list = asArray(direct as XmlNode).filter(
      (n): n is Record<string, unknown> => !!n && typeof n === 'object',
    )
    if (list.length) return list
    return asArray(rdf?.item as XmlNode).filter(
      (n): n is Record<string, unknown> => !!n && typeof n === 'object',
    )
  }
  if (format === 'atom') {
    const feed = root.feed as Record<string, unknown>
    return asArray(child(feed, 'entry') as XmlNode).filter(
      (n): n is Record<string, unknown> => !!n && typeof n === 'object',
    )
  }
  return []
}

/** Site/link for the feed itself. */
function channelLink(channel: Record<string, unknown>, format: string): string | null {
  if (format === 'atom') {
    const href = atomLink(channel)
    return href ? normalizeUrl(href) : null
  }
  const direct = normalizeUrl(text(child(channel, 'link') as XmlNode))
  if (direct) return direct
  const atom = asArray(channel.link as XmlNode)
  for (const node of atom) {
    const href = attr(node, 'href')
    if (href) return normalizeUrl(href)
  }
  return null
}

function channelIcon(channel: Record<string, unknown>, siteUrl: string | null): string | null {
  const image = child(channel, 'image') as XmlNode
  if (image && typeof image === 'object') {
    const url = normalizeUrl(text(child(image, 'url') as XmlNode))
    if (url) return url
  }
  for (const key of ['icon', 'logo', 'itunes:image']) {
    const node = child(channel, key) as XmlNode
    if (!node) continue
    const href = attr(node, 'href') ?? text(node)
    const value = normalizeUrl(href)
    if (value) return value
  }
  if (siteUrl) {
    try {
      return `${new URL(siteUrl).origin}/favicon.ico`
    } catch {
      return null
    }
  }
  return null
}

interface BuildContext {
  feedUrl: string
  now: number
}

function buildItem(raw: Record<string, unknown>, ctx: BuildContext): ParsedItem | null {
  const title = squash(decodeEntities(text(child(raw, 'title') as XmlNode)))
  const rawLink =
    normalizeUrl(atomLink(raw)) ??
    normalizeUrl(text(child(raw, 'link') as XmlNode)) ??
    normalizeUrl(text(child(raw, 'origlink') as XmlNode))
  const link = rawLink

  const guidRaw = text(child(raw, 'guid', 'id') as XmlNode)
  const guid = guidRaw ? squash(decodeEntities(guidRaw)) : null

  const contentEncoded = text(child(raw, 'encoded', 'content:encoded') as XmlNode)
  const atomContent = text(child(raw, 'content') as XmlNode)
  const description = text(child(raw, 'description', 'summary') as XmlNode)
  const fullBody = contentEncoded || atomContent
  const rawBody = fullBody || description

  const html = rawBody ? sanitizeHtml(rawBody, link ?? ctx.feedUrl) : ''
  const plain = htmlToText(html)

  // A dedicated content element means the publisher ships the body. Short
  // bodies still exist ("read more" stubs), so require a reasonable length
  // before promising the reader a full article.
  const contentKind: ContentKind =
    fullBody && htmlToText(fullBody).length >= 200 ? 'full' : 'summary'

  const rawDate =
    text(child(raw, 'pubdate', 'published', 'issued', 'date') as XmlNode) ||
    text(child(raw, 'updated', 'modified') as XmlNode) ||
    null
  const publishedAt = parseFeedDate(rawDate, ctx.now)

  const authorRaw = child(raw, 'author', 'creator', 'dc:creator')
  const authorNode = Array.isArray(authorRaw) ? authorRaw[0] : authorRaw
  let author = squash(decodeEntities(text(authorNode)))
  if (!author && authorNode && typeof authorNode === 'object') {
    author = squash(decodeEntities(text(child(authorNode, 'name'))))
  }
  if (author.includes('@') && author.includes('.') && !author.includes(' ')) {
    // RSS <author> is often an email address; keep it readable.
    author = author.replace(/^([^@]+)@.*$/, '$1')
  }

  // An item is only useful if we can show or link something.
  if ((!title && !link) || (!link && !plain)) return null

  const image = mediaImage(raw) ?? (imageUrlFromHtml(html) || null)
  const fallbackTitle = plain ? truncate(plain, 70) : (link ?? 'Untitled')

  return {
    guid,
    url: link,
    title: title || fallbackTitle,
    author: author || null,
    summary: truncate(plain, 320),
    contentHtml: html,
    contentKind,
    imageUrl: image,
    publishedAt,
    rawDate: rawDate ? squash(rawDate) : null,
  }
}

function imageUrlFromHtml(html: string): string | null {
  return firstImage(html)
}

/**
 * Parse a feed document.
 *
 * @throws {FeedParseError} when the document is not a usable feed.
 */
export function parseFeed(xml: string, feedUrl: string, now = Date.now()): ParsedFeed {
  const trimmed = xml.replace(/^\uFEFF/, '').trim()
  if (!trimmed) throw new FeedParseError('Empty response body')

  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    throw new FeedParseError('Response is an HTML page, not an RSS/Atom feed')
  }

  const validation = XMLValidator.validate(trimmed, { allowBooleanAttributes: true })
  let parsed: unknown
  if (validation !== true) {
    // Plenty of live feeds are technically invalid; try anyway, but keep the
    // original error message for the diagnostics panel.
    try {
      parsed = parser.parse(trimmed)
    } catch (error) {
      throw new FeedParseError(
        `Malformed XML: ${validation.err?.msg ?? (error as Error).message}`,
      )
    }
  } else {
    try {
      parsed = parser.parse(trimmed)
    } catch (error) {
      throw new FeedParseError(`Could not parse XML: ${(error as Error).message}`)
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new FeedParseError('Document has no XML root element')
  }

  const rootRecord = parsed as Record<string, unknown>
  const format = detectFormat(rootRecord)
  if (format === 'unknown') {
    if (Object.keys(rootRecord).some((key) => key.toLowerCase().includes('rss'))) {
      // fall through, some feeds use odd casing
    } else {
      throw new FeedParseError('No <rss>, <feed> or <rdf:RDF> root element found')
    }
  }

  const channel = channelOf(rootRecord, format === 'unknown' ? 'rss' : format)
  const rawItems = itemsOf(rootRecord, format === 'unknown' ? 'rss' : format)
  if (rawItems.length === 0) {
    throw new FeedParseError('Feed contains no items — the URL may not be a feed')
  }

  const siteUrl = channelLink(channel, format === 'atom' ? 'atom' : 'rss')
  const title = squash(decodeEntities(text(child(channel, 'title') as XmlNode))) || 'Untitled feed'
  const descriptionRaw = text(child(channel, 'description', 'subtitle', 'tagline') as XmlNode)
  const description = descriptionRaw ? truncate(squash(decodeEntities(descriptionRaw)), 300) : null

  const ctx: BuildContext = { feedUrl, now }
  const items: ParsedItem[] = []
  for (const raw of rawItems) {
    const built = buildItem(raw, ctx)
    if (built) items.push(built)
  }
  if (items.length === 0) {
    throw new FeedParseError('Every item in the feed was empty or unusable')
  }

  return {
    title,
    description,
    siteUrl,
    iconUrl: channelIcon(channel, siteUrl),
    items,
    format,
  }
}

/**
 * Deterministic per-feed identity for an item.
 * Order: GUID -> normalised URL -> hash(title|date|body).
 */
export function itemGuidKey(item: ParsedItem, feedId: string): string {
  if (item.guid) return `g:${item.guid}`
  const url = normalizeUrl(item.url)
  if (url) return `u:${url}`
  return `h:${hashString([feedId, item.title, item.publishedAt ?? '', item.summary].join('|'))}`
}

/** Cross-feed identity used to collapse the same article from two feeds. */
export function itemCanonicalKey(item: ParsedItem, feedId: string): string {
  const url = normalizeUrl(item.url)
  if (url) return `u:${url}`
  const guid = item.guid?.trim()
  if (guid && /^https?:\/\//i.test(guid)) {
    const normalized = normalizeUrl(guid)
    if (normalized) return `u:${normalized}`
  }
  return `t:${hashString([item.title, item.publishedAt ?? ''].join('|'))}:${feedId ? '' : ''}`
}
