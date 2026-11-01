/**
 * Feed avatar: real favicon when we have one, otherwise a deterministic
 * initial badge. Never a broken-image icon.
 */
import { useState } from 'react'
import clsx from 'clsx'

const PALETTE = [
  ['#a25a2b', '#f2e4d8'],
  ['#3f6f4f', '#e6efe7'],
  ['#4a5f8a', '#e4e9f2'],
  ['#7a4d7d', '#f0e4f2'],
  ['#8a6a2f', '#f3ecdc'],
  ['#356b73', '#e0eef0'],
]

function pick(seed: string): [string, string] {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 997
  }
  return PALETTE[hash % PALETTE.length] as [string, string]
}

export function FeedAvatar({
  title,
  iconUrl,
  size = 18,
  className,
}: {
  title: string
  iconUrl: string | null
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const [foreground, background] = pick(title)
  const initial = title.trim().charAt(0).toUpperCase() || '?'

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={clsx('shrink-0 rounded-[5px] object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-[5px] font-semibold',
        className,
      )}
      style={{
        width: size,
        height: size,
        background,
        color: foreground,
        fontSize: Math.max(9, Math.round(size * 0.55)),
      }}
    >
      {initial}
    </span>
  )
}
