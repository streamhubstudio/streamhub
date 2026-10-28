/**
 * Component/DOM test — VersionBadge + the About / Build panel it opens
 * (vitest + jsdom + @testing-library).
 *
 * Locks down:
 *  - the version comes from GET /auth/config (`appVersion`), never a
 *    package.json, and renders as "v<version>" in both variants;
 *  - nothing renders against an older backend that omits the field;
 *  - clicking the badge opens the About panel, which shows the core build
 *    (commit, Go toolchain from GET /system/build) and the changelog
 *    (GET /system/changelog) newest first, with the RUNNING release open and
 *    marked and the others collapsed (toggle via aria-expanded);
 *  - markdown is rendered as text: raw HTML in the changelog never becomes
 *    DOM, and javascript: links lose their href;
 *  - a core without the build route (older than 3.2) degrades to a notice.
 *
 * `@/api` is mocked; react-i18next is stubbed to echo keys. No network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

const { config, build, changelog } = vi.hoisted(() => ({
  config: vi.fn(),
  build: vi.fn(),
  changelog: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, api: { auth: { config }, system: { build, changelog } } }
})

import { VersionBadge } from './VersionBadge'

const CHANGELOG = `# Changelog

## 3.0.0
- Go core.

## 3.1.0
### Changed
- **No Node** left. <img src=x onerror="window.__pwned=1"> [bad](javascript:alert(1)) [docs](https://streamhub.studio/docs)
`

const BUILD = {
  version: '3.1.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  buildDate: '2026-10-28T10:00:00Z',
  dirty: false,
  toolchain: { goVersion: 'go1.26.8', compiler: 'gc', goos: 'linux', goarch: 'amd64', cgo: '0', trimpath: true },
  vcs: null,
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  config.mockReset()
  build.mockReset()
  changelog.mockReset()
})

describe('VersionBadge', () => {
  it('renders the appVersion from GET /auth/config (chip + slate)', async () => {
    config.mockResolvedValue({ allowSignup: false, appVersion: '2.7.0' })
    const { unmount } = render(<VersionBadge />, { wrapper: wrapper() })
    const chip = await screen.findByTestId('version-badge')
    expect(chip.textContent).toBe('v2.7.0')
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    unmount()

    render(<VersionBadge variant="slate" />, { wrapper: wrapper() })
    const slate = await screen.findByTestId('version-badge')
    expect(slate.textContent).toContain('StreamHub')
    expect(slate.textContent).toContain('v2.7.0')
    expect(config).toHaveBeenCalled()
  })

  it('renders nothing when the backend omits appVersion (older core)', async () => {
    config.mockResolvedValue({ allowSignup: false })
    const { container } = render(<VersionBadge />, { wrapper: wrapper() })
    await waitFor(() => expect(config).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})

describe('About / Build panel', () => {
  it('opens on click with build info and the changelog, running release open', async () => {
    config.mockResolvedValue({ allowSignup: false, appVersion: '3.1.0' })
    build.mockResolvedValue(BUILD)
    changelog.mockResolvedValue({ version: '3.1.0', source: 'embedded', markdown: CHANGELOG })
    render(<VersionBadge variant="slate" />, { wrapper: wrapper() })

    // Panel data is fetched lazily — only once it's opened.
    expect(build).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId('version-badge'))

    const slate = await screen.findByTestId('about-slate')
    expect(within(slate).getByText('v3.1.0')).toBeTruthy()
    expect(await within(slate).findByText('0123456')).toBeTruthy()
    expect(await screen.findByText('1.26.8')).toBeTruthy()
    expect(screen.getByText('linux/amd64')).toBeTruthy()

    // Newest first regardless of file order; running one is expanded + marked.
    const toggles = await screen.findAllByRole('button', { expanded: true })
    expect(toggles).toHaveLength(1)
    expect(toggles[0].textContent).toContain('v3.1.0')
    expect(toggles[0].textContent).toContain('changelog.running')
    const collapsed = screen.getAllByRole('button', { expanded: false })
    expect(collapsed.map((b) => b.textContent)).toContain('v3.0.0')
    const list = screen.getByRole('list', { name: 'changelog.title' })
    const order = within(list).getAllByRole('button').map((b) => b.textContent ?? '')
    expect(order[0]).toContain('v3.1.0')
    expect(order[1]).toContain('v3.0.0')

    // Markdown → text only.
    expect(screen.getByText('No Node').tagName).toBe('STRONG')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(screen.getByText(/<img src=x onerror=/)).toBeTruthy()
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
    expect(screen.getByText(/<img src=x onerror=/).textContent).toContain('bad')
    const docs = screen.getByText('docs').closest('a')!
    expect(docs.getAttribute('href')).toBe('https://streamhub.studio/docs')
    expect(docs.getAttribute('rel')).toContain('noopener')

    // Toggling another release expands it.
    fireEvent.click(collapsed.find((b) => b.textContent === 'v3.0.0')!)
    expect(await screen.findByText('Go core.')).toBeTruthy()
  })

  it('degrades when the core has no build/changelog routes (pre-3.2)', async () => {
    config.mockResolvedValue({ allowSignup: false, appVersion: '3.1.0' })
    build.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }))
    changelog.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }))
    render(<VersionBadge />, { wrapper: wrapper() })
    fireEvent.click(await screen.findByTestId('version-badge'))

    expect(await screen.findByText('core.unavailable')).toBeTruthy()
    expect(await screen.findByText('changelog.unavailable')).toBeTruthy()
    // Still shows the version it knows from /auth/config.
    expect(within(screen.getByTestId('about-slate')).getByText('v3.1.0')).toBeTruthy()
  })
})
