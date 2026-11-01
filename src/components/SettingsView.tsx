import { useEffect, useState } from 'react'
import {
  Download,
  Upload,
  Trash2,
  ShieldCheck,
  GitBranch,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import clsx from 'clsx'
import {
  clearAllData,
  ensureDbReady,
  saveSettings,
  storageEstimate,
} from '@/lib/db'
import { createBackup, createFavoritesExport, createReadHistoryExport, serializeBackup } from '@/lib/backup'
import { buildOpml } from '@/lib/opml'
import { buildProxyRequest } from '@/lib/fetch'
import { downloadFile, formatBytes, timestampSlug } from '@/lib/format'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { AUTHOR_X_URL } from './TopBar'
import { Button, Field, Select, Segment, Switch, TextInput } from './ui'

export function SettingsView({
  onOpenOpml,
  onOpenRestore,
  onOpenCategories,
  onOpenFeeds,
}: {
  onOpenOpml: () => void
  onOpenRestore: () => void
  onOpenCategories: () => void
  onOpenFeeds: () => void
}) {
  const { t, settings, updateSettings, pushToast } = useApp()
  const library = useLibrary()
  const [proxyDraft, setProxyDraft] = useState(settings.proxyUrl)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [proxyState, setProxyState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    void storageEstimate().then(setStorage)
  }, [library.articles.length])

  const exportOpml = () => {
    downloadFile(
      `feednest-subscriptions-${timestampSlug()}.opml`,
      buildOpml(library.feeds, library.categories),
      'text/x-opml',
    )
  }

  const exportBackup = async () => {
    const payload = await createBackup()
    downloadFile(
      `feednest-backup-${timestampSlug()}.json`,
      serializeBackup(payload),
      'application/json',
    )
  }

  const exportStarred = async () => {
    const payload = await createFavoritesExport()
    downloadFile(`feednest-starred-${timestampSlug()}.json`, JSON.stringify(payload, null, 2), 'application/json')
  }

  const exportHistory = async () => {
    const payload = await createReadHistoryExport()
    downloadFile(`feednest-history-${timestampSlug()}.json`, JSON.stringify(payload, null, 2), 'application/json')
  }

  const testProxy = async () => {
    if (!proxyDraft.trim()) return
    setProxyState('testing')
    try {
      const target = 'https://github.blog/feed/'
      const response = await fetch(buildProxyRequest(proxyDraft.trim(), target), {
        headers: { Accept: 'application/rss+xml' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (!/<rss|<feed|<rdf:RDF/i.test(text.slice(0, 2000))) throw new Error('Not a feed')
      setProxyState('ok')
      pushToast({ tone: 'success', message: t('settings.proxyOk') })
      await saveSettings({ proxyUrl: proxyDraft.trim(), proxyConfiguredAt: Date.now() })
    } catch (error) {
      setProxyState('fail')
      pushToast({ tone: 'error', message: `${t('settings.proxyFail')}: ${(error as Error).message}` })
    }
  }

  const clearEverything = async () => {
    await clearAllData()
    await ensureDbReady()
    setConfirmClear(false)
    pushToast({ tone: 'success', message: t('settings.cleared') })
  }

  return (
    <div className="pane-scroll h-full flex-1 bg-bg">
      <div className="mx-auto w-full max-w-3xl px-5 pb-20 pt-6 sm:px-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('settings.title')}</h1>
          <p className="mt-1 text-[12.5px] text-ink-muted">{t('settings.privacyBody')}</p>
        </header>

        <Section title={t('settings.appearance')}>
          <Row label={t('settings.theme')}>
            <Segment
              value={settings.theme}
              onChange={(theme) => void updateSettings({ theme })}
              options={[
                { value: 'light', label: t('settings.theme.light') },
                { value: 'dark', label: t('settings.theme.dark') },
                { value: 'system', label: t('settings.theme.system') },
              ]}
            />
          </Row>
          <Row label={t('settings.language')}>
            <Segment
              value={settings.locale}
              onChange={(next) => void updateSettings({ locale: next })}
              options={[
                { value: 'en', label: 'English' },
                { value: 'zh', label: '简体中文' },
              ]}
            />
          </Row>
        </Section>

        <Section title={t('settings.reading')}>
          <Row label={t('settings.sortOrder')}>
            <Select
              value={settings.sortOrder}
              onChange={(event) =>
                void updateSettings({ sortOrder: event.target.value as 'newest' | 'oldest' })
              }
              className="w-40"
            >
              <option value="newest">{t('list.sortNewest')}</option>
              <option value="oldest">{t('list.sortOldest')}</option>
            </Select>
          </Row>
          <Switch
            checked={settings.markReadOnOpen}
            onChange={(value) => void updateSettings({ markReadOnOpen: value })}
            label={t('settings.markReadOnOpen')}
          />
          <Switch
            checked={settings.hideImages}
            onChange={(value) => void updateSettings({ hideImages: value })}
            label={t('settings.hideImages')}
          />
          <Switch
            checked={settings.collapseDuplicates}
            onChange={(value) => void updateSettings({ collapseDuplicates: value })}
            label={t('settings.collapseDuplicates')}
          />
        </Section>

        <Section title={t('settings.refresh')}>
          <Row label={t('settings.refreshInterval')}>
            <Select
              value={String(settings.refreshInterval)}
              onChange={(event) =>
                void updateSettings({
                  refreshInterval: Number(event.target.value) as typeof settings.refreshInterval,
                })
              }
              className="w-52"
            >
              <option value="0">{t('settings.refresh.manual')}</option>
              <option value="15">{t('settings.refresh.15')}</option>
              <option value="30">{t('settings.refresh.30')}</option>
              <option value="60">{t('settings.refresh.60')}</option>
              <option value="360">{t('settings.refresh.360')}</option>
              <option value="720">{t('settings.refresh.720')}</option>
            </Select>
          </Row>
          <p className="mt-1 rounded-lg border border-line bg-inset px-3 py-2 text-[11.5px] leading-relaxed text-ink-muted">
            {t('settings.refreshNote')}
          </p>
        </Section>

        <Section title={t('settings.network')}>
          <Field label={t('settings.proxyUrl')} hint={t('settings.proxyHint')}>
            <div className="flex flex-wrap gap-2">
              <TextInput
                value={proxyDraft}
                onChange={(event) => {
                  setProxyDraft(event.target.value)
                  setProxyState('idle')
                }}
                placeholder="https://rss-proxy.example.workers.dev"
                inputMode="url"
                spellCheck={false}
                className="min-w-[240px] flex-1"
              />
              <Button
                variant="secondary"
                onClick={() => void testProxy()}
                disabled={!proxyDraft.trim() || proxyState === 'testing'}
              >
                {proxyState === 'testing' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : proxyState === 'ok' ? (
                  <CheckCircle2 size={15} className="text-success" />
                ) : proxyState === 'fail' ? (
                  <XCircle size={15} className="text-danger" />
                ) : null}
                {t('settings.proxyTest')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void updateSettings({
                    proxyUrl: proxyDraft.trim(),
                    proxyConfiguredAt: Date.now(),
                  })
                  pushToast({ tone: 'success', message: t('common.save') })
                }}
                disabled={proxyDraft === settings.proxyUrl}
              >
                {t('common.save')}
              </Button>
            </div>
          </Field>
        </Section>

        <Section title={t('settings.data')}>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">{t('settings.dataNote')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" onClick={exportOpml} disabled={library.feeds.length === 0}>
              <Download size={15} /> {t('settings.exportOpml')}
            </Button>
            <Button variant="secondary" onClick={() => void exportBackup()}>
              <Download size={15} /> {t('settings.exportBackup')}
            </Button>
            <Button variant="secondary" onClick={() => void exportStarred()}>
              <Download size={15} /> {t('settings.exportStarred')}
            </Button>
            <Button variant="secondary" onClick={() => void exportHistory()}>
              <Download size={15} /> {t('settings.exportHistory')}
            </Button>
            <Button variant="secondary" onClick={onOpenOpml}>
              <Upload size={15} /> {t('settings.importOpml')}
            </Button>
            <Button variant="secondary" onClick={onOpenRestore}>
              <Upload size={15} /> {t('settings.importBackup')}
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-muted">
            <span>
              {t('settings.storage')}:{' '}
              <span className="tabular-nums text-ink-soft">
                {storage ? formatBytes(storage.usage) : '—'}
              </span>
            </span>
            <span>
              {library.feeds.length} feeds · {library.articles.length} articles
            </span>
            <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={onOpenFeeds}>
              {t('feed.manage.title')}
            </button>
            <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={onOpenCategories}>
              {t('nav.categories')}
            </button>
          </div>
        </Section>

        <Section title={t('settings.dangerZone')} tone="danger">
          {confirmClear ? (
            <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-3">
              <p className="text-[12px] leading-relaxed text-danger">{t('settings.clearAllConfirm')}</p>
              <div className="mt-2.5 flex gap-2">
                <Button variant="danger" size="sm" onClick={() => void clearEverything()}>
                  <Trash2 size={14} /> {t('common.confirm')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmClear(true)} className="text-danger">
              <Trash2 size={15} /> {t('settings.clearAll')}
            </Button>
          )}
        </Section>

        <Section title={t('settings.privacy')}>
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-muted">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
            {t('settings.privacyBody')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11.5px]">
            <a
              href="https://github.com/iiiiiiiiiiiiiKK/feednest"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              <GitBranch size={13} /> GitHub
            </a>
            <a
              href={AUTHOR_X_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              <ExternalLink size={13} /> 𝕏 / @0xkillcoin
            </a>
            <span className="text-ink-faint">MIT License · v1.0.0</span>
          </div>
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
  tone,
}: {
  title: string
  children: React.ReactNode
  tone?: 'danger'
}) {
  return (
    <section className="mb-6 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <h2
        className={clsx(
          'mb-2.5 text-[11px] font-semibold uppercase tracking-[0.09em]',
          tone === 'danger' ? 'text-danger' : 'text-ink-faint',
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
    </div>
  )
}
