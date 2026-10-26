/**
 * Component/DOM test — public /embed page HLS fallback (vitest + jsdom).
 *
 * Same probe/selection as /play but with no chrome and no toggle: a fresh
 * public playlist → <HlsPlayer access="public"> fills the iframe (passthrough
 * channels become embeddable); a 404 keeps the WebRTC LivePlayer exactly as
 * before. `@/api`, the players and global fetch are mocked — no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const { liveInfo } = vi.hoisted(() => ({ liveInfo: vi.fn() }))
vi.mock('@/api', () => ({ api: { wsIngest: { liveInfo } } }))

const { hlsPlayerProps } = vi.hoisted(() => ({ hlsPlayerProps: vi.fn() }))
vi.mock('@/components/player', () => ({
  LivePlayer: () => <div data-testid="live-player" />,
  HlsPlayer: (props: Record<string, unknown>) => {
    hlsPlayerProps(props)
    return <div data-testid="hls-player" />
  },
  MjpegPlayer: () => <div data-testid="mjpeg-player" />,
}))

import Embed from './Embed'

const fetchMock = vi.fn()

function probeResponse(status: number, lastModified?: Date) {
  const headers = new Headers()
  if (lastModified) headers.set('last-modified', lastModified.toUTCString())
  return { ok: status >= 200 && status < 300, status, headers } as Response
}

function renderEmbed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/embed/live/ch1']}>
        <Routes>
          <Route path="/embed/:app/:room" element={<Embed />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  liveInfo.mockReset().mockResolvedValue({ active: false, type: null })
  hlsPlayerProps.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Embed — HLS fallback', () => {
  it('fresh playlist → renders the public HlsPlayer (passthrough embeddable)', async () => {
    fetchMock.mockResolvedValue(probeResponse(200, new Date()))
    renderEmbed()

    expect(await screen.findByTestId('hls-player')).toBeTruthy()
    expect(screen.queryByTestId('live-player')).toBeNull()

    const props = hlsPlayerProps.mock.calls.at(-1)![0]
    expect(props.src).toBe('/hls/live/ch1/index.m3u8')
    expect(props.access).toBe('public')
    expect(fetchMock).toHaveBeenCalledTimes(1) // one probe, no polling
  })

  it('no playlist (404) → the WebRTC LivePlayer, unchanged', async () => {
    fetchMock.mockResolvedValue(probeResponse(404))
    renderEmbed()

    expect(await screen.findByTestId('live-player')).toBeTruthy()
    expect(screen.queryByTestId('hls-player')).toBeNull()
  })
})
