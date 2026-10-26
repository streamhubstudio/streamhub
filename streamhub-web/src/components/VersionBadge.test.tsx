/**
 * Component/DOM test — VersionBadge (vitest + jsdom + @testing-library).
 *
 * The footer version must come from the public bootstrap endpoint
 * (GET /auth/config → `appVersion`, the repo-root VERSION file), never from a
 * package.json. Locks down:
 *  - renders "StreamHub v<appVersion>" from the config response;
 *  - it is a changelog link opening in a new tab with `noopener`;
 *  - renders NOTHING against an older backend that omits the field (and while
 *    the config is still loading) — the footer must not show a bogus version.
 *
 * `@/api` auth.config is mocked; react-i18next is stubbed to echo keys.
 * No network, no i18n bootstrap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { config } = vi.hoisted(() => ({ config: vi.fn() }))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, api: { auth: { config } } }
})

import { VersionBadge } from './VersionBadge'
import { CHANGELOG_URL } from '@/lib/links'

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  config.mockReset()
})

describe('VersionBadge', () => {
  it('renders the appVersion from GET /auth/config as a changelog link', async () => {
    config.mockResolvedValue({ allowSignup: false, appVersion: '2.7.0' })
    render(<VersionBadge />, { wrapper: wrapper() })

    const link = await screen.findByText('StreamHub v2.7.0')
    expect(config).toHaveBeenCalled()
    expect(link.getAttribute('href')).toBe(CHANGELOG_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('renders nothing when the backend omits appVersion (older core)', async () => {
    config.mockResolvedValue({ allowSignup: false })
    const { container } = render(<VersionBadge />, { wrapper: wrapper() })

    await waitFor(() => expect(config).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
    expect(screen.queryByText(/StreamHub v/)).toBeNull()
  })
})
