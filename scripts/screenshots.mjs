#!/usr/bin/env node
/**
 * Capture the screenshots used in the README from the real application.
 *
 * Usage: node scripts/screenshots.mjs
 * Requires a production build in ./dist (npm run build).
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'docs', 'screenshots')
const PORT = 4183
const FIXTURES = 'http://127.0.0.1:4179'

const children = []

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
  })
  children.push(child)
  return child
}

async function waitFor(url, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function addFeed(page, url) {
  await page.getByTestId('add-feed-sidebar').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('https://example.com/feed.xml').fill(url)
  await dialog.getByTestId('discover-feed').click()
  await dialog.getByTestId('confirm-add-feed').click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByTestId('article-row').first().waitFor()
}

async function main() {
  await mkdir(outDir, { recursive: true })

  start(process.execPath, [join(root, 'scripts', 'fixture-server.mjs')], { FIXTURE_PORT: '4179' })
  start(process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(PORT),
    '--strictPort',
  ])

  await waitFor(`http://127.0.0.1:${PORT}/`)
  await waitFor(`${FIXTURES}/rss.xml`)

  const browser = await chromium.launch()

  /* ------------------------------------------------------------ desktop */
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en-US',
    colorScheme: 'light',
  })
  const page = await desktop.newPage()

  await page.goto(`http://127.0.0.1:${PORT}/`)
  await addFeed(page, `${FIXTURES}/rss.xml`)
  await addFeed(page, `${FIXTURES}/atom.xml`)

  // Back to the combined list so the screenshot shows a real library.
  await page.getByRole('button', { name: 'All articles' }).click()
  await page.waitForTimeout(300)

  // Make the list look like a real library: a couple of stars.
  const rows = page.getByTestId('article-row')
  await rows.nth(0).getByRole('button', { name: 'Star' }).click()
  await rows.nth(2).getByRole('button', { name: 'Star' }).click()
  await page.waitForTimeout(300)

  await page.screenshot({ path: join(outDir, 'desktop-light.png') })

  // Reader, light theme.
  await rows.nth(1).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(outDir, 'reader-light.png') })

  // Reader, dark theme.
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, 'reader-dark.png') })

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, 'desktop-dark.png') })

  // Settings screen (dark).
  await page.getByTestId('nav-settings').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(outDir, 'settings-dark.png') })

  await desktop.close()

  /* ------------------------------------------------------------- mobile */
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    colorScheme: 'light',
  })
  const phone = await mobile.newPage()
  await phone.goto(`http://127.0.0.1:${PORT}/`)
  await phone.waitForTimeout(800)
  await phone.screenshot({ path: join(outDir, 'mobile-empty.png') })

  await phone.getByTestId('add-feed-mobile').click()
  const dialog = phone.getByRole('dialog')
  await dialog.getByPlaceholder('https://example.com/feed.xml').fill(`${FIXTURES}/rss.xml`)
  await dialog.getByTestId('discover-feed').click()
  await dialog.getByTestId('confirm-add-feed').click()
  await dialog.waitFor({ state: 'hidden' })
  await phone.waitForTimeout(800)
  await phone.screenshot({ path: join(outDir, 'mobile-list.png') })

  await phone
    .getByTestId('article-row')
    .filter({ hasText: 'Why local-first software feels different' })
    .click()
  await phone.waitForTimeout(700)
  await phone.screenshot({ path: join(outDir, 'mobile-reader.png') })

  await mobile.close()
  await browser.close()

  console.log('screenshots written to docs/screenshots')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    for (const child of children) child.kill()
  })
