import { describe, expect, it } from 'vitest'
import { dictionaryKeys, translate, detectLocale, type Locale } from '@/lib/i18n'

describe('translations', () => {
  it('has the same keys in both locales', () => {
    const en = dictionaryKeys('en').sort()
    const zh = dictionaryKeys('zh').sort()
    expect(zh).toEqual(en)
  })

  it('translates known keys', () => {
    expect(translate('en', 'nav.unread')).toBe('Unread')
    expect(translate('zh', 'nav.unread')).toBe('未读')
  })

  it('interpolates parameters', () => {
    expect(translate('en', 'list.markedRead', { count: 3 })).toBe('3 marked as read')
    expect(translate('zh', 'list.markedRead', { count: 3 })).toBe('已将 3 篇标记为已读')
  })

  it('falls back to the key when a translation is missing', () => {
    expect(translate('en', 'does.not.exist')).toBe('does.not.exist')
  })

  it('detects zh locales from the browser', () => {
    const previous = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { languages: ['zh-CN', 'en'], language: 'zh-CN' },
      configurable: true,
    })
    expect(detectLocale()).toBe<Locale>('zh')
    Object.defineProperty(globalThis, 'navigator', {
      value: { languages: ['fr-FR'], language: 'fr-FR' },
      configurable: true,
    })
    expect(detectLocale()).toBe<Locale>('en')
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true })
  })
})
