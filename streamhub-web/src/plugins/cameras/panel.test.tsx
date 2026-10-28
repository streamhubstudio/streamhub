/**
 * Component/DOM test — the Cameras tab (vitest + jsdom + @testing-library),
 * mounted through the real plugin default export.
 *
 * Guards the console contract at the component layer:
 *  - the grid renders the cameras from GET .../plugins/cameras/cameras and the
 *    online filter narrows it; active:false shows the inactive banner;
 *  - the PTZ pad: pointerdown POSTs ptz/move {dir, holdMs} at once, pointerup
 *    POSTs exactly one ptz/stop;
 *  - reboot needs the inline confirm step before POSTing /reboot.
 *
 * `@/api/http` and the player are mocked (no network, no video.js);
 * react-i18next echoes keys so assertions are text-independent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k),
    i18n: { language: 'en' },
  }),
}))

const { requestMock, blobMock } = vi.hoisted(() => ({ requestMock: vi.fn(), blobMock: vi.fn() }))
vi.mock('@/api/http', () => ({ request: requestMock, requestBlob: blobMock, saveBlob: vi.fn() }))
vi.mock('@/components/player', () => ({
  HlsPlayer: ({ src }: { src: string }) => <div data-testid="hls-player">{src}</div>,
}))

import plugin from './index.tsx'

const TabComponent = plugin.TabComponent!

const CAM = (device: string, online: boolean, extra: Record<string, unknown> = {}) => ({
  device,
  site: 'abasto',
  online,
  status: online ? 'online' : 'offline',
  fw: '0.3.0',
  caps: ['ptz', 'voice', 'sd'],
  capsKnown: true,
  thumbAt: null,
  hdUntil: null,
  room: device,
  hlsPath: `/hls/live/${device}/index.m3u8`,
  summary: { rssi: -61, streamRunning: true, streamSource: 1, sdFreeKb: 50, sdTotalKb: 100, queueBytes: 0 },
  ...extra,
})

let LIST: Record<string, unknown>

function route(path: string, opts?: { method?: string; body?: unknown }) {
  if (opts?.method === 'POST') return Promise.resolve({ id: 'cmd-12345678', status: 'pending' })
  if (path.includes('/events')) return Promise.resolve({ events: [{ id: 1, ts: '2026-10-28T14:00:00Z', level: 'info', src: 'stream', event: 'started' }] })
  const m = path.match(/\/plugins\/cameras\/cameras\/([^/?]+)$/)
  if (m) {
    const cam = (LIST.cameras as { device: string }[]).find((c) => c.device === m[1])
    return Promise.resolve({ camera: cam, history: [], commands: [{ id: 'c1', cmd: 'ptz/stop', status: 'done' }], events: [] })
  }
  if (path.endsWith('/plugins/cameras/cameras')) return Promise.resolve(LIST)
  return Promise.resolve({})
}

const posts = (suffix: string) =>
  requestMock.mock.calls.filter((c) => c[1]?.method === 'POST' && String(c[0]).endsWith(suffix))

describe('Cameras tab', () => {
  beforeEach(() => {
    LIST = {
      active: true,
      baseTopic: 'opencam',
      generatedAt: 'x',
      cameras: [CAM('stand-01', true), CAM('stand-02', false)],
    }
    requestMock.mockReset()
    requestMock.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => route(path, opts))
    blobMock.mockReset()
    blobMock.mockResolvedValue(new Blob(['x']))
  })

  const renderTab = () => render(<TabComponent ctx={{ app: 'live', config: {} }} pluginId="cameras" />)

  it('renders the camera cards and filters to online', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByTestId('camera-card-stand-01')).toBeTruthy()
      expect(screen.getByTestId('camera-card-stand-02')).toBeTruthy()
    })
    expect(requestMock).toHaveBeenCalledWith('/apps/live/plugins/cameras/cameras')
    expect(screen.queryByTestId('inactive')).toBeNull()
    fireEvent.click(screen.getByTestId('filter-online'))
    expect(screen.queryByTestId('camera-card-stand-02')).toBeNull()
  })

  it('shows the inactive banner when the console is not active', async () => {
    LIST = { ...LIST, active: false, cameras: [] }
    renderTab()
    await waitFor(() => expect(screen.getByTestId('inactive')).toBeTruthy())
  })

  it('PTZ hold: pointerdown sends ptz/move, pointerup sends one ptz/stop', async () => {
    renderTab()
    await waitFor(() => screen.getByTestId('camera-card-stand-01'))
    fireEvent.click(screen.getByTestId('camera-card-stand-01'))
    const left = await screen.findByTestId('ptz-left')
    await waitFor(() => expect((left as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('hls-player').textContent).toBe('/hls/live/stand-01/index.m3u8')

    fireEvent.pointerDown(left)
    await waitFor(() => expect(posts('/cameras/stand-01/ptz/move').length).toBe(1))
    expect(posts('/cameras/stand-01/ptz/move')[0][1]).toMatchObject({
      method: 'POST',
      body: { dir: 'left', holdMs: 500 },
    })
    expect(posts('/ptz/stop').length).toBe(0)

    fireEvent.pointerUp(left)
    fireEvent.pointerLeave(left) // a second release must not send a second stop
    await waitFor(() => expect(posts('/cameras/stand-01/ptz/stop').length).toBe(1))
    await new Promise((r) => setTimeout(r, 400)) // no repeat after release
    expect(posts('/ptz/move').length).toBe(1)
  })

  it('reboot requires the inline confirm', async () => {
    renderTab()
    await waitFor(() => screen.getByTestId('camera-card-stand-01'))
    fireEvent.click(screen.getByTestId('camera-card-stand-01'))
    fireEvent.click(await screen.findByTestId('action-reboot'))
    expect(posts('/reboot').length).toBe(0)
    fireEvent.click(screen.getByTestId('reboot-confirm'))
    await waitFor(() => expect(posts('/cameras/stand-01/reboot').length).toBe(1))
    await waitFor(() => expect(screen.getByTestId('cmd-msg')).toBeTruthy())
  })

  it('hides the PTZ pad when the camera has no ptz cap', async () => {
    LIST = { ...LIST, cameras: [CAM('stand-03', true, { caps: ['sd'] })] }
    renderTab()
    await waitFor(() => screen.getByTestId('camera-card-stand-03'))
    fireEvent.click(screen.getByTestId('camera-card-stand-03'))
    await screen.findByTestId('action-reboot')
    expect(screen.queryByTestId('ptz-left')).toBeNull()
  })
})
