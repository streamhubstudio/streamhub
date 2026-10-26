/**
 * Component/DOM test — StreamsTab share menu + passthrough HLS view (vitest).
 *
 * Locks down:
 *  (a) the per-row "Compartir" menu copies the EXACT public strings to the
 *      clipboard: /play player URL, /embed <iframe> snippet, the public HLS
 *      playlist URL and the self-contained video.js snippet;
 *  (b) a normal live stream's "Ver (HLS)" starts a LiveKit HLS egress
 *      (api.streams.hlsStart) and opens the modal on the returned session;
 *  (c) a PASSTHROUGH row (participant 'passthrough', streamId
 *      `<room>/passthrough`) opens the HLS modal DIRECTLY against
 *      `/hls/<app>/<room>/index.m3u8` — hlsStart is NEVER called (there is no
 *      LiveKit room) and no "Detener HLS" is offered (no egress to stop);
 *      its "Ver" action also routes to HLS (a WebRTC preview would be empty).
 *
 * `@/api`, `@/plugins`, the players and the clipboard are mocked. No network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const {
  streamsList,
  hlsStart,
  hlsStop,
  stopStream,
  recordStart,
  recordStop,
  getConfig,
  kickParticipant,
  muteParticipant,
} = vi.hoisted(() => ({
  streamsList: vi.fn(),
  hlsStart: vi.fn(),
  hlsStop: vi.fn(),
  stopStream: vi.fn(),
  recordStart: vi.fn(),
  recordStop: vi.fn(),
  getConfig: vi.fn(),
  kickParticipant: vi.fn(),
  muteParticipant: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual, // keep ApiRequestError (used by ./ui errMessage)
    api: {
      streams: {
        list: streamsList,
        hlsStart,
        hlsStop,
        stop: stopStream,
        recordStart,
        recordStop,
      },
      apps: { getConfig },
      rooms: { kickParticipant, muteParticipant },
    },
  }
})

vi.mock('@/plugins', () => ({
  usePluginCatalog: () => ({ views: [] }),
  // No active player provider by default → the dual-player selector stays hidden.
  usePlayerProvider: () => null,
}))

const { hlsPlayerProps } = vi.hoisted(() => ({ hlsPlayerProps: vi.fn() }))
vi.mock('@/components/player', () => ({
  LivePlayer: () => <div data-testid="live-player" />,
  HlsPlayer: (props: Record<string, unknown>) => {
    hlsPlayerProps(props)
    return <div data-testid="hls-player" />
  },
  MjpegPlayer: () => <div data-testid="mjpeg-player" />,
}))

import type { Stream } from '@/api'
import { StreamsTab } from './StreamsTab'

const NORMAL: Stream = {
  id: 1,
  appId: 1,
  streamId: 'room1/obs',
  type: 'rtmp',
  room: 'room1',
  participant: 'obs',
  status: 'active',
  startedAt: '2026-07-09T10:00:00Z',
  endedAt: null,
  lastStatsJson: null,
}

const PASSTHROUGH: Stream = {
  id: 2,
  appId: 1,
  streamId: 'ch1/passthrough',
  type: 'rtmp',
  room: 'ch1',
  participant: 'passthrough',
  status: 'active',
  startedAt: '2026-07-09T10:05:00Z',
  endedAt: null,
  lastStatsJson: null,
}

const writeText = vi.fn()

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

async function renderTab() {
  const utils = render(<StreamsTab app="live" />, { wrapper: wrapper() })
  // Both rows loaded (one share button per row).
  await waitFor(() => expect(screen.getAllByText('share.button')).toHaveLength(2))
  return utils
}

beforeEach(() => {
  streamsList.mockReset().mockResolvedValue([NORMAL, PASSTHROUGH])
  getConfig.mockReset().mockResolvedValue({ features: {} })
  hlsStart.mockReset()
  hlsStop.mockReset()
  stopStream.mockReset()
  recordStart.mockReset()
  recordStop.mockReset()
  hlsPlayerProps.mockClear()
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

const ORIGIN = window.location.origin

describe('StreamsTab — share menu', () => {
  it('(a) copies the exact player URL / iframe / HLS URL / video.js snippet', async () => {
    await renderTab()

    // Open the share menu on the FIRST (normal, room1) row.
    fireEvent.click(screen.getAllByText('share.button')[0])
    const menu = screen.getByRole('menu')
    expect(menu).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: /share\.playerUrl/ }))
    expect(writeText).toHaveBeenLastCalledWith(`${ORIGIN}/play/live/room1`)

    fireEvent.click(screen.getByRole('menuitem', { name: /share\.iframe/ }))
    expect(writeText).toHaveBeenLastCalledWith(
      `<iframe src="${ORIGIN}/embed/live/room1" width="640" height="360" ` +
        `frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /share\.hlsUrl/ }))
    expect(writeText).toHaveBeenLastCalledWith(`${ORIGIN}/hls/live/room1/index.m3u8`)

    fireEvent.click(screen.getByRole('menuitem', { name: /share\.videojs/ }))
    const snippet = writeText.mock.calls.at(-1)![0] as string
    expect(snippet).toContain(
      `<source src="${ORIGIN}/hls/live/room1/index.m3u8" type="application/x-mpegURL" />`,
    )
    expect(snippet).toContain("videojs('streamhub-hls')")

    expect(writeText).toHaveBeenCalledTimes(4)
  })
})

describe('StreamsTab — HLS view routing', () => {
  it('(b) normal stream "Ver (HLS)" starts a LiveKit egress session', async () => {
    hlsStart.mockResolvedValue({
      playlistUrl: '/hls/live/room1/index.m3u8',
      status: 'active',
    })
    await renderTab()

    fireEvent.click(screen.getAllByRole('button', { name: 'actions.watchHls' })[0])

    await waitFor(() => expect(hlsStart).toHaveBeenCalledTimes(1))
    expect(hlsStart).toHaveBeenCalledWith('live', 'room1/obs')
    expect(await screen.findByTestId('hls-player')).toBeTruthy()
    // Egress sessions CAN be stopped (modal footer + row button).
    expect(
      screen.getAllByRole('button', { name: 'actions.stopHls' }).length,
    ).toBeGreaterThan(0)
  })

  it('(c) passthrough "Ver (HLS)" opens direct HLS — no hlsStart, no stop', async () => {
    await renderTab()

    fireEvent.click(screen.getAllByRole('button', { name: 'actions.watchHls' })[1])

    // The modal opens IMMEDIATELY on the public playlist (no egress started).
    expect(await screen.findByTestId('hls-player')).toBeTruthy()
    expect(hlsStart).not.toHaveBeenCalled()

    const props = hlsPlayerProps.mock.calls.at(-1)![0]
    expect(props.src).toBe(`${ORIGIN}/hls/live/ch1/index.m3u8`)
    // No LiveKit egress behind it → nothing to stop.
    expect(screen.queryByRole('button', { name: 'actions.stopHls' })).toBeNull()
    // The playlist URL is surfaced for copying.
    expect(screen.getByDisplayValue(`${ORIGIN}/hls/live/ch1/index.m3u8`)).toBeTruthy()
  })

  it('(c2) passthrough "Ver" also routes to HLS (no empty WebRTC room)', async () => {
    await renderTab()

    fireEvent.click(screen.getAllByRole('button', { name: 'actions.watch' })[1])

    expect(await screen.findByTestId('hls-player')).toBeTruthy()
    expect(screen.queryByTestId('live-player')).toBeNull()
    expect(hlsStart).not.toHaveBeenCalled()
  })
})
