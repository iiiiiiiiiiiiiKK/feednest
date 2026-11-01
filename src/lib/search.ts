/**
 * Client-side search over the loaded article set.
 *
 * Kept deliberately small and dependency-free: a tokenised field index is
 * plenty for tens of thousands of articles, and it runs synchronously inside
 * `useMemo`, so results feel instant with no worker round-trip.
 */
export interface SearchDoc {
  id: string
  title: string
  summary: string
  author: string | null
  feedTitle: string
  feedId: string
}

export interface SearchHit {
  id: string
  score: number
  matchedFields: ('title' | 'summary' | 'author' | 'feed')[]
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'is', 'it'])

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .split(/[^\p{L}\p{N}_'-]+/u)
    .filter((token) => token.length >= 2 || /\d/.test(token))
}

interface IndexedDoc {
  doc: SearchDoc
  titleTokens: Set<string>
  bodyTokens: Set<string>
  authorTokens: Set<string>
  feedTokens: Set<string>
}

export class SearchIndex {
  private docs: IndexedDoc[] = []
  private tokenMap = new Map<string, Set<number>>()

  constructor(docs: SearchDoc[]) {
    this.build(docs)
  }

  get size(): number {
    return this.docs.length
  }

  private build(docs: SearchDoc[]): void {
    this.docs = []
    this.tokenMap = new Map()
    docs.forEach((doc, index) => {
      const titleTokens = new Set(tokenize(doc.title))
      const bodyTokens = new Set(tokenize(doc.summary))
      const authorTokens = new Set(tokenize(doc.author ?? ''))
      const feedTokens = new Set(tokenize(doc.feedTitle))
      this.docs.push({ doc, titleTokens, bodyTokens, authorTokens, feedTokens })
      const all = new Set([...titleTokens, ...bodyTokens, ...authorTokens, ...feedTokens])
      for (const token of all) {
        let bucket = this.tokenMap.get(token)
        if (!bucket) {
          bucket = new Set()
          this.tokenMap.set(token, bucket)
        }
        bucket.add(index)
      }
    })
  }

  search(query: string, limit = 200): SearchHit[] {
    const terms = tokenize(query).filter((token) => !STOPWORDS.has(token))
    if (terms.length === 0) return []

    const candidateIds = new Set<number>()
    for (const term of terms) {
      const exact = this.tokenMap.get(term)
      if (exact) {
        for (const id of exact) candidateIds.add(id)
      }
      // Prefix match keeps partially-typed queries useful.
      if (term.length >= 2) {
        for (const [token, ids] of this.tokenMap) {
          if (token !== term && token.startsWith(term)) {
            for (const id of ids) candidateIds.add(id)
          }
        }
      }
    }

    const hits: SearchHit[] = []
    for (const index of candidateIds) {
      const entry = this.docs[index]
      if (!entry) continue
      let score = 0
      const matchedFields: SearchHit['matchedFields'] = []

      for (const term of terms) {
        const inTitle = matchTokens(entry.titleTokens, term)
        const inBody = matchTokens(entry.bodyTokens, term)
        const inAuthor = matchTokens(entry.authorTokens, term)
        const inFeed = matchTokens(entry.feedTokens, term)
        if (inTitle) {
          score += 6
          if (!matchedFields.includes('title')) matchedFields.push('title')
        }
        if (inBody) {
          score += 2
          if (!matchedFields.includes('summary')) matchedFields.push('summary')
        }
        if (inAuthor) {
          score += 3
          if (!matchedFields.includes('author')) matchedFields.push('author')
        }
        if (inFeed) {
          score += 3
          if (!matchedFields.includes('feed')) matchedFields.push('feed')
        }
      }

      // Every term must appear somewhere, otherwise the hit is noise.
      if (matchedFields.length === 0) continue
      const covered = terms.every(
        (term) =>
          matchTokens(entry.titleTokens, term) ||
          matchTokens(entry.bodyTokens, term) ||
          matchTokens(entry.authorTokens, term) ||
          matchTokens(entry.feedTokens, term),
      )
      if (!covered) continue

      hits.push({ id: entry.doc.id, score, matchedFields })
    }

    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    return hits.slice(0, limit)
  }
}

function matchTokens(tokens: Set<string>, term: string): boolean {
  if (tokens.has(term)) return true
  if (term.length < 2) return false
  for (const token of tokens) {
    if (token.startsWith(term)) return true
  }
  return false
}
