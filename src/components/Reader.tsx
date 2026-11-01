import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  Clock,
  ExternalLink,
  Link2,
  Star,
  Info,
} from 'lucide-react'
import clsx from 'clsx'
import { db, setRead, setStarred } from '@/lib/db'
import { formatDateTime, formatRelative } from '@/lib/date'
import { readingMinutes } from '@/lib/format'
import { sanitizeHtml } from '@/lib/parse'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { FeedAvatar } from './FeedAvatar'
import { Badge, Button, EmptyState, IconButton, Spinner } from './ui'

interface ReaderProps {
  articleId: string | null
  onClose: () => void
  className?: string
}

export function Reader({ articleId, onClose, className }: ReaderProps) {
  const { t, locale, settings, pushToast, setOpenArticleId } = useApp()
  const library = useLibrary()
  const article = articleId ? library.articles.find((row) => row.id === articleId) ?? null : null
  const body = useLiveQuery(async () => {
    if (!articleId) return undefined
    return db.bodies.get(articleId)
  }, [articleId], undefined)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [progressState, setProgressState] = useState({ id: '', value: 0 })
  const progress = progressState.id === (articleId ?? '') ? progressState.value : 0

  const ordered = useMemo(
    () => [...library.articles].sort((a, b) => b.publishedAt - a.publishedAt),
    [library.articles],
  )
  const index = article ? ordered.findIndex((row) => row.id === article.id) : -1
  const previous = index > 0 ? ordered[index - 1] : null
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null

  /* Mark read on open, per the user's setting. */
  useEffect(() => {
    if (!article || !settings.markReadOnOpen || article.read) return
    void setRead([article.id], true)
  }, [article, settings.markReadOnOpen])

  /* Reset the scroll position when switching articles (DOM write only). */
  useEffect(() => {
    const node = scrollerRef.current
    if (node) node.scrollTop = 0
  }, [articleId])

  const onScroll = () => {
    const node = scrollerRef.current
    if (!node) return
    const max = node.scrollHeight - node.clientHeight
    const value = max > 0 ? Math.min(1, node.scrollTop / max) : 0
    setProgressState({ id: articleId ?? '', value })
  }

  if (!article) {
    return (
      <div className={clsx('flex min-w-0 flex-1 flex-col bg-bg', className)}>
        <EmptyState
          icon={<ArticleGlyph />}
          title={locale === 'zh' ? '选择一篇文章开始阅读' : 'Pick an article to start reading'}
          body={
            locale === 'zh'
              ? '左侧列表中的每一篇文章都会在这里安静地打开。'
              : 'Everything you open appears here, without ads or distractions.'
          }
        />
      </div>
    )
  }

  const feed = library.feedById.get(article.feedId)
  const feedTitle = feed?.customTitle || feed?.title || 'Unknown feed'
  const html = body?.html ? sanitizeHtml(body.html, article.url) : ''
  const minutes = readingMinutes(article.contentLength)

  const toggleStar = async () => {
    await setStarred([article.id], !article.starred)
  }

  const toggleRead = async () => {
    await setRead([article.id], !article.read)
  }

  const copyLink = async () => {
    if (!article.url) return
    try {
      await navigator.clipboard.writeText(article.url)
      pushToast({ tone: 'success', message: t('article.copied') })
    } catch {
      pushToast({ tone: 'error', message: t('article.openFailed') })
    }
  }

  return (
    <article className={clsx('relative flex min-w-0 flex-1 flex-col bg-bg', className)}>
      <div className="absolute inset-x-0 top-0 z-20 h-0.5 bg-transparent" aria-hidden="true">
        <div
          className="h-full bg-accent transition-[width] duration-150"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 sm:px-4">
        <IconButton label={t('article.back')} onClick={onClose} className="md:hidden">
          <ArrowLeft size={18} />
        </IconButton>

        <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
          <FeedAvatar title={feedTitle} iconUrl={feed?.iconUrl ?? null} size={15} />
          <span className="truncate font-medium text-ink-soft">{feedTitle}</span>
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          {article.url ? (
            <>
              <IconButton label={t('article.copyLink')} onClick={() => void copyLink()} size="sm">
                <Link2 size={15} />
              </IconButton>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('article.openOriginal')}
                title={t('article.openOriginal')}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-hover hover:text-ink"
              >
                <ExternalLink size={15} />
              </a>
            </>
          ) : null}
          <IconButton label={article.read ? t('article.markUnread') : t('article.markRead')} onClick={() => void toggleRead()} size="sm" active={!article.read}>
            {article.read ? <Circle size={15} /> : <Check size={15} />}
          </IconButton>
          <IconButton
            label={article.starred ? t('article.unstar') : t('article.star')}
            onClick={() => void toggleStar()}
            size="sm"
            active={article.starred}
          >
            <Star size={15} fill={article.starred ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
      </header>

      <div ref={scrollerRef} onScroll={onScroll} className="pane-scroll min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[68ch] px-5 pb-16 pt-8 sm:px-8 sm:pt-12">
          <h1 className="text-[26px] font-semibold leading-[1.24] tracking-[-0.02em] text-ink sm:text-[30px]">
            {article.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-muted">
            {article.author ? <span className="font-medium text-ink-soft">{article.author}</span> : null}
            {article.author ? <Dot /> : null}
            <time dateTime={new Date(article.publishedAt).toISOString()} title={formatDateTime(article.publishedAt, locale)}>
              {formatRelative(article.publishedAt, locale)}
            </time>
            <Dot />
            <span className="inline-flex items-center gap-1">
              <Clock size={12} />
              {locale === 'zh' ? `${minutes} 分钟` : `${minutes} min read`}
            </span>
            {article.contentKind === 'summary' ? (
              <>
                <Dot />
                <Badge tone="accent">{t('article.summaryNoticeShort')}</Badge>
              </>
            ) : null}
            {article.publishedAtSource === 'fetched' ? (
              <>
                <Dot />
                <Badge>{t('article.dateUnknown')}</Badge>
              </>
            ) : null}
          </div>

          <hr className="my-6 border-line" />

          {article.contentKind === 'summary' ? (
            <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-line bg-inset px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-muted">
              <Info size={15} className="mt-0.5 shrink-0 text-accent" />
              <div>
                {t('article.summaryNotice')}
                {article.url ? (
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 font-medium text-accent underline underline-offset-2"
                  >
                    {t('article.openOriginal')}
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}

          {body === undefined ? (
            <div className="flex items-center gap-2 py-8 text-sm text-ink-faint">
              <Spinner /> {t('list.loading')}
            </div>
          ) : html ? (
            <div
              className={clsx('prose-feed', settings.hideImages && '[&_img]:hidden [&_figure]:hidden')}
              // Sanitised twice: at ingest and again at render for old rows.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <p className="text-sm leading-relaxed text-ink-muted">{t('article.noContent')}</p>
          )}

          <div className="mt-12 flex items-center justify-between gap-3 border-t border-line pt-5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => previous && setOpenArticleId(previous.id)}
              disabled={!previous}
              className="max-w-[45%] justify-start"
            >
              <ArrowLeft size={14} />
              <span className="truncate">{t('article.prev')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => next && setOpenArticleId(next.id)}
              disabled={!next}
              className="max-w-[45%] justify-end text-right"
            >
              <span className="truncate">{t('article.next')}</span>
              <ArrowRight size={14} />
            </Button>
          </div>

          {article.url ? (
            <p className="mt-4 text-center text-[11px] text-ink-faint">
              {locale === 'zh' ? '原文' : 'Source'}:{' '}
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all underline underline-offset-2 hover:text-ink"
              >
                {article.url.replace(/^https?:\/\//, '')}
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </article>
  )
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-line-strong">
      ·
    </span>
  )
}

function ArticleGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 4h9l4 4v12H6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
