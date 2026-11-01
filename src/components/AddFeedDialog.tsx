import { useMemo, useState } from 'react'
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import clsx from 'clsx'
import { resolveFeed, STARTER_FEEDS, type ResolvedFeed } from '@/lib/addFeed'
import { addFeed, DuplicateFeedError, ingestItems } from '@/lib/db'
import { FeedFetchError } from '@/lib/fetch'
import { FeedParseError } from '@/lib/parse'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { Button, Dialog, Field, Select, TextInput } from './ui'

export function AddFeedDialog({
  open,
  onClose,
  initialCategoryId,
}: {
  open: boolean
  onClose: () => void
  initialCategoryId?: string | null
}) {
  const { t, locale, settings, navigate, pushToast, refresh } = useApp()
  const library = useLibrary()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [categoryId, setCategoryId] = useState<string>(initialCategoryId ?? '')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<ResolvedFeed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<string | null>(null)

  const reset = () => {
    setUrl('')
    setTitle('')
    setPreview(null)
    setError(null)
    setErrorKind(null)
    setBusy(false)
  }

  const close = () => {
    reset()
    onClose()
  }

  const explainError = (caught: unknown): string => {
    if (caught instanceof FeedFetchError) {
      if (caught.kind === 'cors') return t('error.cors')
      if (caught.kind === 'timeout') return t('error.timeout')
      if (caught.kind === 'http') return `${t('error.http')} (${caught.status ?? '?'}) — ${caught.message}`
      if (caught.kind === 'parse') return t('error.parse')
      return `${t('error.unknown')} ${caught.message}`
    }
    if (caught instanceof FeedParseError) return t('error.parse')
    return caught instanceof Error ? caught.message : String(caught)
  }

  const load = async (target = url) => {
    const candidate = target.trim()
    if (!candidate) return
    setBusy(true)
    setError(null)
    setErrorKind(null)
    setPreview(null)
    try {
      const resolved = await resolveFeed(candidate, { proxyUrl: settings.proxyUrl })
      const duplicate = library.feeds.find(
        (feed) => feed.url === resolved.url || feed.url === candidate,
      )
      if (duplicate) {
        setError(t('feed.add.duplicate'))
        setErrorKind('duplicate')
        setBusy(false)
        return
      }
      setPreview(resolved)
      setUrl(resolved.url)
    } catch (caught) {
      if (caught instanceof FeedFetchError) setErrorKind(caught.kind)
      setError(explainError(caught))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const feed = await addFeed({
        url: preview.url,
        parsed: preview.parsed,
        title: title.trim() || null,
        categoryId: categoryId || null,
      })
      const result = await ingestItems(feed, preview.parsed)
      pushToast({
        tone: 'success',
        message: t('feed.add.success', {
          title: title.trim() || preview.parsed.title,
          count: result.inserted,
        }),
      })
      close()
      navigate({ view: 'feed', id: feed.id })
      // A fresh feed may still be missing older items; a refresh is cheap.
      void refresh.run({ feedIds: [feed.id], force: true })
    } catch (caught) {
      if (caught instanceof DuplicateFeedError) {
        setError(t('feed.add.duplicate'))
      } else {
        setError(explainError(caught))
      }
    } finally {
      setBusy(false)
    }
  }

  const hint = useMemo(() => {
    if (!preview) return t('feed.add.hint')
    const { parsed } = preview
    return `${parsed.format.toUpperCase()} · ${parsed.items.length} ${
      locale === 'zh' ? '条内容' : parsed.items.length === 1 ? 'item' : 'items'
    }`
  }, [preview, t, locale])

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('feed.add.title')}
      description={t('feed.add.hint')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          {preview ? (
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={busy}
              data-testid="confirm-add-feed"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              {t('feed.add.confirm')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void load()}
              disabled={busy || !url.trim()}
              data-testid="discover-feed"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : null}
              {t('feed.add.discover')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('feed.add.urlLabel')}>
          <div className="flex gap-2">
            <TextInput
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setPreview(null)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  if (preview) void submit()
                  else void load()
                }
              }}
              placeholder={t('feed.add.urlPlaceholder')}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
            />
          </div>
        </Field>

        {busy && !preview ? (
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            <Loader2 size={14} className="animate-spin" />
            {t('feed.add.discovering')}
          </p>
        ) : null}

        {error ? (
          <div
            role="alert"
            className={clsx(
              'rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed',
              errorKind === 'duplicate'
                ? 'border-line bg-inset text-ink-muted'
                : 'border-danger/30 bg-danger-soft text-danger',
            )}
          >
            <div className="flex gap-2">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" />
              <div>
                <p>{error}</p>
                {errorKind === 'cors' ? (
                  <p className="mt-1.5 text-[11.5px] opacity-90">
                    {locale === 'zh' ? '提示：' : 'Tip: '}
                    {t('settings.proxyHint')}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {preview ? (
          <div className="rounded-lg border border-line bg-inset px-3 py-3">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">
                  {preview.parsed.title}
                </p>
                <p className="mt-0.5 text-[11.5px] text-ink-muted">{hint}</p>
                {preview.parsed.description ? (
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-faint">
                    {preview.parsed.description}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t('feed.add.titleLabel')}`}>
            <TextInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={preview?.parsed.title ?? ''}
            />
          </Field>
          <Field label={t('feed.add.categoryLabel')}>
            <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{t('feed.add.noCategory')}</option>
              {library.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {!preview ? (
          <div className="rounded-lg border border-line bg-inset px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-muted">
            {t('feed.add.corsWarning')}
          </div>
        ) : null}

        {!preview ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-muted">{t('feed.add.samples')}</p>
            <div className="flex flex-wrap gap-1.5">
              {STARTER_FEEDS.map((sample) => (
                <button
                  key={sample.url}
                  type="button"
                  onClick={() => {
                    setUrl(sample.url)
                    void load(sample.url)
                  }}
                  className="rounded-full border border-line bg-elevated px-2.5 py-1 text-[11.5px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
