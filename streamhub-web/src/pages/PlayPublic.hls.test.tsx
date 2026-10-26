/**
 * Component/DOM test — public /play page HLS fallback (vitest + jsdom).
 *
 * Passthrough (remux) channels are HLS-only (no LiveKit room), so the public
 * player probes `/hls/<app>/<room>/index.m3u8` once on mount. Locks down the
 * selection logic:
 *  (a) playlist 200 + fresh → the page defaults to <HlsPlayer access="public">
 *      (the surface where the Vidstack player provider becomes visible) and
 *      offers the WebRTC|HLS toggle;
 *  (b) the toggle really swaps players (HLS → WebRTC → HLS re-probes);
 *  (c) no playlist (404) → today's WebRTC-only behavior, no toggle;
 *  (d) playlist exists but STALE → WebRTC stays the default, HLS is offered.
 *
 * The player components and `@/api` are mocked; the probe drives a mocked
 * global fetch. No network, no LiveKit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const { liveInfo } = vi.hoisted(() => ({ liveInfo: vi.fn() }))
vi.mock('@/api', () => ({ api: { wsIngest: { liveInfo } } }))

const { livePlayerProps, hlsPlayerProps } = vi.hoisted(() => ({
  livePlayerProps: vi.fn(),
  hlsPlayerProps: vi.fn(),
}))
vi.mock('@/components/player', () => ({
  LivePlayer: (props: Record<string, unknown>) => {
    livePlayerProps(props)
    return <div data-testid="live-player" />
  },
  HlsPlayer: (props: Record<string, unknown>) => {
    hlsPlayerProps(props)
    return <div data-testid="hls-player" />
  },
  MjpegPlayer: () => <div data-testid="mjpeg-player" />,
}))

import PlayPublic from './PlayPublic'

const fetchMock = vi.fn()

function probeResponse(status: number, lastModified?: Date) {
  const headers = new Headers()
  if (lastModified) headers.set('last-modified', lastModified.toUTCString())
  return { ok: status >= 200 && status < 300, status, headers } as Response
}

function renderPlay() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/play/live/ch1']}>
        <Routes>
          <Route path="/play/:app/:room" element={<PlayPublic />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  liveInfo.mockReset().mockResolvedValue({ active: false, type: null })
  livePlayerProps.mockClear()
  hlsPlayerProps.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlayPublic — HLS fallback', () => {
  it('(a) playlist 200 + fresh → defaults to the public HlsPlayer with the toggle', async () => {
    fetchMock.mockResolvedValue(probeResponse(200, new Date()))
    renderPlay()

    // The HLS player mounts (this is where the player provider gets a chance).
    expect(await screen.findByTestId('hls-player')).toBeTruthy()
    expect(screen.queryByTestId('live-player')).toBeNull()

    const props = hlsPlayerProps.mock.calls.at(-1)![0]
    expect(props.src).toBe('/hls/live/ch1/index.m3u8')
    expect(props.access).toBe('public') // anonymous provider resolution
    expect(props.app).toBe('live')
    expect(props.room).toBe('ch1')

    // The WebRTC | HLS toggle is offered, HLS pressed.
    const hlsBtn = screen.getByRole('button', { name: 'mode.hls' })
    expect(hlsBtn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'mode.webrtc' })).toBeTruthy()

    // Exactly ONE probe — no polling loops.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/hls/live/ch1/index.m3u8')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('HEAD')
  })

  it('(b) the toggle swaps players; choosing HLS re-probes once', async () => {
    fetchMock.mockResolvedValue(probeResponse(200, new Date()))
    renderPlay()
    await screen.findByTestId('hls-player')

    fireEvent.click(screen.getByRole('button', { name: 'mode.webrtc' }))
    expect(await screen.findByTestId('live-player')).toBeTruthy()
    expect(screen.queryByTestId('hls-player')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'mode.hls' }))
    expect(await screen.findByTestId('hls-player')).toBeTruthy()
    // Initial probe + the retry triggered by the toggle.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('(c) no playlist (404) → WebRTC only, no toggle (behavior unchanged)', async () => {
    fetchMock.mockResolvedValue(probeResponse(404))
    renderPlay()

    expect(await screen.findByTestId('live-player')).toBeTruthy()
    expect(screen.queryByTestId('hls-player')).toBeNull()
    expect(screen.queryByRole('button', { name: 'mode.hls' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'mode.webrtc' })).toBeNull()
  })

  it('(d) stale playlist → WebRTC default but HLS still offered on demand', async () => {
    fetchMock.mockResolvedValue(
      probeResponse(200, new Date(Date.now() - 60 * 60_000)),
    )
    renderPlay()

    // Stale leftover playlist must not hide the sub-second player…
    expect(await screen.findByTestId('live-player')).toBeTruthy()
    // …but the viewer may still opt into HLS explicitly.
    fireEvent.click(screen.getByRole('button', { name: 'mode.hls' }))
    expect(await screen.findByTestId('hls-player')).toBeTruthy()
  })
})
