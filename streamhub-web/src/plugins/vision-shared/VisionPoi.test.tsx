/**
 * Component/DOM test — POI drawing REUSE across the vision apps (owner item 34).
 *
 * counting (lines) and demography (roi) both gained tagged POIs, drawn with the
 * SAME shared PolygonEditor as occupancy/crowd zones. This guards that adding a
 * POI and saving PUTs a normalized `config.pois` for each app.
 *
 * Same harness as VisionAppTab.test: HLS + APIs mocked, i18n echoes keys, jsdom
 * has no canvas 2D context (the component tolerates it).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

vi.mock('@/components/player', () => ({
  HlsPlayer: () => <div data-testid="hls-player" />,
}))

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('@/api/http', () => ({ request: requestMock }))

// COMPOSED-GATED (vision-4 exodus): present only when apps-pull composed the
// vendored vision apps (CI always; hermetic checkouts skip).
import * as fs from 'node:fs'
const VENDOR_BASE = '../../plugins-vendor'
// Truly-dynamic path (variable template) — vite/vitest cannot statically
// resolve it, so a hermetic checkout (vendor absent) still collects the file.
const vendorImport = (id: string) =>
  import(/* @vite-ignore */ `${VENDOR_BASE}/${id}/index.tsx`)
const COMPOSED = fs.existsSync('src/plugins-vendor/occupancy/index.tsx')

import type { PluginModule } from '../types.ts'
let countingPlugin: PluginModule
let demographyPlugin: PluginModule
beforeAll(async () => {
  if (!COMPOSED) return
  countingPlugin = (await vendorImport('counting')).default
  demographyPlugin = (await vendorImport('demography')).default
})

/** Route the mocked request by URL + method; PUTs are captured. */
function wireRequest(model: string, initialConfig: unknown, putSpy: (body: unknown) => void) {
  requestMock.mockImplementation((rawPath: unknown, opts?: { method?: string; body?: unknown }) => {
    const path = String(rawPath ?? '')
    if (opts?.method === 'PUT') {
      putSpy(opts.body)
      return Promise.resolve({ config: {} })
    }
    if (path.includes('/overview')) {
      return Promise.resolve({ model, enabled: true, today: 0, assignments: 0, activeStreams: 1 })
    }
    if (path.includes('/streams/') && path.includes('/settings')) {
      return Promise.resolve({ config: initialConfig })
    }
    if (path.endsWith('/streams')) {
      return Promise.resolve([{ room: 'gate', tags: [], hasSettings: false, updatedAt: null }])
    }
    if (path.endsWith('/tags')) {
      return Promise.resolve([])
    }
    return Promise.resolve([])
  })
}

async function openEditor() {
  fireEvent.click(await screen.findByTestId('section-streams'))
  fireEvent.click(await screen.findByTestId('edit-gate'))
}

function assertNormalizedQuad(points: number[][]) {
  expect(points).toHaveLength(4)
  for (const [x, y] of points) {
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(1)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(1)
  }
}

describe.skipIf(!COMPOSED)('POI drawing reuse', () => {
  beforeEach(() => requestMock.mockReset())

  it('counting: Add POI + Save PUTs a normalized config.pois (lines still present)', async () => {
    let saved: unknown = null
    wireRequest('counting', { lines: [] }, (b) => (saved = b))
    const Tab = countingPlugin.TabComponent!
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="counting" />)

    await openEditor()
    fireEvent.click(await screen.findByTestId('vision-add-poi'))
    fireEvent.click(screen.getByTestId('vision-save'))

    await waitFor(() => expect(saved).not.toBeNull())
    const body = saved as { config: { lines: unknown[]; pois: { tag: string; points: number[][] }[] } }
    expect(body.config.pois).toHaveLength(1)
    assertNormalizedQuad(body.config.pois[0].points)
    // POI config is class-agnostic (no `detect` leaks through).
    expect((body.config.pois[0] as Record<string, unknown>).detect).toBeUndefined()
    expect(Array.isArray(body.config.lines)).toBe(true)
  })

  it('demography: Add POI + Save PUTs config.pois and keeps engine/interval', async () => {
    let saved: unknown = null
    wireRequest('demography', { engine: 'local', intervalSec: 120 }, (b) => (saved = b))
    const Tab = demographyPlugin.TabComponent!
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="demography" />)

    await openEditor()
    fireEvent.click(await screen.findByText('actions.addPoi'))
    fireEvent.click(screen.getByTestId('vision-save'))

    await waitFor(() => expect(saved).not.toBeNull())
    const body = saved as {
      config: { engine: string; intervalSec: number; pois: { points: number[][] }[]; roi?: unknown }
    }
    expect(body.config.engine).toBe('local')
    expect(body.config.pois).toHaveLength(1)
    assertNormalizedQuad(body.config.pois[0].points)
    expect(body.config.roi).toBeUndefined() // migrated to POIs, no legacy roi
  })
})
