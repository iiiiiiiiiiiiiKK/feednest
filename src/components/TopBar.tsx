import { Menu, Moon, Plus, RefreshCw, Sun, Languages, WifiOff } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '@/state/AppContext'
import { IconButton, Spinner } from './ui'
import { useState, useEffect } from 'react'

/** The author's X profile, shown in the header on every screen. */
export const AUTHOR_X_URL = 'https://x.com/0xkillcoin'

export function TopBar({ onOpenSidebar, onAddFeed }: { onOpenSidebar: () => void; onAddFeed: () => void }) {
  const { t, settings, updateSettings, refresh, navigate, pushToast, locale } = useApp()
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  const onRefresh = async () => {
    const summary = await refresh.run({ force: true })
    if (!summary) return
    if (summary.failed > 0) {
      pushToast({
        tone: 'error',
        message: `${summary.inserted} new · ${summary.failed} failed`,
      })
    } else if (summary.inserted > 0) {
      pushToast({ tone: 'success', message: `${summary.inserted} new articles` })
    }
  }

  return (
    <header className="safe-top z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur-md sm:px-4">
      <IconButton label={t('nav.menu')} onClick={onOpenSidebar} className="lg:hidden">
        <Menu size={18} />
      </IconButton>

      <button
        type="button"
        onClick={() => navigate({ view: 'all' })}
        className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-hover"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] bg-accent text-white dark:text-[#17130f]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
            <path
              d="M5 5.5h9.2a5 5 0 0 1 0 10H9.4a4.5 4.5 0 0 0 0 9H19"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="truncate text-[15px] font-semibold tracking-tight text-ink">
          {t('app.name')}
        </span>
        <span className="hidden truncate text-xs text-ink-faint xl:inline">{t('app.tagline')}</span>
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        {!online ? (
          <span className="mr-1 hidden items-center gap-1 text-[11px] text-ink-faint sm:flex">
            <WifiOff size={13} /> {t('common.offline')}
          </span>
        ) : null}

        <IconButton
          label={refresh.running ? t('nav.refreshing') : t('nav.refresh')}
          onClick={() => void onRefresh()}
          disabled={refresh.running}
        >
          {refresh.running ? <Spinner className="h-[15px] w-[15px]" /> : <RefreshCw size={17} />}
        </IconButton>

        <button
          type="button"
          onClick={onAddFeed}
          data-testid="add-feed-top"
          className="hidden h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-ink-muted transition-colors hover:bg-hover hover:text-ink sm:inline-flex"
          aria-label={t('nav.addFeed')}
          title={t('nav.addFeed')}
        >
          <Plus size={16} />
          <span className="hidden md:inline">{t('nav.addFeed')}</span>
        </button>

        <a
          href={AUTHOR_X_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('common.author')}
          title={t('common.author')}
          className={clsx(
            'inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted',
            'transition-colors hover:bg-hover hover:text-ink',
          )}
        >
          <span className="text-[15px] leading-none">𝕏</span>
        </a>

        <IconButton label={t('common.language')} onClick={() => void updateSettings({ locale: locale === 'zh' ? 'en' : 'zh' })}>
          <Languages size={17} />
        </IconButton>

        <IconButton label={t('common.theme')} onClick={() => void updateSettings({ theme: isDark ? 'light' : 'dark' })}>
          {isDark ? <Sun size={17} /> : <Moon size={17} />}
        </IconButton>
      </div>
    </header>
  )
}
