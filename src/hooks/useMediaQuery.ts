import { useEffect, useState } from 'react'

/** Reactive CSS media query, SSR-safe. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia(query)
    const onChange = () => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** True on phone-sized viewports, matching Tailwind's `md` breakpoint. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
