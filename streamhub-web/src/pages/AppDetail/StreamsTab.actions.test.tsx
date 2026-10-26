/**
 * Component/DOM test — StreamsTab per-row action grouping (vitest + jsdom).
 *
 * Locks the "kebab" overflow grouping: the primary play/copy actions (Share,
 * Watch, Watch HLS) stay inline, while the secondary actions (Record, Restream,
 * Tags, Studio, moderation, Stop stream) are hidden behind the ⋯ menu until it
 * is opened.
 *
 * `@/api`, `@/plugins` and the players are mocked; react-i18next echoes keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const { streamsList, getConfig } = vi.hoisted(() => ({
  streamsList: vi.fn(),
  getConfig: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    api: {
      streams: {
        list: streamsList,
        hlsStart: vi.fn(),
        hlsStop: vi.fn(),
        stop: vi.fn(),
        recordStart: vi.fn(),
        recordStop: vi.fn(),
        getTags: vi.fn().mockResolvedValue({ streamId: 'room1/obs', tags: [] }),
        setTags: vi.fn(),
      },
      apps: { getConfig },
      rooms: { kickParticipant: vi.fn(), muteParticipant: vi.fn() },
      tags: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    },
  }
})

vi.mock('@/plugins', () => ({
  usePluginCatalog: () => ({ views: [] }),
  // No active player provider → the dual-player selector stays hidden.
  usePlayerProvider: () => null,
}))

vi.mock('@/components/player', () => ({
  LivePlayer: () => <div data-testid="live-player" />,
  HlsPlayer: () => <div data-testid="hls-player" />,
  MjpegPlayer: () => <div data-testid="mjpeg-player" />,
}))

import type { Stream } from '@/api'
import { StreamsTab } from './StreamsTab'

const STREAM: Stream = {
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

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  streamsList.mockReset().mockResolvedValue([STREAM])
  getConfig.mockReset().mockResolvedValue({ features: {} })
})

describe('StreamsTab — row action grouping', () => {
  it('keeps play/copy inline and hides secondary actions behind the ⋯ menu', async () => {
    render(<StreamsTab app="live" />, { wrapper: wrapper() })

    // Primary actions render inline.
    await screen.findByRole('button', { name: 'actions.watch' })
    expect(screen.getByRole('button', { name: 'actions.watchHls' })).toBeTruthy()
    expect(screen.getByText('share.button')).toBeTruthy()

    // Secondary actions are NOT in the DOM until the menu opens.
    expect(screen.queryByRole('button', { name: 'actions.stopStream' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'actions.tags' })).toBeNull()

    // Open the kebab.
    fireEvent.click(screen.getByRole('button', { name: 'actions.more' }))

    // Now the secondary actions are revealed inside the menu.
    const menu = screen.getByRole('menu')
    expect(menu).toBeTruthy()
    expect(screen.getByRole('button', { name: 'actions.stopStream' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'actions.tags' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'actions.record' })).toBeTruthy()
  })

  it('opens the tags editor from the ⋯ menu', async () => {
    // The tags editor's own queries are not mocked here; opening the dialog is
    // enough to prove the wiring (its content loads/errs independently).
    render(<StreamsTab app="live" />, { wrapper: wrapper() })
    await screen.findByRole('button', { name: 'actions.more' })

    fireEvent.click(screen.getByRole('button', { name: 'actions.more' }))
    fireEvent.click(screen.getByRole('button', { name: 'actions.tags' }))

    await waitFor(() =>
      expect(screen.getByText('tags.modalTitle')).toBeTruthy(),
    )
  })
})
