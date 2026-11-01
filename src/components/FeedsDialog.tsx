import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Pause, Play, RefreshCw, Trash2, Pencil, TriangleAlert, ExternalLink } from 'lucide-react'
import clsx from 'clsx'
import {
  assignFeedCategory,
  db,
  deleteFeed,
  updateFeed,
} from '@/lib/db'
import type { FeedSource } from '@/lib/types'
import { formatRelative } from '@/lib/date'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { FeedAvatar } from './FeedAvatar'
import { Badge, Button, Dialog, EmptyState, IconButton, Select, TextInput } from './ui'

export function FeedsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, refresh, pushToast } = useApp()
  const library = useLibrary()
  const counts = useLiveQuery(async () => {
    const rows = await db.articles.toArray()
    const map = new Map<string, { total: number; unread: number }>()
    for (const row of rows) {
      const entry = map.get(row.feedId) ?? { total: 0, unread: 0 }
      entry.total += 1
      if (!row.read) entry.unread += 1
      map.set(row.feedId, entry)
    }
    return map
  }, [], new Map<string, { total: number; unread: number }>())

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busyFeedId, setBusyFeedId] = useState<string | null>(null)

  const startRename = (feed: FeedSource) => {
    setRenamingId(feed.id)
    setDraftTitle(feed.customTitle ?? feed.title)
  }

  const saveRename = async (feed: FeedSource) => {
    const trimmed = draftTitle.trim()
    await updateFeed(feed.id, {
      customTitle: trimmed && trimmed !== feed.title ? trimmed : null,
    })
    setRenamingId(null)
    pushToast({ tone: 'success', message: t('common.save') })
  }

  const remove = async (feed: FeedSource) => {
    await deleteFeed(feed.id)
    setConfirmDeleteId(null)
    pushToast({ tone: 'success', message: locale === 'zh' ? '已删除订阅源' : 'Feed deleted' })
  }

  const refreshOne = async (feed: FeedSource) => {
    setBusyFeedId(feed.id)
    try {
      const summary = await refresh.run({ feedIds: [feed.id], force: true })
      const outcome = summary?.outcomes[0]
      if (outcome && !outcome.ok) {
        pushToast({ tone: 'error', message: outcome.error ?? t('error.unknown') })
      } else if (outcome) {
        pushToast({
          tone: 'success',
          message: `${outcome.inserted} new`,
        })
      }
    } finally {
      setBusyFeedId(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('feed.manage.title')}
      width="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      {library.feeds.length === 0 ? (
        <EmptyState title={t('feed.manage.noFeeds')} />
      ) : (
        <ul className="divide-y divide-line">
          {library.feeds.map((feed) => {
            const count = counts.get(feed.id) ?? { total: 0, unread: 0 }
            const title = feed.customTitle || feed.title
            return (
              <li key={feed.id} className="py-3">
                <div className="flex items-start gap-2.5">
                  <FeedAvatar title={title} iconUrl={feed.iconUrl} size={22} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    {renamingId === feed.id ? (
                      <div className="flex items-center gap-1.5">
                        <TextInput
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveRename(feed)
                            if (event.key === 'Escape') setRenamingId(null)
                          }}
                          className="h-8 text-[13px]"
                          autoFocus
                        />
                        <Button size="sm" variant="primary" onClick={() => void saveRename(feed)}>
                          {t('feed.manage.renameSave')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
                          {t('feed.manage.renameCancel')}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[13.5px] font-medium text-ink">{title}</p>
                        {feed.paused ? <Badge>{t('feed.manage.paused')}</Badge> : null}
                        {feed.lastError ? (
                          <Badge tone="danger">{t('feed.manage.error')}</Badge>
                        ) : null}
                      </div>
                    )}

                    <a
                      href={feed.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-ink-faint hover:text-ink"
                    >
                      <ExternalLink size={10} />
                      <span className="truncate">{feed.url}</span>
                    </a>

                    <p className="mt-1 text-[11px] text-ink-muted">
                      {t('feed.manage.articleCount', { count: count.total })}
                      <span className="mx-1.5 text-line-strong">·</span>
                      {t('feed.manage.unreadCount', { count: count.unread })}
                      <span className="mx-1.5 text-line-strong">·</span>
                      {feed.lastFetchedAt
                        ? t('feed.manage.lastUpdated', {
                            time: formatRelative(feed.lastFetchedAt, locale),
                          })
                        : t('feed.manage.neverUpdated')}
                    </p>

                    {feed.lastError ? (
                      <p className="mt-1 flex items-start gap-1 rounded border border-danger/25 bg-danger-soft px-2 py-1 text-[11px] leading-relaxed text-danger">
                        <TriangleAlert size={11} className="mt-0.5 shrink-0" />
                        <span>
                          {feed.lastError.kind.toUpperCase()}: {feed.lastError.message}
                        </span>
                      </p>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Select
                        value={feed.categoryId ?? ''}
                        onChange={(event) =>
                          void assignFeedCategory(feed.id, event.target.value || null)
                        }
                        className="h-7 w-auto min-w-[120px] text-[11.5px]"
                        aria-label={t('feed.manage.moveTo')}
                      >
                        <option value="">{t('feed.add.noCategory')}</option>
                        {library.categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </Select>

                      <IconButton
                        label={t('feed.manage.refresh')}
                        size="sm"
                        onClick={() => void refreshOne(feed)}
                        disabled={busyFeedId === feed.id}
                      >
                        <RefreshCw
                          size={13}
                          className={clsx(busyFeedId === feed.id && 'animate-spin')}
                        />
                      </IconButton>
                      <IconButton
                        label={feed.paused ? t('feed.manage.resume') : t('feed.manage.pause')}
                        size="sm"
                        onClick={() => void updateFeed(feed.id, { paused: !feed.paused })}
                      >
                        {feed.paused ? <Play size={13} /> : <Pause size={13} />}
                      </IconButton>
                      <IconButton label={t('feed.manage.rename')} size="sm" onClick={() => startRename(feed)}>
                        <Pencil size={13} />
                      </IconButton>
                      {confirmDeleteId === feed.id ? (
                        <>
                          <Button size="sm" variant="danger" onClick={() => void remove(feed)}>
                            {t('common.confirm')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <IconButton
                          label={t('feed.manage.delete')}
                          size="sm"
                          onClick={() => setConfirmDeleteId(feed.id)}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      )}
                    </div>
                    {confirmDeleteId === feed.id ? (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
                        {t('feed.manage.deleteConfirm', { title, count: count.total })}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
