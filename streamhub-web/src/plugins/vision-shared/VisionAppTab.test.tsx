/**
 * Component/DOM test — a vision Studio App tab (vitest + jsdom +
 * @testing-library), mounted through a real app module's default-exported
 * TabComponent (occupancy). One model per app now, served from the per-app
 * vision-apps API `/apps/:app/plugins/<model>/…`.
 *
 * Guards the draw→save flow end-to-end at the component layer:
 *   - the section nav renders (Overview / Streams / Events) and switches;
 *   - opening a room editor loads its settings, adding a zone + Save PUTs a
 *     NORMALIZED config_json (0–1 polygon points) — the payload the runtime re-pulls;
 *   - drawing a vertex on the canvas overlay (pointer down) is captured.
 *
 * The HLS player + APIs are mocked (no network, no video); react-i18next is
 * stubbed to echo keys so assertions are text-independent. jsdom has no canvas
 * 2D context or pointer capture — the component tolerates both.
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
let occupancyPlugin: PluginModule
beforeAll(async () => {
  if (!COMPOSED) return
  occupancyPlugin = (await vendorImport('occupancy')).default as PluginModule
  Tab = occupancyPlugin.TabComponent!
})

let Tab: NonNullable<PluginModule['TabComponent']>

/** Route the mocked request by URL + method (per-model endpoints). */
function wireRequest(putSpy: (body: unknown) => void) {
  requestMock.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
    if (opts?.method === 'PUT') {
      putSpy(opts.body)
      return Promise.resolve({ config: {}, resolved: {} })
    }
    if (path.includes('/overview')) {
      return Promise.resolve({
        model: 'occupancy',
        enabled: true,
        today: 0,
        assignments: 0,
        activeStreams: 1,
      })
    }
    if (path.includes('/streams/') && path.includes('/settings')) {
      return Promise.resolve({ config: { zones: [] } })
    }
    if (path.endsWith('/streams')) {
      return Promise.resolve([
        { room: 'gate', tags: ['store-a'], hasSettings: false, updatedAt: null },
      ])
    }
    if (path.endsWith('/tags')) {
      return Promise.resolve([{ slug: 'store-a', label: 'Store A' }])
    }
    return Promise.resolve([])
  })
}

describe.skipIf(!COMPOSED)('vision app tab (occupancy)', () => {
  beforeEach(() => {
    requestMock.mockReset()
  })

  it('renders the section nav', async () => {
    wireRequest(() => {})
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="occupancy" />)
    expect(await screen.findByTestId('section-overview')).toBeTruthy()
    expect(screen.getByTestId('section-streams')).toBeTruthy()
    expect(screen.getByTestId('section-events')).toBeTruthy()
  })

  it('opens a room editor, adds a zone and Saves a normalized config', async () => {
    let saved: unknown = null
    wireRequest((body) => {
      saved = body
    })
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="occupancy" />)

    // Go to Streams and open the editor for room "gate".
    fireEvent.click(await screen.findByTestId('section-streams'))
    fireEvent.click(await screen.findByTestId('edit-gate'))

    // Add a zone (default quad), then Save.
    fireEvent.click(await screen.findByText('actions.addZone'))
    fireEvent.click(screen.getByTestId('vision-save'))

    await waitFor(() => expect(saved).not.toBeNull())
    const body = saved as { config: { zones: { points: number[][] }[] } }
    expect(body.config.zones).toHaveLength(1)
    // A default quad → 4 vertices, each normalized 0–1.
    expect(body.config.zones[0].points).toHaveLength(4)
    for (const [x, y] of body.config.zones[0].points) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
  })

  it('captures a drawn vertex on the canvas overlay', async () => {
    let saved: unknown = null
    wireRequest((body) => {
      saved = body
    })
    render(<Tab ctx={{ app: 'live', config: {} }} pluginId="occupancy" />)
    fireEvent.click(await screen.findByTestId('section-streams'))
    fireEvent.click(await screen.findByTestId('edit-gate'))
    fireEvent.click(await screen.findByText('actions.addZone')) // active zone + edit mode

    const canvas = screen.getByTestId('vision-editor-canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect
    // A click at the canvas centre appends a 5th vertex to the active quad.
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 50 })
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 50 })

    fireEvent.click(screen.getByTestId('vision-save'))
    await waitFor(() => expect(saved).not.toBeNull())
    const body = saved as { config: { zones: { points: number[][] }[] } }
    expect(body.config.zones[0].points.length).toBeGreaterThanOrEqual(5)
    expect(body.config.zones[0].points).toContainEqual([0.5, 0.5])
  })
})
