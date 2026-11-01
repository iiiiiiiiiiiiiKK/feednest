/**
 * OPML 1.0/2.0 import and export.
 *
 * Import is deliberately a two-phase operation: `parseOpml` never touches the
 * database, so the UI can show a preview (including duplicate detection and
 * per-entry errors) before the user confirms.
 */
import { XMLParser } from 'fast-xml-parser'
import { normalizeUrl } from './url'
import type { Category, FeedSource } from './types'

export interface OpmlFeedEntry {
  title: string | null
  xmlUrl: string
  htmlUrl: string | null
  /** Nested outline titles above this feed, used as the category. */
  categoryPath: string[]
  /** Set during preview when the URL is already subscribed / duplicated. */
  duplicateOf: string | null
  error: string | null
}

export interface OpmlParseResult {
  title: string | null
  entries: OpmlFeedEntry[]
  warnings: string[]
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name.toLowerCase() === 'outline',
})

interface OutlineNode {
  '@_text'?: string
  '@_title'?: string
  '@_type'?: string
  '@_xmlUrl'?: string
  '@_xmlurl'?: string
  '@_htmlUrl'?: string
  '@_htmlurl'?: string
  outline?: OutlineNode[]
  [key: string]: unknown
}

function attrAny(node: OutlineNode, ...names: string[]): string | null {
  for (const name of names) {
    const value = node[`@_${name}`]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  // Case-insensitive fallback: OPML files are hand-written in the wild.
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_')) continue
    const bare = key.slice(2).toLowerCase()
    if (names.some((name) => name.toLowerCase() === bare) && typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

/** Parse an OPML document without touching the database. */
export function parseOpml(xml: string): OpmlParseResult {
  const warnings: string[] = []
  const trimmed = xml.replace(/^\uFEFF/, '').trim()
  if (!trimmed) throw new Error('The file is empty')

  let parsed: Record<string, unknown>
  try {
    parsed = parser.parse(trimmed) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Could not parse OPML: ${(error as Error).message}`)
  }

  const opml = (parsed.opml ?? parsed.OPML) as Record<string, unknown> | undefined
  if (!opml) throw new Error('Not an OPML file: missing <opml> root element')

  const head = opml.head as Record<string, unknown> | undefined
  const title = head ? String((head.title as string) ?? '').trim() || null : null

  if (!('body' in opml)) throw new Error('OPML file has no <body> element')
  // An empty <body/> parses to an empty string; treat it as "no outlines".
  const rawBody = opml.body
  const body =
    rawBody && typeof rawBody === 'object'
      ? (rawBody as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  const entries: OpmlFeedEntry[] = []
  const seen = new Map<string, number>()

  const walk = (nodes: OutlineNode[] | undefined, path: string[]): void => {
    if (!nodes) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const xmlUrl = attrAny(node, 'xmlUrl', 'xmlurl', 'xmlURL')
      const label = attrAny(node, 'text', 'title')
      const htmlUrl = attrAny(node, 'htmlUrl', 'htmlurl')

      if (xmlUrl) {
        const normalized = normalizeUrl(xmlUrl)
        if (!normalized) {
          entries.push({
            title: label,
            xmlUrl,
            htmlUrl,
            categoryPath: path,
            duplicateOf: null,
            error: 'Invalid or unsupported URL',
          })
        } else if (seen.has(normalized)) {
          entries.push({
            title: label,
            xmlUrl: normalized,
            htmlUrl,
            categoryPath: path,
            duplicateOf: `duplicate in file (entry ${(seen.get(normalized) ?? 0) + 1})`,
            error: null,
          })
        } else {
          seen.set(normalized, entries.length)
          entries.push({
            title: label,
            xmlUrl: normalized,
            htmlUrl: normalizeUrl(htmlUrl),
            categoryPath: path,
            duplicateOf: null,
            error: null,
          })
        }
      }

      if (node.outline) {
        walk(node.outline, label ? [...path, label] : path)
      }
    }
  }

  walk(body.outline as OutlineNode[] | undefined, [])

  if (entries.length === 0) {
    warnings.push('No feeds with an xmlUrl attribute were found in this file')
  }

  return { title, entries, warnings }
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/**
 * Build an OPML 2.0 document. Feeds are grouped under their category so the
 * export round-trips cleanly through other readers.
 */
export function buildOpml(
  feeds: FeedSource[],
  categories: Category[],
  options: { title?: string; createdAt?: Date } = {},
): string {
  const createdAt = options.createdAt ?? new Date()
  const byCategory = new Map<string, FeedSource[]>()
  const uncategorised: FeedSource[] = []

  for (const feed of feeds) {
    if (feed.categoryId) {
      const list = byCategory.get(feed.categoryId) ?? []
      list.push(feed)
      byCategory.set(feed.categoryId, list)
    } else {
      uncategorised.push(feed)
    }
  }

  const feedOutline = (feed: FeedSource): string => {
    const name = escapeXml(feed.customTitle || feed.title || feed.url)
    const attrs = [
      `text="${name}"`,
      `title="${name}"`,
      `type="rss"`,
      `xmlUrl="${escapeXml(feed.url)}"`,
    ]
    if (feed.siteUrl) attrs.push(`htmlUrl="${escapeXml(feed.siteUrl)}"`)
    return `      <outline ${attrs.join(' ')} />`
  }

  const lines: string[] = []
  for (const category of categories) {
    const list = byCategory.get(category.id)
    if (!list || list.length === 0) continue
    const name = escapeXml(category.name)
    lines.push(`    <outline text="${name}" title="${name}">`)
    for (const feed of list) lines.push(feedOutline(feed))
    lines.push('    </outline>')
  }
  for (const feed of uncategorised) lines.push(feedOutline(feed))

  const title = escapeXml(options.title ?? 'FeedNest subscriptions')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${title}</title>`,
    `    <dateCreated>${createdAt.toUTCString()}</dateCreated>`,
    '    <ownerName>FeedNest</ownerName>',
    '    <docs>https://opml.org/spec2.opml</docs>',
    '  </head>',
    '  <body>',
    ...lines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n')
}
