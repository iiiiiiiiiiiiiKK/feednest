import { expect, test, type Page } from '@playwright/test'

/**
 * End-to-end coverage for FeedNest.
 *
 * Every test runs against a local fixture server (scripts/fixture-server.mjs),
 * so nothing here depends on a third-party feed being online. Each test gets a
 * fresh browser context, which means a fresh IndexedDB — the real "new user"
 * experience.
 */

const FIXTURES = 'http://127.0.0.1:4179'

async function openAddFeed(page: Page) {
  const mobile = (page.viewportSize()?.width ?? 1400) < 768
  await page.getByTestId(mobile ? 'add-feed-mobile' : 'add-feed-sidebar').click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

async function addFeed(page: Page, url: string, expectTitle = 'Nest Test Journal') {
  await openAddFeed(page)
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('https://example.com/feed.xml').fill(url)
  await dialog.getByTestId('discover-feed').click()
  await expect(dialog.getByText(expectTitle)).toBeVisible({ timeout: 15_000 })
  await dialog.getByTestId('confirm-add-feed').click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect(page.getByTestId('article-row').first()).toBeVisible({ timeout: 15_000 })
}

test.describe('subscriptions', () => {
  test('adds an RSS feed and lists its articles', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Add your first RSS or Atom feed')).toBeVisible()

    await addFeed(page, `${FIXTURES}/rss.xml`)

    await expect(page.getByTestId('article-row')).toHaveCount(6)
    await expect(page.getByText('Why local-first software feels different')).toBeVisible()
    await expect(page.getByText('Summary-only item with no content:encoded')).toBeVisible()
  })

  test('refuses to add the same feed twice', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: uses the sidebar add button twice')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    await openAddFeed(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('https://example.com/feed.xml').fill(`${FIXTURES}/rss.xml`)
    await dialog.getByTestId('discover-feed').click()
    await expect(dialog.getByText('This feed is already in your nest.')).toBeVisible()
  })

  test('explains CORS failures instead of silently failing', async ({ page }) => {
    await page.goto('/')
    await openAddFeed(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('https://example.com/feed.xml').fill(`${FIXTURES}/no-cors.xml`)
    await dialog.getByTestId('discover-feed').click()
    await expect(dialog.getByText(/The browser blocked this request \(CORS\)/)).toBeVisible({
      timeout: 15_000,
    })
  })

  test('deletes a feed and its articles', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: feed management lives in the sidebar')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    await page.getByTestId('manage-feeds').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Nest Test Journal').first()).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete feed' }).click()
    await dialog.getByRole('button', { name: 'Confirm' }).click()
    await dialog.getByRole('button', { name: 'Done' }).click()

    await expect(page.getByTestId('article-row')).toHaveCount(0)
    await expect(page.getByText('Add your first RSS or Atom feed')).toBeVisible()
  })
})

test.describe('reading', () => {
  test('opens an article, marks it read and keeps the state after reload', async ({ page }) => {
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    const row = page
      .getByTestId('article-row')
      .filter({ hasText: 'Why local-first software feels different' })
    await expect(row).toHaveAttribute('data-read', 'false')
    await row.click()

    await expect(page.locator('article h1')).toContainText('Why local-first')
    await expect(page.getByText('Local-first is a promise about who owns the write.')).toBeVisible()

    await page.waitForTimeout(400)
    await page.reload()
    await expect(
      page.getByTestId('article-row').filter({ hasText: 'Why local-first software feels different' }),
    ).toHaveAttribute('data-read', 'true')
  })

  test('stars an article and filters the list', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: filter controls are in the list header')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    const row = page.getByTestId('article-row').first()
    await row.getByRole('button', { name: 'Star' }).click()
    await expect(row).toHaveAttribute('data-starred', 'true')

    await page.getByRole('button', { name: 'Starred only' }).click()
    await expect(page.getByTestId('article-row')).toHaveCount(1)
  })

  test('marks everything read', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: bulk actions are in the list header')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    await page.getByRole('button', { name: 'Mark all read' }).click()
    await page.getByRole('button', { name: 'Mark all read', exact: true }).last().click()
    await expect(page.getByTestId('article-row').first()).toHaveAttribute('data-read', 'true', {
      timeout: 10_000,
    })
  })
})

test.describe('search', () => {
  test('searches titles and summaries', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: search box sits in the list header')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    const search = page.getByPlaceholder('Search articles, authors, feeds')
    await search.fill('ownership')
    await expect(page.getByTestId('article-row')).toHaveCount(1)
    await expect(page.getByText('Why local-first software feels different')).toBeVisible()

    await search.fill('zzzz-no-match')
    await expect(page.getByText('No articles match the current filters.')).toBeVisible()
  })

  test('the slash shortcut focuses search', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: no physical keyboard on touch devices')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)
    await page.keyboard.press('/')
    await expect(page.getByPlaceholder('Search articles, authors, feeds')).toBeFocused()
  })
})

test.describe('categories', () => {
  test('creates a category and files a feed into it', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: category management is in the sidebar')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    await page.getByTestId('manage-categories').click()
    const categories = page.getByRole('dialog')
    await categories.getByPlaceholder('Category name').fill('Design')
    await categories.getByRole('button', { name: 'Create' }).click()
    await categories.getByRole('button', { name: 'Done' }).click()

    await page.getByTestId('manage-feeds').click()
    const feeds = page.getByRole('dialog')
    await feeds.getByLabel('Move to category').selectOption({ label: 'Design' })
    await feeds.getByRole('button', { name: 'Done' }).click()

    await page.getByRole('button', { name: /^Design/ }).click()
    await expect(page.getByTestId('article-row')).toHaveCount(6)
  })
})

test.describe('data portability', () => {
  test('imports OPML with a preview', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: import lives in Settings')
    await page.goto('/')
    await page.getByTestId('nav-settings').click()

    await page.getByRole('button', { name: 'Import OPML' }).click()
    const dialog = page.getByRole('dialog')

    const opml = `<?xml version="1.0"?>
<opml version="2.0"><head><title>fixture</title></head><body>
  <outline text="Tech">
    <outline type="rss" text="Fixture RSS" xmlUrl="${FIXTURES}/rss.xml" />
    <outline type="rss" text="Fixture Atom" xmlUrl="${FIXTURES}/atom.xml" />
  </outline>
  <outline type="rss" text="Broken" xmlUrl="http://127.0.0.1:4179/missing.xml" />
</body></opml>`

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'subs.opml',
      mimeType: 'text/x-opml',
      buffer: Buffer.from(opml, 'utf8'),
    })

    await expect(dialog.getByText('3 feeds found')).toBeVisible()
    await dialog.getByRole('button', { name: /Import 3 feeds/ }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    await expect(page.getByText('Nest Test Journal').first()).toBeVisible({ timeout: 20_000 })
  })

  test('exports a full backup as JSON', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: export buttons live in Settings')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)
    await page.getByTestId('nav-settings').click()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export full backup (JSON)' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^feednest-backup-.*\.json$/)
  })
})

test.describe('refresh', () => {
  test('refreshing does not duplicate articles', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only: refresh button is in the top bar')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)
    await expect(page.getByTestId('article-row')).toHaveCount(6)

    await page.getByRole('button', { name: 'Refresh all' }).click()
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('article-row')).toHaveCount(6)
  })
})

test.describe('mobile layout', () => {
  test('reader opens full screen and returns to the list', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only behaviour')
    await page.goto('/')
    await addFeed(page, `${FIXTURES}/rss.xml`)

    await page
      .getByTestId('article-row')
      .filter({ hasText: 'Why local-first software feels different' })
      .click()
    await expect(page.locator('article h1')).toContainText('Why local-first')

    const overlay = page.locator('div.fixed.inset-0')
    await expect(overlay).toBeVisible()
    const box = await overlay.boundingBox()
    const viewport = page.viewportSize()!
    expect(box?.width).toBeGreaterThanOrEqual(viewport.width - 2)

    await page.getByRole('button', { name: 'Back to list' }).click()
    await expect(page.getByTestId('article-row').first()).toBeVisible()
  })

  test('no horizontal overflow on primary screens', async ({ page }) => {
    await page.goto('/')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)

    await addFeed(page, `${FIXTURES}/rss.xml`)
    const overflowWithContent = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflowWithContent).toBeLessThanOrEqual(1)
  })
})

test.describe('settings and privacy', () => {
  test('switches language and theme, and persists both', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Switch language' }).click()
    await expect(page.locator('h1').first()).toContainText('全部文章')

    await page.getByRole('button', { name: '切换主题' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.locator('h1').first()).toContainText('全部文章')
  })

  test('the author X link points at the right profile', async ({ page }) => {
    await page.goto('/')
    const link = page.getByRole('link', { name: 'Follow the author on X' })
    await expect(link).toHaveAttribute('href', 'https://x.com/0xkillcoin')
    await expect(link).toHaveAttribute('target', '_blank')
  })
})
