import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownWideNarrow,
  CheckCheck,
  CircleDashed,
  Inbox,
  Search,
  Star,
  X,
  Loader2,
} from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { selectArticles, type ArticleRow } from '@/state/selectors'
import { SearchIndex, type SearchHit } from '@/lib/search'
import { markAllRead, setStarred } from '@/lib/db'
import { formatRelative, startOfToday } from '@/lib/date'
import { FeedAvatar } from './FeedAvatar'
import { EmptyState, IconButton, Spinner } from './ui'

const PAGE_SIZE = 60

export function ArticleList({ onOpenArticle }: { onOpenArticle: (id: string) => void }) {
  const { t, route, search, setSearch, openArticleId, settings, locale, pushToast } = useApp()
  const library = useLibrary()
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [onlyStarred, setOnlyStarred] = useState(false)
  /** null = follow the setting; a value only applies until the setting changes. */
  const [sortOverride, setSortOverride] = useState<'newest' | 'oldest' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [page, setPage] = useState({ key: '', limit: PAGE_SIZE })
  const searchRef = useRef<HTMLInputElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const sortOrder = sortOverride ?? settings.sortOrder
  const scopeId = route.view === 'feed' || route.view === 'category' ? route.id : ''
  const listKey = [route.view, scopeId, search, onlyUnread, onlyStarred, sortOrder].join('|')
  const limit = page.key === listKey ? page.limit : PAGE_SIZE

  const searchIndex = useMemo(() => {
    return new SearchIndex(
      library.articles.map((article) => ({
        id: article.id,
        title: article.title,
        summary: article.summary,
        author: article.author,
        feedTitle: library.feedTitle(article.feedId),
        feedId: article.feedId,
      })),
    )
  }, [library.articles, library.feedTitle])

  const hits: SearchHit[] | null = useMemo(() => {
    const query = search.trim()
    if (!query) return null
    return searchIndex.search(query, 400)
  }, [search, searchIndex])

  const rows = useMemo<ArticleRow[]>(() => {
    if (route.view === 'settings' || route.view === 'stats') return []
    return selectArticles(library.articles, library.feeds, {
      view: route.view === 'feed' || route.view === 'category' ? route.view : route.view,
      scopeId: route.view === 'feed' || route.view === 'category' ? route.id : null,
      onlyUnread,
      onlyStarred,
      search,
      searchHits: hits,
      sortOrder,
      collapseDuplicates: settings.collapseDuplicates,
    })
  }, [library.articles, library.feeds, route, onlyUnread, onlyStarred, search, hits, sortOrder, settings.collapseDuplicates])

  const visible = rows.slice(0, limit)

  /* Keyboard shortcut "/" focuses the search box. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Close the bulk menu on outside click. */
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  /* Incremental rendering keeps the DOM small without a virtualiser. */
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setPage((current) => ({
          key: listKey,
          limit: Math.min(
            rows.length,
            (current.key === listKey ? current.limit : PAGE_SIZE) + PAGE_SIZE,
          ),
        }))
      },
      { rootMargin: '400px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [rows.length, listKey])

  const toggleStar = useCallback(
    async (id: string, starred: boolean) => {
      await setStarred([id], !starred)
    },
    [],
  )

  const title = useMemo(() => {
    switch (route.view) {
      case 'unread':
        return t('nav.unread')
      case 'starred':
        return t('nav.starred')
      case 'today':
        return t('nav.today')
      case 'feed':
        return library.feedById.get(route.id)?.customTitle || library.feedById.get(route.id)?.title || t('list.allFeeds')
      case 'category':
        return library.categoryById.get(route.id)?.name || t('list.allFeeds')
      default:
        return t('nav.all')
    }
  }, [route, library, t])

  const handleMarkAllRead = async (before: number) => {
    const scopeFeed = route.view === 'feed' ? route.id : undefined
    const count = await markAllRead({ feedId: scopeFeed, before })
    setMenuOpen(false)
    if (count > 0) pushToast({ tone: 'success', message: t('list.markedRead', { count }) })
  }

  const activeFilters = onlyUnread || onlyStarred

  return (
    <section
      className="flex h-full w-full shrink-0 flex-col border-r border-line bg-bg md:w-[370px] lg:w-[400px]"
      aria-label={title}
    >
      <div className="sticky top-0 z-10 border-b border-line bg-bg/92 px-3 pb-2.5 pt-3 backdrop-blur-md">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
            <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
              {rows.length > 0 ? rows.length : ''}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5" ref={menuRef}>
            <IconButton
              label={t('list.sortNewest')}
              size="sm"
              active={sortOrder === 'oldest'}
              onClick={() => {
                const next = sortOrder === 'newest' ? 'oldest' : 'newest'
                setSortOverride(next)
              }}
            >
              <ArrowDownWideNarrow
                size={15}
                className={clsx(sortOrder === 'oldest' && 'rotate-180 transition-transform')}
              />
            </IconButton>
            <IconButton
              label={t('list.onlyUnread')}
              size="sm"
              active={onlyUnread}
              onClick={() => setOnlyUnread((value) => !value)}
            >
              <CircleDashed size={15} />
            </IconButton>
            <IconButton
              label={t('list.onlyStarred')}
              size="sm"
              active={onlyStarred}
              onClick={() => setOnlyStarred((value) => !value)}
            >
              <Star size={15} />
            </IconButton>
            <div className="relative">
              <IconButton
                label={t('list.markAllRead')}
                size="sm"
                onClick={() => setMenuOpen((value) => !value)}
              >
                <CheckCheck size={15} />
              </IconButton>
              {menuOpen ? (
                <div className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-lg border border-line bg-elevated py-1 shadow-lifted animate-in">
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-[13px] text-ink-soft hover:bg-hover"
                    onClick={() => void handleMarkAllRead(Date.now())}
                  >
                    {t('list.markAllRead')}
                  </button>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-[13px] text-ink-soft hover:bg-hover"
                    onClick={() => void handleMarkAllRead(startOfToday() - 1)}
                  >
                    {locale === 'zh' ? '标记今天之前为已读' : 'Mark everything before today read'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="relative mt-2">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearch('')
                event.currentTarget.blur()
              }
            }}
            placeholder={t('app.searchPlaceholder')}
            aria-label={t('app.searchPlaceholder')}
            className="h-8 w-full rounded-md border border-transparent bg-inset pl-8 pr-7 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:bg-elevated focus:outline-none"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('common.dismiss')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint hover:text-ink"
            >
              <X size={13} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-bg px-1 text-[10px] text-ink-faint sm:block">
              /
            </kbd>
          )}
        </div>

        {activeFilters ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            {onlyUnread ? (
              <FilterChip label={t('list.onlyUnread')} onRemove={() => setOnlyUnread(false)} />
            ) : null}
            {onlyStarred ? (
              <FilterChip label={t('list.onlyStarred')} onRemove={() => setOnlyStarred(false)} />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="pane-scroll min-h-0 flex-1" role="list">
        {library.loading ? (
          <div className="flex items-center justify-center py-16 text-ink-faint">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={search ? <Search size={26} /> : <Inbox size={26} />}
            title={search ? t('list.empty.filtered') : t('list.empty.title')}
            body={search ? undefined : t('list.empty.body')}
          />
        ) : (
          <>
            {visible.map((row) => (
              <ArticleListItem
                key={row.article.id}
                row={row}
                selected={openArticleId === row.article.id}
                feedTitle={library.feedTitle(row.article.feedId)}
                feedIcon={library.feedById.get(row.article.feedId)?.iconUrl ?? null}
                locale={locale}
                onOpen={() => onOpenArticle(row.article.id)}
                onToggleStar={() => void toggleStar(row.article.id, row.article.starred)}
              />
            ))}
            {limit < rows.length ? (
              <div ref={sentinelRef} className="flex items-center justify-center py-6 text-ink-faint">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : (
              <div className="py-6 text-center text-[11px] text-ink-faint">
                {locale === 'zh' ? '已经到底了' : 'You have reached the end'}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft px-2 text-[11px] font-medium text-accent-ink">
      {label}
      <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-accent/15">
        <X size={10} />
      </button>
    </span>
  )
}

function ArticleListItem({
  row,
  selected,
  feedTitle,
  feedIcon,
  locale,
  onOpen,
  onToggleStar,
}: {
  row: ArticleRow
  selected: boolean
  feedTitle: string
  feedIcon: string | null
  locale: 'en' | 'zh'
  onOpen: () => void
  onToggleStar: () => void
}) {
  const { article } = row
  const isRead = article.read
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-article-id={article.id}
      data-testid="article-row"
      data-read={article.read ? 'true' : 'false'}
      data-starred={article.starred ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className={clsx(
        'group relative flex cursor-pointer gap-3 border-b border-line/70 px-3.5 py-3 transition-colors',
        selected ? 'bg-active' : 'hover:bg-hover/70',
        isRead && 'opacity-70',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
          isRead ? 'bg-transparent' : 'bg-accent',
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <FeedAvatar title={feedTitle} iconUrl={feedIcon} size={13} />
          <span className="truncate">{feedTitle}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(article.publishedAt).toISOString()} className="shrink-0">
            {formatRelative(article.publishedAt, locale)}
          </time>
          {article.contentKind === 'summary' ? (
            <span className="ml-1 shrink-0 rounded bg-inset px-1 py-px text-[9px] uppercase tracking-wide text-ink-faint">
              RSS
            </span>
          ) : null}
        </div>

        <h2
          className={clsx(
            'mt-1 line-clamp-2 text-[13.5px] leading-snug tracking-[-0.005em]',
            isRead ? 'font-normal text-ink-soft' : 'font-semibold text-ink',
          )}
        >
          {article.title}
        </h2>

        {article.summary ? (
          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-muted">
            {article.summary}
          </p>
        ) : null}
      </div>

      {article.imageUrl ? (
        <img
          src={article.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="mt-0.5 hidden h-14 w-14 shrink-0 rounded-md border border-line object-cover sm:block"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      ) : null}

      <button
        type="button"
        aria-label={article.starred ? 'Unstar' : 'Star'}
        aria-pressed={article.starred}
        onClick={(event) => {
          event.stopPropagation()
          onToggleStar()
        }}
        className={clsx(
          'absolute right-1.5 top-1.5 rounded-md p-1.5 transition-opacity',
          article.starred
            ? 'text-star opacity-100'
            : 'text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Star size={13} fill={article.starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}
