/**
 * Component/DOM test — PluginDetail (vitest + jsdom + @testing-library).
 *
 * The in-app Studio "mini-landing + config" detail view. Locks down:
 *  - it renders the plugin name, a VERSION badge showing the manifest version,
 *    and the description;
 *  - it renders the per-plugin mini-landing (a use case from the blurb map);
 *  - it reuses the configSchema-driven config form (the schema's field shows);
 *  - the version badge tracks whatever manifest version is passed in.
 *
 * react-i18next is stubbed to echo keys (so assertions are text-independent for
 * chrome) with language 'en'; the plugin blurbs + version + description are real
 * data on the passed-in view. No network (config isn't saved).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// Partial mock: keep the real i18n exports (initReactI18next, Trans, …) intact —
// importing '@/plugins' bootstraps i18n — but echo translation keys so the
// assertions stay text-independent for chrome.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
  }
})

import { PluginDetail } from './PluginDetail'
import type { PluginView } from '@/plugins'

function makeView(over: Partial<PluginView> = {}): PluginView {
  return {
    id: 'watermark',
    name: 'Watermark',
    description: 'Overlay a text watermark on the player.',
    category: 'tool',
    version: '1.2.0',
    ui: 'player-overlay',
    configSchema: {
      fields: [
        { key: 'text', type: 'string', label: 'Watermark text', default: 'StreamHub' },
      ],
    },
    hasFrontend: true,
    hasBackend: true,
    installed: true,
    active: true,
    config: { text: 'StreamHub' },
    ...over,
  }
}

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('PluginDetail — in-app plugin landing + config', () => {
  it('renders name, version badge, description, mini-landing and the config form', () => {
    render(
      <PluginDetail
        view={makeView()}
        app="live"
        canEdit
        onToggleActive={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrapper() },
    )

    // Name (heading).
    expect(screen.getByRole('heading', { name: 'Watermark' })).toBeTruthy()
    // Version badge — the manifest version.
    expect(screen.getByText('v1.2.0')).toBeTruthy()
    // Description.
    expect(
      screen.getByText('Overlay a text watermark on the player.'),
    ).toBeTruthy()
    // Mini-landing: a use case from the bilingual blurb map.
    expect(
      screen.getByText('Branding a stream with your channel or company name.'),
    ).toBeTruthy()
    // Config form (reused): the schema field renders.
    expect(screen.getByText('Watermark text')).toBeTruthy()
  })

  it('the version badge reflects whatever manifest version is passed', () => {
    render(
      <PluginDetail view={makeView({ version: '0.1.0' })} app="live" onClose={vi.fn()} />,
      { wrapper: wrapper() },
    )
    expect(screen.getByText('v0.1.0')).toBeTruthy()
    expect(screen.queryByText('v1.2.0')).toBeNull()
  })
})
