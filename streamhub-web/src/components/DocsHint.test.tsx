/**
 * Component/DOM test — DocsHint (vitest + jsdom + @testing-library).
 *
 * The contextual "?" help affordance must be a REAL external link into the
 * docs site, resolved through the single section → docs-path map:
 *  - href is the absolute docs URL for the mapped section;
 *  - opens in a new tab (`target="_blank"`) with `rel` carrying `noopener`
 *    (never hand window.opener to another origin);
 *  - icon-only by default, "Learn more ↗" text with `showLabel`;
 *  - accessible name comes from i18n (common:docsHint.learnMore).
 *
 * react-i18next is stubbed to echo keys so assertions are text-independent.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

import { DocsHint } from './DocsHint'
import { DOCS_PATHS } from '@/lib/docs'

describe('DocsHint', () => {
  it('links the mapped docs page in a new tab with noopener', () => {
    render(<DocsHint section="streams" />)
    const link = screen.getByRole('link', { name: 'docsHint.learnMore' })
    expect(link.getAttribute('href')).toBe(
      'https://streamhub.studio/docs/features/streams',
    )
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('resolves every section through the single source-of-truth map', () => {
    for (const [section, path] of Object.entries(DOCS_PATHS)) {
      const { unmount } = render(
        <DocsHint section={section as keyof typeof DOCS_PATHS} />,
      )
      const link = screen.getByRole('link', { name: 'docsHint.learnMore' })
      expect(link.getAttribute('href')).toBe(
        `https://streamhub.studio/docs/${path}`,
      )
      unmount()
    }
  })

  it('icon-only by default; showLabel renders the "Learn more" text', () => {
    const { rerender } = render(<DocsHint section="config" />)
    expect(screen.queryByText(/docsHint\.learnMore/)).toBeNull()

    rerender(<DocsHint section="config" showLabel />)
    expect(screen.getByText(/docsHint\.learnMore/)).toBeTruthy()
  })
})
