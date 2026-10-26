/**
 * Component/DOM smoke test — StudioAppPage (vitest + jsdom + @testing-library).
 *
 * The full-page Studio App view. Locks down the composition the design requires:
 *  - the header renders the app name, the cyan "App" kind badge and the toggle;
 *  - the PRIMARY surface (the plugin's own component) renders full-bleed;
 *  - the secondary tab bar exposes Overview / Settings / Logs (+ Export when the
 *    backend reports the app exportable);
 *  - a not-installed app shows the informative empty state instead of a surface.
 *
 * The plugin read-model hooks are mocked (no network); react-i18next echoes keys
 * so assertions stay text-independent for chrome (the blurb + name are real data
 * on the mocked view).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  }
})

vi.mock('@/auth/useAuth', () => ({ useAuth: () => ({ canEdit: true }) }))

const { catalogMock, setActiveMock } = vi.hoisted(() => ({
  catalogMock: vi.fn(),
  setActiveMock: vi.fn(),
}))

vi.mock('@/plugins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins')>()
  return {
    ...actual,
    usePluginCatalog: catalogMock,
    useSetPluginActive: setActiveMock,
  }
})

import StudioAppPage from './StudioAppPage'
import type { PluginView } from '@/plugins'

function makeView(over: Partial<PluginView> = {}): PluginView {
  const Tab = () => <div data-testid="app-surface">running-surface</div>
  return {
    id: 'lpr',
    name: 'LPR App',
    description: 'Reads license plates.',
    category: 'analytics',
    version: '1.0.0',
    ui: 'app-tab',
    kind: 'app',
    exportable: true,
    needsWorker: true,
    hasFrontend: true,
    hasBackend: true,
    installed: true,
    active: true,
    config: {},
    registered: {
      id: 'lpr',
      name: 'LPR App',
      ui: 'app-tab',
      category: 'analytics',
      description: '',
      source: './lpr/index.tsx',
      kind: 'app',
      TabComponent: Tab,
    },
    ...over,
  }
}

function renderPage(initialPath = '/apps/live/studio/lpr') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="apps/:app/studio/:pluginId" element={children} />
          <Route path="apps/:app/studio/:pluginId/:section" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return render(<StudioAppPage />, { wrapper })
}

describe('StudioAppPage — full-page Studio App view', () => {
  beforeEach(() => {
    setActiveMock.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null })
  })

  it('renders the header, App badge, full-bleed surface and secondary tabs', () => {
    catalogMock.mockReturnValue({
      views: [makeView()],
      isLoading: false,
      isFetching: false,
      backendError: null,
      refetch: vi.fn(),
    })
    renderPage()

    expect(screen.getByRole('heading', { name: 'LPR App' })).toBeTruthy()
    // The kind badge (i18n key echoed).
    expect(screen.getByText('kind.app')).toBeTruthy()
    // PRIMARY surface — the plugin's own component, rendered full-bleed.
    expect(screen.getByTestId('app-surface')).toBeTruthy()
    // Secondary tabs, incl. Export (view.exportable === true).
    expect(screen.getByText('studio.tabs.overview')).toBeTruthy()
    expect(screen.getByText('studio.tabs.settings')).toBeTruthy()
    expect(screen.getByText('studio.tabs.logs')).toBeTruthy()
    expect(screen.getByText('studio.tabs.export')).toBeTruthy()
  })

  it('shows the not-installed empty state when the app is not installed', () => {
    catalogMock.mockReturnValue({
      views: [makeView({ installed: false, active: false })],
      isLoading: false,
      isFetching: false,
      backendError: null,
      refetch: vi.fn(),
    })
    renderPage()

    expect(screen.getByText('studio.notInstalled')).toBeTruthy()
    expect(screen.queryByTestId('app-surface')).toBeNull()
  })

  it('hides the Export tab when the app is not exportable', () => {
    catalogMock.mockReturnValue({
      views: [makeView({ exportable: false })],
      isLoading: false,
      isFetching: false,
      backendError: null,
      refetch: vi.fn(),
    })
    renderPage()

    expect(screen.getByText('studio.tabs.logs')).toBeTruthy()
    expect(screen.queryByText('studio.tabs.export')).toBeNull()
  })

  // A section-aware surface that echoes the section it receives via ctx, plus
  // the sections a multi-section Studio App declares.
  const SECTIONS = [
    { id: 'overview', labelKey: 'a' },
    { id: 'events', labelKey: 'b' },
  ]
  function sectionAwareView() {
    const Tab = ({ ctx }: { ctx: { section?: string } }) => (
      <div data-testid="app-surface">section:{ctx.section ?? 'none'}</div>
    )
    return makeView({
      registered: {
        id: 'lpr',
        name: 'LPR App',
        ui: 'app-tab',
        category: 'analytics',
        description: '',
        source: './lpr/index.tsx',
        kind: 'app',
        sections: SECTIONS,
        TabComponent: Tab,
      },
    })
  }

  it('binds the :section route param to the surface (deep link renders the right section)', () => {
    catalogMock.mockReturnValue({
      views: [sectionAwareView()],
      isLoading: false,
      isFetching: false,
      backendError: null,
      refetch: vi.fn(),
    })
    renderPage('/apps/live/studio/lpr/events')
    expect(screen.getByTestId('app-surface').textContent).toBe('section:events')
  })

  it('defaults to the first section when the URL has no section segment', () => {
    catalogMock.mockReturnValue({
      views: [sectionAwareView()],
      isLoading: false,
      isFetching: false,
      backendError: null,
      refetch: vi.fn(),
    })
    renderPage('/apps/live/studio/lpr')
    expect(screen.getByTestId('app-surface').textContent).toBe('section:overview')
  })

  it('redirects an unknown section to the default (no crash)', () => {
    catalogMock.mockReturnValue({
      views: [sectionAwareView()],
      isLoading: false,
      isFetching: false,
      backendError: null,
      refetch: vi.fn(),
    })
    renderPage('/apps/live/studio/lpr/bogus')
    // The <Navigate replace> lands on the default section, and the surface renders it.
    expect(screen.getByTestId('app-surface').textContent).toBe('section:overview')
  })
})
