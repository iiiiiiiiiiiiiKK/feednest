import { Circle, Inbox, Plus, Settings, Star } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'

/** Mobile-only bottom navigation: primary destinations within thumb reach. */
export function MobileNav({ onAddFeed }: { onAddFeed: () => void }) {
  const { t, route, navigate } = useApp()
  const library = useLibrary()

  const item = (
    view: 'all' | 'unread' | 'starred' | 'settings',
    label: string,
    icon: React.ReactNode,
    count?: number,
  ) => {
    const active = route.view === view
    return (
      <button
        key={view}
        type="button"
        data-testid={`nav-${view}-mobile`}
        onClick={() => navigate({ view: view === 'settings' ? 'settings' : view })}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px] transition-colors',
          active ? 'text-accent' : 'text-ink-muted',
        )}
      >
        <span className="relative">
          {icon}
          {count !== undefined && count > 0 ? (
            <span className="absolute -right-2.5 -top-1.5 rounded-full bg-accent px-1 text-[9px] font-semibold leading-[13px] text-white dark:text-[#17130f]">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </span>
        {label}
      </button>
    )
  }

  return (
    <nav
      className="safe-bottom z-30 flex shrink-0 items-stretch gap-1 border-t border-line bg-bg/95 px-2 pt-1 backdrop-blur-md md:hidden"
      aria-label={t('nav.menu')}
    >
      {item('all', t('nav.all'), <Inbox size={19} />)}
      {item('unread', t('nav.unread'), <Circle size={19} />, library.unreadTotal)}
      {item('starred', t('nav.starred'), <Star size={19} />)}
      <button
        type="button"
        onClick={onAddFeed}
        data-testid="add-feed-mobile"
        aria-label={t('nav.addFeed')}
        className="mx-1 flex h-9 w-9 items-center justify-center self-center rounded-full bg-accent text-white shadow-soft dark:text-[#17130f]"
      >
        <Plus size={18} />
      </button>
      {item('settings', t('nav.settings'), <Settings size={19} />)}
    </nav>
  )
}
