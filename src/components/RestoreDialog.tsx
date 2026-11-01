import { useState } from 'react'
import { FileUp, Loader2, TriangleAlert, DatabaseBackup } from 'lucide-react'
import clsx from 'clsx'
import { applyRestore, parseBackup, planRestore, type RestorePlan } from '@/lib/backup'
import type { BackupPayload } from '@/lib/types'
import { useApp } from '@/state/AppContext'
import { Button, Dialog, Switch } from './ui'

export function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, pushToast } = useApp()
  const [payload, setPayload] = useState<BackupPayload | null>(null)
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [restoreSettings, setRestoreSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPayload(null)
    setPlan(null)
    setFileName(null)
    setMode('merge')
    setRestoreSettings(false)
    setError(null)
    setBusy(false)
  }

  const close = () => {
    if (busy) return
    reset()
    onClose()
  }

  const onFile = async (file: File) => {
    setError(null)
    setFileName(file.name)
    try {
      const text = await file.text()
      const parsed = parseBackup(text)
      setPayload(parsed)
      setPlan(await planRestore(parsed))
    } catch (caught) {
      setPayload(null)
      setPlan(null)
      setError(`${t('backup.restore.invalid')}: ${(caught as Error).message}`)
    }
  }

  const apply = async () => {
    if (!payload) return
    setBusy(true)
    try {
      const result = await applyRestore(payload, { mode, restoreSettings })
      pushToast({
        tone: 'success',
        message: t('backup.restore.done', { feeds: result.feedsAdded, articles: result.articlesAdded }),
      })
      close()
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('backup.restore.title')}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={mode === 'replace' ? 'danger' : 'primary'}
            onClick={() => void apply()}
            disabled={!payload || busy}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <DatabaseBackup size={15} />}
            {t('backup.restore.apply')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label
          className={clsx(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed',
            'border-line-strong bg-inset px-4 py-7 text-center transition-colors hover:border-accent hover:bg-hover',
          )}
        >
          <FileUp size={20} className="text-ink-faint" />
          <span className="text-sm font-medium text-ink">
            {locale === 'zh' ? '选择备份文件（.json）' : 'Choose a backup file (.json)'}
          </span>
          <span className="text-[11.5px] text-ink-muted">{fileName ?? 'feednest-backup.json'}</span>
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void onFile(file)
              event.target.value = ''
            }}
          />
        </label>

        {error ? (
          <p role="alert" className="flex items-start gap-1.5 text-[12px] text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {error}
          </p>
        ) : null}

        {plan ? (
          <>
            <div className="rounded-lg border border-line">
              <p className="border-b border-line px-3 py-2 text-[12px] font-medium text-ink">
                {t('backup.restore.plan')}
              </p>
              <dl className="grid grid-cols-2 gap-px bg-line text-[12px]">
                <PlanRow
                  label={locale === 'zh' ? '订阅源' : 'Feeds'}
                  added={plan.feedsNew.length}
                  existing={plan.feedsExisting}
                />
                <PlanRow
                  label={locale === 'zh' ? '文章' : 'Articles'}
                  added={plan.articlesNew}
                  existing={plan.articlesExisting}
                />
                <PlanRow
                  label={locale === 'zh' ? '分类' : 'Categories'}
                  added={plan.categoriesNew.length}
                  existing={plan.categoriesExisting}
                />
                <div className="bg-elevated px-3 py-2">
                  <dt className="text-[10.5px] uppercase tracking-wide text-ink-faint">
                    {locale === 'zh' ? '导出时间' : 'Exported'}
                  </dt>
                  <dd className="mt-0.5 text-ink-soft">
                    {new Date(payload!.exportedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="space-y-1">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2.5">
                <input
                  type="radio"
                  name="restore-mode"
                  checked={mode === 'merge'}
                  onChange={() => setMode('merge')}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-[12.5px] font-medium text-ink">
                    {t('backup.restore.merge')}
                  </span>
                  <span className="block text-[11px] text-ink-muted">
                    {locale === 'zh'
                      ? '保留现有数据，只补齐缺失的订阅源和文章。'
                      : 'Keeps what you have and only adds what is missing.'}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2.5">
                <input
                  type="radio"
                  name="restore-mode"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-[12.5px] font-medium text-ink">
                    {t('backup.restore.replace')}
                  </span>
                  <span className="block text-[11px] text-danger">{t('backup.restore.replaceWarn')}</span>
                </span>
              </label>
            </div>

            <Switch
              checked={restoreSettings}
              onChange={setRestoreSettings}
              label={t('backup.restore.settings')}
            />
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function PlanRow({ label, added, existing }: { label: string; added: number; existing: number }) {
  return (
    <div className="bg-elevated px-3 py-2">
      <dt className="text-[10.5px] uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink-soft">
        <span className="font-medium text-ink">+{added}</span>
        <span className="text-ink-faint"> · {existing} </span>
      </dd>
    </div>
  )
}
