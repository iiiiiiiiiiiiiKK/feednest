import { useMemo } from 'react'
import { useLibrary } from '@/state/useLibrary'
import { computeStats } from '@/state/selectors'
import { useApp } from '@/state/AppContext'
import { FeedAvatar } from './FeedAvatar'
import { EmptyState } from './ui'

export function StatsView() {
  const { t, locale } = useApp()
  const library = useLibrary()
  const stats = useMemo(
    () => computeStats(library.articles, library.feeds),
    [library.articles, library.feeds],
  )

  const maxDay = Math.max(1, ...stats.perDay.map((day) => day.count))
  const dayLabel = (ts: number) =>
    new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' }).format(
      new Date(ts),
    )

  const cards = [
    { label: t('stats.feeds'), value: stats.feeds },
    { label: t('stats.today'), value: stats.today },
    { label: t('stats.unread'), value: stats.unread },
    { label: t('stats.starred'), value: stats.starred },
    { label: t('stats.week'), value: stats.last7DaysRead },
    { label: t('stats.total'), value: stats.total },
  ]

  return (
    <div className="pane-scroll h-full flex-1 bg-bg">
      <div className="mx-auto w-full max-w-3xl px-5 pb-20 pt-6 sm:px-8">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('stats.title')}</h1>
          <p className="mt-1 text-[12.5px] text-ink-muted">{t('stats.empty')}</p>
        </header>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {cards.map((card) => (
            <div key={card.label} className="rounded-xl border border-line bg-elevated px-3.5 py-3">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint">{card.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">
                {card.value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}
              </p>
            </div>
          ))}
        </div>

        <section className="mt-6 rounded-xl border border-line bg-elevated px-4 py-4">
          <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
            {t('stats.recent')}
          </h2>
          <div className="flex h-32 items-end gap-2">
            {stats.perDay.map((day) => (
              <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <span className="text-[10px] tabular-nums text-ink-muted">{day.count || ''}</span>
                <div
                  className="w-full rounded-t-[3px] bg-accent/75"
                  style={{ height: `${Math.max(2, (day.count / maxDay) * 92)}px` }}
                  title={`${day.count}`}
                />
                <span className="text-[10px] text-ink-faint">{dayLabel(day.day)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
            {t('stats.perFeed')}
          </h2>
          {stats.perFeed.length === 0 ? (
            <EmptyState title={t('stats.empty')} />
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-elevated">
              {stats.perFeed.slice(0, 20).map((row) => {
                const feed = library.feedById.get(row.feedId)
                const title = feed?.customTitle || feed?.title || row.feedId
                const max = stats.perFeed[0]?.total || 1
                return (
                  <li key={row.feedId} className="flex items-center gap-2.5 px-3 py-2.5">
                    <FeedAvatar title={title} iconUrl={feed?.iconUrl ?? null} size={16} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-soft">{title}</span>
                    <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-inset sm:block">
                      <span
                        className="block h-full rounded-full bg-accent/60"
                        style={{ width: `${Math.max(3, (row.total / max) * 100)}%` }}
                      />
                    </span>
                    <span className="w-16 text-right text-[11.5px] tabular-nums text-ink-muted">
                      {row.total}
                      <span className="text-ink-faint"> / {row.unread}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
