#!/usr/bin/env node
/**
 * Production smoke test against the deployed GitHub Pages site.
 *
 * This is a one-off verification of the real deployment, not part of the unit
 * or e2e suites: it talks to a live third-party feed on purpose, because the
 * point is to prove the shipped build can actually read a CORS-enabled feed
 * from its production origin.
 *
 * Usage: node scripts/verify-production.mjs [url]
 */
import { chromium } from '@playwright/test'

const URL = process.argv[2] ?? 'https://iiiiiiiiiiiiiKK.github.io/feednest/'
const FEED = 'https://github.blog/feed/'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()

try {
  /* ---------------------------------------------------------- desktop run */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const page = await desktop.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  const response = await page.goto(URL, { waitUntil: 'networkidle' })
  record('production page responds 200', response?.status() === 200, `status ${response?.status()}`)
  record(
    'app shell rendered',
    await page.getByText('Add your first RSS or Atom feed').isVisible().catch(() => false),
  )

  await page.getByTestId('add-feed-sidebar').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('https://example.com/feed.xml').fill(FEED)
  await dialog.getByTestId('discover-feed').click()
  await dialog.getByTestId('confirm-add-feed').click()
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 })

  const rows = page.getByTestId('article-row')
  await rows.first().waitFor({ timeout: 30_000 })
  const count = await rows.count()
  record('real CORS feed fetched and parsed in production', count > 0, `${count} articles`)

  const first = rows.first()
  const firstId = await first.getAttribute('data-article-id')
  await first.getByRole('button', { name: 'Star' }).click()
  await page.waitForTimeout(300)
  record('starring works in production', (await first.getAttribute('data-starred')) === 'true')

  await first.click()
  await page.waitForTimeout(500)
  record('reader opens a real article', await page.locator('article h1').isVisible())

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const restored = page.locator(`[data-article-id="${firstId}"]`)
  record('read/star state survives a reload', (await restored.getAttribute('data-starred')) === 'true')

  record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  const xLink = page.getByRole('link', { name: 'Follow the author on X' })
  record('author X link present', (await xLink.getAttribute('href')) === 'https://x.com/0xkillcoin')

  await desktop.close()

  /* ----------------------------------------------------------- mobile run */
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    locale: 'en-US',
  })
  const phone = await mobile.newPage()
  await phone.goto(URL, { waitUntil: 'networkidle' })
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  record('mobile layout has no horizontal overflow', overflow <= 1, `${overflow}px`)
  record('mobile navigation is visible', await phone.getByTestId('add-feed-mobile').isVisible())

  // Add a feed on the phone so the reader can be exercised at phone width.
  await phone.getByTestId('add-feed-mobile').click()
  const mobileDialog = phone.getByRole('dialog')
  await mobileDialog.getByPlaceholder('https://example.com/feed.xml').fill(FEED)
  await mobileDialog.getByTestId('discover-feed').click()
  await mobileDialog.getByTestId('confirm-add-feed').click()
  await mobileDialog.waitFor({ state: 'hidden', timeout: 30_000 })

  const mobileRows = phone.getByTestId('article-row')
  await mobileRows.first().waitFor({ timeout: 30_000 })
  record('mobile can add a real feed', (await mobileRows.count()) > 0)

  await mobileRows.first().click()
  await phone.waitForTimeout(500)
  const header = await phone.locator('article h1').boundingBox()
  record(
    'mobile reader fills the viewport',
    Boolean(header) && header.x < 40 && header.width > 300,
    header ? `${Math.round(header.width)}px wide` : 'no header',
  )
  await phone.getByRole('button', { name: 'Back to list' }).click()
  record('mobile reader returns to the list', await mobileRows.first().isVisible())

  await mobile.close()
} finally {
  await browser.close()
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} production checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
