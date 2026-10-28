/**
 * Component/DOM test — AppLayout shell (vitest + jsdom + @testing-library).
 *
 * Locks the mobile-first navigation contract: under `lg` the sidebar lives in an
 * off-canvas Drawer opened by the topbar hamburger. jsdom has no layout engine
 * (media queries don't apply), so we assert on the toggle's STATE rather than on
 * computed visibility: the hamburger carries `aria-expanded`, and the Drawer
 * (react-modal) only mounts its content — including its own close button — while
 * open. The leaf chrome (lang switch, version badge) is stubbed so the
 * test stays about the shell, not its widgets.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  }
})

vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    isSuperadmin: false,
    canEdit: true,
    role: 'owner',
    identity: { email: 'dev@example.com' },
    logout: vi.fn(),
  }),
}))

// Leaf chrome widgets have their own data/context deps — stub them out.
vi.mock('@/i18n', () => ({ LanguageSwitcher: () => <div data-testid="lang-switcher" /> }))
vi.mock('@/components/VersionBadge', () => ({ VersionBadge: () => <div data-testid="version-badge" /> }))

import { AppLayout } from './AppLayout'

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AppLayout />
    </MemoryRouter>,
  )
}

describe('AppLayout — mobile navigation shell', () => {
  it('opens the off-canvas drawer from the topbar hamburger', () => {
    renderShell()

    const hamburger = screen.getByLabelText('layout.openMenu')
    // Closed initially: aria-expanded false, drawer (+ its close button) not mounted.
    expect(hamburger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('layout.closeMenu')).toBeNull()

    fireEvent.click(hamburger)

    // Open: toggle flips and the Drawer content (its close button) is now mounted.
    expect(hamburger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('layout.closeMenu')).toBeTruthy()
  })
})
