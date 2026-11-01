import { useMemo, useRef, useState } from 'react'
import { CheckCircle2, Download, FileUp, Loader2, TriangleAlert, Upload } from 'lucide-react'
import clsx from 'clsx'
import { addFeed, createCategory, findFeedByUrl, ingestItems } from '@/lib/db'
import { buildOpml, parseOpml, type OpmlParseResult } from '@/lib/opml'
import { resolveFeed } from '@/lib/addFeed'
import { downloadFile, timestampSlug } from '@/lib/format'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { Badge, Button, Dialog, Segment } from './ui'

type Tab = 'import' | 'export'

export function OpmlDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, settings, pushToast, refresh, navigate } = useApp()
  const library = useLibrary()
  const [tab, setTab] = useState<Tab>('import')
  const [parsed, setParsed] = useState<OpmlParseResult | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const existingUrls = useMemo(
    () => new Set(library.feeds.map((feed) => feed.url)),
    [library.feeds],
  )

  const rows = useMemo(() => {
    if (!parsed) return []
    return parsed.entries.map((entry) => ({
      ...entry,
      alreadySubscribed: existingUrls.has(entry.xmlUrl),
    }))
  }, [parsed, existingUrls])

  const importable = rows.filter((row) => !row.error && !row.duplicateOf && !row.alreadySubscribed)

  const onFile = async (file: File) => {
    setError(null)
    setParsed(null)
    setFileName(file.name)
    try {
      const text = await file.text()
      setParsed(parseOpml(text))
    } catch (caught) {
      setError(`${t('opml.import.error')}: ${(caught as Error).message}`)
    }
  }

  const runImport = async () => {
    if (!parsed || importable.length === 0) return
    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: importable.length })
    let imported = 0
    let articles = 0
    const failures: string[] = []
    const createdFeedIds: string[] = []

    try {
      for (const row of importable) {
        try {
          const categoryName = row.categoryPath[row.categoryPath.length - 1] ?? null
          let categoryId: string | null = null
          if (categoryName) {
            const existing = library.categories.find(
              (category) => category.name.toLowerCase() === categoryName.toLowerCase(),
            )
            categoryId = existing?.id ?? (await createCategory(categoryName)).id
          }
          if (await findFeedByUrl(row.xmlUrl)) {
            failures.push(`${row.xmlUrl} · ${t('opml.import.rowDuplicate')}`)
            continue
          }
          const resolved = await resolveFeed(row.xmlUrl, { proxyUrl: settings.proxyUrl })
          const feed = await addFeed({
            url: resolved.url,
            parsed: resolved.parsed,
            title: row.title,
            categoryId,
          })
          const result = await ingestItems(feed, resolved.parsed)
          articles += result.inserted
          imported += 1
          createdFeedIds.push(feed.id)
        } catch (caught) {
          failures.push(`${row.xmlUrl} · ${(caught as Error).message}`)
        } finally {
          setProgress((current) =>
            current ? { done: current.done + 1, total: current.total } : current,
          )
        }
      }

      if (createdFeedIds.length > 0) {
        await refresh.run({ feedIds: createdFeedIds, force: true })
      }

      if (failures.length > 0) {
        pushToast({
          tone: 'error',
          message: `${t('opml.import.done', { feeds: imported, articles })} · ${failures.length} ${
            locale === 'zh' ? '个失败' : 'failed'
          }`,
        })
      } else {
        pushToast({
          tone: 'success',
          message: t('opml.import.done', { feeds: imported, articles }),
        })
      }
      onClose()
      navigate({ view: 'all' })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const exportOpml = () => {
    const xml = buildOpml(library.feeds, library.categories, {
      title: 'FeedNest subscriptions',
    })
    downloadFile(`feednest-subscriptions-${timestampSlug()}.opml`, xml, 'text/x-opml')
    pushToast({ tone: 'success', message: t('settings.exportOpml') })
  }

  const close = () => {
    if (busy) return
    setParsed(null)
    setFileName(null)
    setError(null)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('opml.import.title')}
      width="lg"
      footer={
        tab === 'import' ? (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void runImport()}
              disabled={busy || importable.length === 0}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {busy && progress
                ? `${progress.done}/${progress.total}`
                : t('opml.import.import', { count: importable.length })}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>
            {t('common.done')}
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <Segment
          value={tab}
          onChange={setTab}
          options={[
            { value: 'import', label: t('settings.importOpml') },
            { value: 'export', label: t('settings.exportOpml') },
          ]}
        />

        {tab === 'import' ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".opml,.xml,text/xml,application/xml"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void onFile(file)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-inset px-4 py-8 text-center transition-colors hover:border-accent hover:bg-hover"
            >
              <FileUp size={22} className="text-ink-faint" />
              <span className="text-sm font-medium text-ink">{t('opml.import.choose')}</span>
              <span className="text-[11.5px] text-ink-muted">
                {fileName ?? 'OPML 1.0 / 2.0'}
              </span>
            </button>

            {error ? (
              <p role="alert" className="flex items-start gap-1.5 text-[12px] text-danger">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {error}
              </p>
            ) : null}

            {parsed ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-muted">
                  <Badge tone="accent">{t('opml.import.found', { count: rows.length })}</Badge>
                  {rows.filter((row) => row.duplicateOf || row.alreadySubscribed).length ? (
                    <Badge>
                      {t('opml.import.duplicates', {
                        count: rows.filter((row) => row.duplicateOf || row.alreadySubscribed).length,
                      })}
                    </Badge>
                  ) : null}
                  {rows.filter((row) => row.error).length ? (
                    <Badge tone="danger">
                      {t('opml.import.errors', { count: rows.filter((row) => row.error).length })}
                    </Badge>
                  ) : null}
                </div>

                <ul className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {rows.map((row, index) => {
                    const skip = row.error || row.duplicateOf || row.alreadySubscribed
                    return (
                      <li
                        key={`${row.xmlUrl}-${index}`}
                        className={clsx('px-3 py-2', skip && 'bg-inset/60 opacity-70')}
                      >
                        <div className="flex items-start gap-2">
                          {skip ? (
                            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-ink-faint" />
                          ) : (
                            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-[12.5px] font-medium text-ink">
                              {row.title || row.xmlUrl}
                            </p>
                            <p className="truncate text-[11px] text-ink-faint">{row.xmlUrl}</p>
                            {row.categoryPath.length ? (
                              <p className="mt-0.5 text-[10.5px] text-ink-muted">
                                {t('opml.import.categoryFrom')}: {row.categoryPath.join(' / ')}
                              </p>
                            ) : null}
                            {row.error ? (
                              <p className="mt-0.5 text-[10.5px] text-danger">
                                {t('opml.import.rowError')}: {row.error}
                              </p>
                            ) : row.duplicateOf || row.alreadySubscribed ? (
                              <p className="mt-0.5 text-[10.5px] text-ink-muted">
                                {t('opml.import.rowDuplicate')}
                                {row.alreadySubscribed ? ' · already subscribed' : ''}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  {locale === 'zh'
                    ? '导入时会逐个抓取订阅源，允许部分失败；失败条目会单独提示。'
                    : 'Each feed is fetched during import. Individual failures are reported and do not stop the rest.'}
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              {locale === 'zh'
                ? `将导出 ${library.feeds.length} 个订阅源及 ${library.categories.length} 个分类。`
                : `Exports ${library.feeds.length} feeds and ${library.categories.length} categories.`}
            </p>
            <Button variant="primary" onClick={exportOpml} disabled={library.feeds.length === 0}>
              <Download size={15} />
              {t('settings.exportOpml')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
