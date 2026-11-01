import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, setRead, setStarred } from '@/lib/db'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { TopBar } from '@/components/TopBar'
import { Sidebar } from '@/components/Sidebar'
import { ArticleList } from '@/components/ArticleList'
import { Reader } from '@/components/Reader'
import { MobileNav } from '@/components/MobileNav'
import { ToastStack } from '@/components/ToastStack'
import { AddFeedDialog } from '@/components/AddFeedDialog'
import { FeedsDialog } from '@/components/FeedsDialog'
import { CategoriesDialog } from '@/components/CategoriesDialog'
import { OpmlDialog } from '@/components/OpmlDialog'
import { RestoreDialog } from '@/components/RestoreDialog'
import { SettingsView } from '@/components/SettingsView'
import { StatsView } from '@/components/StatsView'

type DialogKind = 'add' | 'feeds' | 'categories' | 'opml' | 'restore' | null

export function App() {
  const { t, route, openArticleId, setOpenArticleId, refresh, settings } = useApp()
  const library = useLibrary()
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [addCategoryId, setAddCategoryId] = useState<string | null>(null)

  const openAdd = useCallback((categoryId: string | null = null) => {
    setAddCategoryId(categoryId)
    setDialog('add')
  }, [])

  const closeDialog = useCallback(() => setDialog(null), [])

  /* ------------------------------------------------------- keyboard layer */
  const ordered = library.articles
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return
      }

      const sorted = [...ordered].sort((a, b) => b.publishedAt - a.publishedAt)
      const currentIndex = openArticleId ? sorted.findIndex((row) => row.id === openArticleId) : -1

      switch (event.key) {
        case 'j': {
          const next = sorted[currentIndex + 1]
          if (next) setOpenArticleId(next.id)
          event.preventDefault()
          break
        }
        case 'k': {
          if (currentIndex <= 0) break
          setOpenArticleId(sorted[currentIndex - 1].id)
          event.preventDefault()
          break
        }
        case 'm': {
          if (!openArticleId) break
          const row = sorted.find((article) => article.id === openArticleId)
          if (row) void setRead([row.id], !row.read)
          event.preventDefault()
          break
        }
        case 's': {
          if (!openArticleId) break
          const row = sorted.find((article) => article.id === openArticleId)
          if (row) void setStarred([row.id], !row.starred)
          event.preventDefault()
          break
        }
        case 'Escape': {
          if (openArticleId) {
            setOpenArticleId(null)
            event.preventDefault()
          }
          break
        }
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ordered, openArticleId, setOpenArticleId])

  /* Refresh on first load when feeds exist but nothing has ever been fetched. */
  const neverFetched = useLiveQuery(
    async () => {
      const feeds = await db.feeds.toArray()
      return feeds.length > 0 && feeds.every((feed) => !feed.lastFetchedAt)
    },
    [],
    false,
  )
  useEffect(() => {
    if (neverFetched) void refresh.run()
  }, [neverFetched, refresh])

  const showList = route.view !== 'settings' && route.view !== 'stats'
  const readerClassName = 'hidden md:flex'

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-elevated focus:px-3 focus:py-1.5 focus:text-sm focus:shadow-lifted"
      >
        {t('app.skipToContent')}
      </a>

      <TopBar onOpenSidebar={() => setSidebarOpen(true)} onAddFeed={() => openAdd()} />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onAddFeed={() => openAdd()}
          onManageFeeds={() => setDialog('feeds')}
          onManageCategories={() => setDialog('categories')}
        />

        <main id="main" className="flex min-h-0 min-w-0 flex-1">
          {route.view === 'settings' ? (
            <SettingsView
              onOpenOpml={() => setDialog('opml')}
              onOpenRestore={() => setDialog('restore')}
              onOpenCategories={() => setDialog('categories')}
              onOpenFeeds={() => setDialog('feeds')}
            />
          ) : route.view === 'stats' ? (
            <StatsView />
          ) : (
            <>
              <ArticleList onOpenArticle={setOpenArticleId} />
              {!isMobile ? (
                <Reader
                  articleId={openArticleId}
                  onClose={() => setOpenArticleId(null)}
                  className={readerClassName}
                />
              ) : null}
            </>
          )}
        </main>
      </div>

      {showList ? <MobileNav onAddFeed={() => openAdd()} /> : null}

      {/* Mobile reader: a full-screen overlay above the tab bar. Rendered only
          on phones so there is never a duplicate copy of the same article. */}
      {openArticleId && isMobile ? (
        <div className="fixed inset-0 z-40 flex flex-col bg-bg">
          <Reader articleId={openArticleId} onClose={() => setOpenArticleId(null)} />
        </div>
      ) : null}

      {dialog === 'add' ? (
        <AddFeedDialog
          open
          onClose={closeDialog}
          initialCategoryId={addCategoryId}
          key={addCategoryId ?? 'none'}
        />
      ) : null}
      <FeedsDialog open={dialog === 'feeds'} onClose={closeDialog} />
      <CategoriesDialog open={dialog === 'categories'} onClose={closeDialog} />
      <OpmlDialog open={dialog === 'opml'} onClose={closeDialog} />
      <RestoreDialog open={dialog === 'restore'} onClose={closeDialog} />
      <ToastStack />

      {settings.refreshInterval > 0 ? (
        <span className="sr-only" role="status">
          {t('settings.refreshNote')}
        </span>
      ) : null}
    </div>
  )
}
