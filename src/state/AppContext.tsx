import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { db, saveSettings } from '@/lib/db'
import { translate } from '@/lib/i18n'
import { refreshFeeds, type RefreshSummary } from '@/lib/refresh'
import type { Locale, UserSettings } from '@/lib/types'

export type Route =
  | { view: 'all' }
  | { view: 'unread' }
  | { view: 'starred' }
  | { view: 'today' }
  | { view: 'feed'; id: string }
  | { view: 'category'; id: string }
  | { view: 'settings' }
  | { view: 'stats' }

export interface Toast {
  id: string
  message: string
  tone: 'info' | 'success' | 'error'
  actionLabel?: string
  action?: () => void
}

interface AppContextValue {
  t: (key: string, params?: Record<string, string | number>) => string
  locale: Locale
  settings: UserSettings
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>
  route: Route
  navigate: (route: Route) => void
  openArticleId: string | null
  setOpenArticleId: (id: string | null) => void
  search: string
  setSearch: (value: string) => void
  toasts: Toast[]
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  refresh: {
    running: boolean
    lastSummary: RefreshSummary | null
    run: (options?: { feedIds?: string[]; force?: boolean }) => Promise<RefreshSummary | null>
  }
  /** Bumped whenever article rows are written, so views can re-read bodies. */
  dataVersion: number
}

const AppContext = createContext<AppContextValue | null>(null)

export function routeToHash(route: Route, articleId: string | null): string {
  const base =
    route.view === 'feed' || route.view === 'category'
      ? `#/${route.view}/${encodeURIComponent(route.id)}`
      : `#/${route.view}`
  return articleId ? `${base}?article=${encodeURIComponent(articleId)}` : base
}

export function hashToRoute(hash: string): { route: Route; articleId: string | null } {
  const raw = hash.replace(/^#\/?/, '')
  const [pathPart, queryPart] = raw.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  const params = new URLSearchParams(queryPart ?? '')
  const articleId = params.get('article')

  const view = segments[0] ?? 'all'
  if (view === 'feed' && segments[1]) {
    return { route: { view: 'feed', id: decodeURIComponent(segments[1]) }, articleId }
  }
  if (view === 'category' && segments[1]) {
    return { route: { view: 'category', id: decodeURIComponent(segments[1]) }, articleId }
  }
  if (view === 'settings' || view === 'stats') return { route: { view }, articleId }
  if (view === 'unread' || view === 'starred' || view === 'today') {
    return { route: { view }, articleId }
  }
  return { route: { view: 'all' }, articleId }
}

interface ProviderProps {
  settings: UserSettings
  children: ReactNode
}

export function AppProvider({ settings, children }: ProviderProps) {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof window === 'undefined') return { view: 'all' }
    return hashToRoute(window.location.hash).route
  })
  const [openArticleId, setOpenArticleId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return hashToRoute(window.location.hash).articleId
  })
  const [search, setSearch] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [running, setRunning] = useState(false)
  const [lastSummary, setLastSummary] = useState<RefreshSummary | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const toastTimers = useRef(new Map<string, number>())

  const locale = settings.locale

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  )

  const navigate = useCallback((next: Route) => {
    setRoute(next)
    setOpenArticleId(null)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<UserSettings>) => {
    await saveSettings(patch)
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      setToasts((current) => [...current.slice(-3), { ...toast, id }])
      const timer = window.setTimeout(() => {
        setToasts((current) => current.filter((entry) => entry.id !== id))
        toastTimers.current.delete(id)
      }, toast.tone === 'error' ? 8000 : 4800)
      toastTimers.current.set(id, timer)
    },
    [],
  )

  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  /* Keep the URL in sync so a refresh restores the same view. */
  useEffect(() => {
    const hash = routeToHash(route, openArticleId)
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash)
    }
  }, [route, openArticleId])

  useEffect(() => {
    const onHashChange = () => {
      const parsed = hashToRoute(window.location.hash)
      setRoute(parsed.route)
      setOpenArticleId(parsed.articleId)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  /* Theme: `system` follows the OS and reacts to changes live. */
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
      try {
        localStorage.setItem('feednest.theme', settings.theme)
      } catch {
        /* storage disabled */
      }
    }
    apply()
    if (settings.theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings.theme])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    const title =
      locale === 'zh'
        ? 'FeedNest — 把值得阅读的内容，收进自己的信息空间'
        : 'FeedNest — Your corner of the internet'
    document.title = title
  }, [locale])

  const run = useCallback(
    async (options: { feedIds?: string[]; force?: boolean } = {}) => {
      if (running) return null
      setRunning(true)
      try {
        const summary = await refreshFeeds({
          proxyUrl: settings.proxyUrl,
          feedIds: options.feedIds,
          force: options.force,
        })
        setLastSummary(summary)
        setDataVersion((version) => version + 1)
        return summary
      } finally {
        setRunning(false)
      }
    },
    [running, settings.proxyUrl],
  )

  /* ---------------------------------------------------- automatic refresh */
  const refreshRef = useRef(run)
  useEffect(() => {
    refreshRef.current = run
  }, [run])

  useEffect(() => {
    const minutes = settings.refreshInterval
    if (!minutes) return

    let cancelled = false
    const tick = async () => {
      if (cancelled || document.visibilityState !== 'visible' || !navigator.onLine) return
      const feeds = await db.feeds.filter((feed) => !feed.paused).toArray()
      if (feeds.length === 0) return
      await refreshRef.current()
    }

    // Catch up on the first tick only if data is already stale.
    const catchUp = async () => {
      const feeds = await db.feeds.toArray()
      if (feeds.length === 0) return
      const newest = feeds.reduce((max, feed) => Math.max(max, feed.lastFetchedAt ?? 0), 0)
      if (Date.now() - newest > minutes * 60 * 1000) await tick()
    }
    void catchUp()

    const timer = window.setInterval(() => void tick(), minutes * 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [settings.refreshInterval])

  const value = useMemo<AppContextValue>(
    () => ({
      t,
      locale,
      settings,
      updateSettings,
      route,
      navigate,
      openArticleId,
      setOpenArticleId,
      search,
      setSearch,
      toasts,
      pushToast,
      dismissToast,
      refresh: { running, lastSummary, run },
      dataVersion,
    }),
    [
      t,
      locale,
      settings,
      updateSettings,
      route,
      navigate,
      openArticleId,
      search,
      toasts,
      pushToast,
      dismissToast,
      running,
      lastSummary,
      run,
      dataVersion,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside <AppProvider>')
  return context
}
