import {
  CalendarDays,
  ChevronRight,
  Circle,
  FolderPlus,
  Inbox,
  Plus,
  Settings,
  Settings2,
  Star,
  ChartNoAxesColumn,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { FeedAvatar } from './FeedAvatar'
import { IconButton } from './ui'

interface SidebarProps {
  open: boolean
  onClose: () => void
  onAddFeed: () => void
  onManageFeeds: () => void
  onManageCategories: () => void
}

export function Sidebar({ open, onClose, onAddFeed, onManageFeeds, onManageCategories }: SidebarProps) {
  const { t, route, navigate } = useApp()
  const library = useLibrary()

  const isActive = (view: string, id?: string) =>
    route.view === view && (id === undefined || ('id' in route && route.id === id))

  const go = (next: Parameters<typeof navigate>[0]) => {
    navigate(next)
    onClose()
  }

  const feedsInCategory = (categoryId: string) =>
    library.feeds.filter((feed) => feed.categoryId === categoryId)

  const navItem = (
    view: 'all' | 'unread' | 'starred' | 'today',
    label: string,
    icon: React.ReactNode,
    count?: number,
  ) => {
    const active = isActive(view)
    return (
      <button
        type="button"
        onClick={() => go({ view })}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors',
          active ? 'bg-active font-medium text-ink' : 'text-ink-soft hover:bg-hover',
        )}
      >
        <span className={clsx('shrink-0', active ? 'text-accent' : 'text-ink-faint')}>{icon}</span>
        <span className="truncate">{label}</span>
        {count !== undefined && count > 0 ? (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-faint">{count}</span>
        ) : null}
      </button>
    )
  }

  const feedRow = (feedId: string) => {
    const feed = library.feedById.get(feedId)
    if (!feed) return null
    const active = isActive('feed', feed.id)
    const unread = library.unreadByFeed.get(feed.id) ?? 0
    return (
      <button
        key={feed.id}
        type="button"
        onClick={() => go({ view: 'feed', id: feed.id })}
        title={feed.customTitle || feed.title}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'flex h-[30px] w-full items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-[13px] transition-colors',
          active ? 'bg-active font-medium text-ink' : 'text-ink-soft hover:bg-hover',
          feed.paused && 'opacity-55',
        )}
      >
        <FeedAvatar title={feed.customTitle || feed.title} iconUrl={feed.iconUrl} size={15} />
        <span className="truncate">{feed.customTitle || feed.title}</span>
        {unread > 0 ? (
          <span
            className={clsx(
              'ml-auto shrink-0 rounded-full px-1.5 text-[10px] font-medium tabular-nums',
              active ? 'bg-accent text-white dark:text-[#17130f]' : 'text-ink-faint',
            )}
          >
            {unread > 999 ? '999+' : unread}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-[rgb(20_19_16/0.4)] backdrop-blur-[1px] lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-[268px] shrink-0 flex-col border-r border-line bg-sidebar',
          'transition-transform duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:transition-none',
          open ? 'translate-x-0 shadow-float' : '-translate-x-full',
        )}
        aria-label={t('nav.feeds')}
      >
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <button
            type="button"
            onClick={() => onAddFeed()}
            data-testid="add-feed-sidebar"
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover dark:text-[#17130f] dark:font-semibold"
          >
            <Plus size={15} />
            {t('nav.addFeed')}
          </button>
          <IconButton label={t('nav.close')} onClick={onClose} className="ml-1 lg:hidden">
            <X size={18} />
          </IconButton>
        </div>

        <nav className="pane-scroll flex-1 px-2 pt-2" aria-label={t('nav.all')}>
          <div className="space-y-0.5">
            {navItem('all', t('nav.all'), <Inbox size={15} />)}
            {navItem('unread', t('nav.unread'), <Circle size={15} />, library.unreadTotal)}
            {navItem('starred', t('nav.starred'), <Star size={15} />, library.starredTotal)}
            {navItem('today', t('nav.today'), <CalendarDays size={15} />, library.todayCount)}
          </div>

          <section className="mt-6">
            <div className="mb-1 flex items-center justify-between px-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {t('nav.categories')}
              </h2>
              <IconButton
                label={t('category.new')}
                size="sm"
                onClick={onManageCategories}
                data-testid="manage-categories"
                className="h-6 w-6"
              >
                <FolderPlus size={14} />
              </IconButton>
            </div>
            <div className="space-y-0.5">
              {library.categories.map((category) => {
                const feeds = feedsInCategory(category.id)
                const unread = feeds.reduce(
                  (sum, feed) => sum + (library.unreadByFeed.get(feed.id) ?? 0),
                  0,
                )
                const active = isActive('category', category.id)
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => go({ view: 'category', id: category.id })}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors',
                      active ? 'bg-active font-medium text-ink' : 'text-ink-soft hover:bg-hover',
                    )}
                  >
                    <HierarchyDot active={active} />
                    <span className="truncate">{category.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-faint">
                      {feeds.length || ''}
                    </span>
                    {unread > 0 ? (
                      <span className="shrink-0 rounded-full bg-inset px-1.5 text-[10px] tabular-nums text-ink-muted">
                        {unread}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="mt-6 pb-4">
            <div className="mb-1 flex items-center justify-between px-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {t('nav.feeds')}
              </h2>
              <IconButton
                label={t('feed.manage.title')}
                size="sm"
                onClick={onManageFeeds}
                data-testid="manage-feeds"
                className="h-6 w-6"
              >
                <Settings2 size={14} />
              </IconButton>
            </div>
            <div className="space-y-0.5">
              {library.feeds.length === 0 ? (
                <p className="px-2 py-2 text-xs text-ink-faint">{t('feed.manage.noFeeds')}</p>
              ) : null}
              {library.feeds
                .filter((feed) => !feed.categoryId)
                .map((feed) => feedRow(feed.id))}
              {library.categories.map((category) => {
                const feeds = feedsInCategory(category.id)
                if (feeds.length === 0) return null
                return (
                  <div key={category.id} className="pt-1">
                    <p className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                      {category.name}
                    </p>
                    {feeds.map((feed) => feedRow(feed.id))}
                  </div>
                )
              })}
            </div>
          </section>
        </nav>

        <div className="space-y-0.5 border-t border-line px-2 py-2">
          <button
            type="button"
            onClick={() => go({ view: 'stats' })}
            className={clsx(
              'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors',
              isActive('stats') ? 'bg-active font-medium text-ink' : 'text-ink-soft hover:bg-hover',
            )}
          >
            <ChartNoAxesColumn size={15} className="text-ink-faint" />
            {t('nav.stats')}
            <ChevronRight size={12} className="ml-auto text-ink-faint" />
          </button>
          <button
            type="button"
            onClick={() => go({ view: 'settings' })}
            data-testid="nav-settings"
            className={clsx(
              'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors',
              isActive('settings') ? 'bg-active font-medium text-ink' : 'text-ink-soft hover:bg-hover',
            )}
          >
            <Settings size={15} className="text-ink-faint" />
            {t('nav.settings')}
            <ChevronRight size={12} className="ml-auto text-ink-faint" />
          </button>
        </div>
      </aside>
    </>
  )
}

function HierarchyDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'ml-1 mr-0.5 h-1.5 w-1.5 shrink-0 rounded-[2px]',
        active ? 'bg-accent' : 'bg-line-strong',
      )}
    />
  )
}
