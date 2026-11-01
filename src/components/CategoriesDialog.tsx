import { useState } from 'react'
import { Check, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  createCategory,
  deleteCategory,
  DuplicateCategoryError,
  renameCategory,
} from '@/lib/db'
import { useApp } from '@/state/AppContext'
import { useLibrary } from '@/state/useLibrary'
import { Button, Dialog, IconButton, TextInput } from './ui'

export function CategoriesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale, pushToast } = useApp()
  const library = useLibrary()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const feedCount = (categoryId: string) =>
    library.feeds.filter((feed) => feed.categoryId === categoryId).length

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await createCategory(trimmed)
      setName('')
      setError(null)
      pushToast({ tone: 'success', message: trimmed })
    } catch (caught) {
      setError(
        caught instanceof DuplicateCategoryError ? t('category.duplicate') : (caught as Error).message,
      )
    }
  }

  const saveRename = async (id: string) => {
    try {
      await renameCategory(id, draft)
      setEditingId(null)
      setError(null)
    } catch (caught) {
      setError(
        caught instanceof DuplicateCategoryError ? t('category.duplicate') : (caught as Error).message,
      )
    }
  }

  const remove = async (id: string) => {
    await deleteCategory(id)
    setConfirmId(null)
    pushToast({ tone: 'success', message: locale === 'zh' ? '分类已删除' : 'Category deleted' })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('nav.categories')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.done')}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <TextInput
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
            placeholder={t('category.namePlaceholder')}
            aria-label={t('category.new')}
          />
          <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
            <Plus size={15} />
            {t('category.create')}
          </Button>
        </div>

        {error ? (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        ) : null}

        <ul className="divide-y divide-line rounded-lg border border-line">
          {library.categories.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-ink-faint">{t('category.empty')}</li>
          ) : null}
          {library.categories.map((category) => (
            <li key={category.id} className="flex items-center gap-2 px-3 py-2">
              {editingId === category.id ? (
                <>
                  <TextInput
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveRename(category.id)
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    className="h-8 text-[13px]"
                    autoFocus
                  />
                  <IconButton label={t('common.save')} size="sm" onClick={() => void saveRename(category.id)}>
                    <Check size={14} />
                  </IconButton>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{category.name}</span>
                  <span className="text-[11px] tabular-nums text-ink-faint">
                    {feedCount(category.id)}
                  </span>
                  <IconButton
                    label={t('category.rename')}
                    size="sm"
                    onClick={() => {
                      setEditingId(category.id)
                      setDraft(category.name)
                    }}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  {confirmId === category.id ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => void remove(category.id)}>
                        {t('common.confirm')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                        {t('common.cancel')}
                      </Button>
                    </>
                  ) : (
                    <IconButton
                      label={t('category.delete')}
                      size="sm"
                      onClick={() => setConfirmId(category.id)}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>

        <p className="text-[11px] leading-relaxed text-ink-faint">{t('category.deleteConfirm', { name: '…' })}</p>
      </div>
    </Dialog>
  )
}
