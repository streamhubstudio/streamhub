/**
 * Component/DOM test — all four vision Studio App modules mount and are shaped
 * as edge-capable apps.
 *
 * Each app (occupancy / counting / crowd / demography) is a thin wrapper over the
 * shared VisionAppTab; this locks that (a) every module is `kind:'app'` + edge-
 * capable + ships a TabComponent, and (b) each TabComponent mounts and renders
 * the Overview / Streams / Events nav against its OWN per-model API path.
 *
 * APIs + the HLS player are mocked; react-i18next echoes keys.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))
vi.mock('@/components/player', () => ({ HlsPlayer: () => <div data-testid="hls-player" /> }))

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/api/http', () => ({ request: requestMock }))

import type { PluginModule } from '../types.ts'

// COMPOSED-GATED (vision-4 exodus): the four vision apps live in their own
// repo and are present only when `streamhub-core apps pull` composed them into
// src/plugins-vendor/ (CI always does; a hermetic checkout skips — the same
// posture as the core registry's composed witnesses).
import * as fs from 'node:fs'
const VENDOR_BASE = '../../plugins-vendor'
// Truly-dynamic path (variable template) — vite/vitest cannot statically
// resolve it, so a hermetic checkout (vendor absent) still collects the file.
const vendorImport = (id: string) =>
  import(/* @vite-ignore */ `${VENDOR_BASE}/${id}/index.tsx`)
const COMPOSED = fs.existsSync('src/plugins-vendor/occupancy/index.tsx')

let occupancy: PluginModule, counting: PluginModule, crowd: PluginModule, demography: PluginModule
let APPS: [string, PluginModule][] = []
beforeAll(async () => {
  if (!COMPOSED) return
  occupancy = (await vendorImport('occupancy')).default
  counting = (await vendorImport('counting')).default
  crowd = (await vendorImport('crowd')).default
  demography = (await vendorImport('demography')).default
  APPS = [['occupancy', occupancy], ['counting', counting], ['crowd', crowd], ['demography', demography]]
})


beforeEach(() => {
  requestMock.mockReset()
  requestMock.mockImplementation((path: string) => {
    if (path.includes('/overview')) {
      return Promise.resolve({ model: 'x', enabled: true, today: 0, assignments: 0, activeStreams: 0 })
    }
    if (path.endsWith('/streams')) return Promise.resolve([])
    if (path.endsWith('/events')) return Promise.resolve([])
    return Promise.resolve([])
  })
})

describe.skipIf(!COMPOSED)('vision Studio App modules', () => {
  it('all four are edge-capable Studio apps with an app-tab surface', () => {
    for (const [id, mod] of APPS) {
      expect(mod.id).toBe(id)
      expect(mod.kind).toBe('app')
      expect(mod.edge).toBe(true)
      expect(mod.ui).toBe('app-tab')
      expect(mod.TabComponent).toBeTruthy()
      expect(mod.configSchema?.fields.length).toBeGreaterThan(0)
    }
  })

  it('demography ships the opt-in vision-API key field; the trackers do not', () => {
    const keys = (m: PluginModule) => (m.configSchema?.fields ?? []).map((f) => f.key)
    expect(keys(demography)).toContain('ai_api_key')
    expect(keys(demography)).toContain('engine')
    expect(keys(occupancy)).not.toContain('ai_api_key')
    expect(keys(counting)).not.toContain('ai_api_key')
  })

  it('each TabComponent mounts and renders the Overview / Streams / Events nav', async () => {
    for (const [id, mod] of APPS) {
      const Tab = mod.TabComponent!
      const { unmount } = render(<Tab ctx={{ app: 'live', config: {} }} pluginId={id} />)
      expect(await screen.findByTestId('section-overview')).toBeTruthy()
      expect(screen.getByTestId('section-streams')).toBeTruthy()
      expect(screen.getByTestId('section-events')).toBeTruthy()
      // Switch to Streams so the per-model /streams endpoint is exercised.
      fireEvent.click(screen.getByTestId('section-streams'))
      await waitFor(() =>
        expect(requestMock.mock.calls.some(([p]) => p === `/apps/live/plugins/${id}/streams`)).toBe(true),
      )
      unmount()
    }
  })
})
