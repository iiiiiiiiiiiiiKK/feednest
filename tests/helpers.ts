import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '@/lib/db'
import { DEFAULT_CATEGORIES } from '@/lib/db'
import { DEFAULT_SETTINGS } from '@/lib/types'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')

export function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8')
}

/** Wipe and re-open the singleton database between tests. */
export async function resetDatabase(): Promise<void> {
  db.close()
  await db.delete()
  await db.open()
  const now = Date.now()
  await db.settings.put({ ...DEFAULT_SETTINGS })
  await db.categories.bulkPut(
    DEFAULT_CATEGORIES.map((entry, index) => ({
      id: `cat_${entry.slug}`,
      name: entry.name,
      slug: entry.slug,
      order: index,
      builtIn: true,
      createdAt: now,
    })),
  )
}

export function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
    ...init,
  })
}
