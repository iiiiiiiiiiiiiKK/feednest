import { X, CheckCircle2, TriangleAlert, Info } from 'lucide-react'
import clsx from 'clsx'
import { useApp } from '@/state/AppContext'

export function ToastStack() {
  const { toasts, dismissToast } = useApp()
  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-16 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6"
      role="region"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx(
            'pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lifted animate-rise',
            toast.tone === 'error' && 'border-danger/30 bg-danger-soft text-danger',
            toast.tone === 'success' && 'border-line bg-elevated text-ink',
            toast.tone === 'info' && 'border-line bg-elevated text-ink',
          )}
        >
          <span className="mt-0.5 shrink-0">
            {toast.tone === 'error' ? (
              <TriangleAlert size={15} />
            ) : toast.tone === 'success' ? (
              <CheckCircle2 size={15} className="text-success" />
            ) : (
              <Info size={15} className="text-ink-muted" />
            )}
          </span>
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed">{toast.message}</p>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.()
                dismissToast(toast.id)
              }}
              className="shrink-0 text-[12px] font-medium underline underline-offset-2"
            >
              {toast.actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
