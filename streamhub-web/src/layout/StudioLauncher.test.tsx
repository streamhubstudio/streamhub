/**
 * Component/DOM test — StudioLauncher (vitest + jsdom + @testing-library).
 *
 * The shell's "jump to a Studio view" menu. Proves the launcher: opens, picks an
 * app (auto-selecting the first), lists that app's INSTALLED Studio apps,
 * expands one to its declared sections, and navigates to the exact deep link on
 * click — plus the "Open app" entry that navigates to the section-less root.
 *
 * react-i18next echoes keys; useNavigate + the apps API + the per-app plugin
 * catalog are mocked (no router history, no network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  }
})

const { navigateMock, catalogMock, appsListMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  catalogMock: vi.fn(),
  appsListMock: vi.fn(),
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock('@/api', () => ({ api: { apps: { list: appsListMock } } }))

vi.mock('@/plugins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins')>()
  return { ...actual, usePluginCatalog: catalogMock }
})

import { StudioLauncher } from './StudioLauncher'
import type { PluginView } from '@/plugins'

function streamflowView(): PluginView {
  return {
    id: 'streamflow',
    name: 'Streamflow',
    description: '',
    category: 'tool',
    kind: 'app',
    edge: false,
    exportable: false,
    hasFrontend: true,
    hasBackend: true,
    installed: true,
    active: true,
    config: {},
    ui: 'app-tab',
    registered: {
      id: 'streamflow',
      name: 'Streamflow',
      ui: 'app-tab',
      category: 'tool',
      description: '',
      source: './streamflow/index.tsx',
      kind: 'app',
      sections: [
        { id: 'workflows', labelKey: 'streamflow:section.workflows' },
        { id: 'editor', labelKey: 'streamflow:section.editor' },
      ],
    },
  }
}

function mockData() {
  appsListMock.mockResolvedValue([{ name: 'live', displayName: 'Live' }])
  catalogMock.mockReturnValue({
    views: [streamflowView()],
    isLoading: false,
    isFetching: false,
    backendError: null,
    refetch: vi.fn(),
  })
}

function renderLauncher() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<StudioLauncher />, { wrapper })
}

describe('StudioLauncher', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    appsListMock.mockReset()
    catalogMock.mockReset()
  })

  it('picks an app, lists its studio apps + sections, and deep-links to a section', async () => {
    mockData()
    renderLauncher()

    // Panel is closed until the trigger is clicked.
    expect(screen.queryByTestId('studio-launcher-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('studio-launcher-button'))

    // Apps resolve → the first app auto-selects → its installed studio apps show.
    expect(await screen.findByTestId('launcher-app-streamflow')).toBeTruthy()

    // Expand → sections appear; clicking one navigates to the exact deep link.
    fireEvent.click(screen.getByTestId('launcher-app-streamflow'))
    fireEvent.click(await screen.findByTestId('launcher-section-streamflow-editor'))
    expect(navigateMock).toHaveBeenCalledWith('/apps/live/studio/streamflow/editor')
  })

  it('the Open entry navigates to the section-less app root', async () => {
    mockData()
    renderLauncher()
    fireEvent.click(screen.getByTestId('studio-launcher-button'))
    fireEvent.click(await screen.findByTestId('launcher-app-streamflow'))
    fireEvent.click(await screen.findByTestId('launcher-open-streamflow'))
    expect(navigateMock).toHaveBeenCalledWith('/apps/live/studio/streamflow')
  })
})
