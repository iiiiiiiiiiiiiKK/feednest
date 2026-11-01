import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { AppProvider } from './state/AppContext'
import { db, ensureDbReady } from './lib/db'
import { useLiveQuery } from 'dexie-react-hooks'
import { DEFAULT_SETTINGS } from './lib/types'

/** Boot screen shown while IndexedDB opens. */
function Boot({ children }: { children: React.ReactNode }) {
  const settings = useLiveQuery(() => db.settings.get('app'), [], undefined)
  if (!settings) {
    return (
      <div className="grid h-dvh place-items-center bg-bg">
        <div className="flex flex-col items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-white dark:text-[#17130f]">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
              <path
                d="M5 5.5h9.2a5 5 0 0 1 0 10H9.4a4.5 4.5 0 0 0 0 9H19"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <p className="text-[12px] text-ink-faint">Opening your nest…</p>
        </div>
      </div>
    )
  }
  return <AppProvider settings={settings ?? DEFAULT_SETTINGS}>{children}</AppProvider>
}

async function bootstrap() {
  const rootElement = document.getElementById('root')
  if (!rootElement) throw new Error('Missing #root element')

  await ensureDbReady()

  createRoot(rootElement).render(
    <StrictMode>
      <Boot>
        <App />
      </Boot>
    </StrictMode>,
  )
}

void bootstrap().catch((error: unknown) => {
  console.error('FeedNest failed to start', error)
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `
      <div style="max-width:32rem;margin:18vh auto;padding:0 1.5rem;font-family:ui-sans-serif,system-ui;line-height:1.6">
        <h1 style="font-size:1.1rem;margin:0 0 .5rem">FeedNest couldn't open its local database</h1>
        <p style="color:#726d63;font-size:.875rem;margin:0 0 1rem">
          Your browser blocked IndexedDB. Private windows and some hardened browser
          profiles disable it. Try a normal window, or allow site data for this page.
        </p>
        <pre style="font-size:.75rem;color:#9c968a;white-space:pre-wrap">${
          error instanceof Error ? error.message : String(error)
        }</pre>
      </div>`
  }
})
