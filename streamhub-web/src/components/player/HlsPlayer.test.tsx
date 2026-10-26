/**
 * Component/DOM test — HlsPlayer player-provider SWAP (vitest + jsdom).
 *
 * Locks down the resolver wiring that the logic-only suite can't see:
 *   (a) no active player provider  → the built-in video.js path renders;
 *   (b) an active provider (e.g. Vidstack) → its PlayerComponent renders INSTEAD,
 *       and receives the right media contract ({ src, type:'hls', live:true }),
 *       with video.js never initialised.
 *
 * video.js and the plugin resolver are mocked so the test observes the BRANCH
 * (which player mounted + what src/type it got), not real playback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { PlayerComponentProps } from '@/plugins'

// --- video.js: record init, hand back a no-op fake player -------------------
const videojs = vi.hoisted(() => vi.fn())
vi.mock('video.js', () => {
  videojs.mockImplementation(() => ({
    isDisposed: () => false,
    dispose: vi.fn(),
    src: vi.fn(),
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    poster: vi.fn(),
    on: vi.fn(),
  }))
  return { default: videojs }
})

// --- plugin framework: control the resolver, stub the overlay slot ----------
const providerRef = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/plugins', () => ({
  usePlayerProvider: () => providerRef.current,
  PluginSlot: () => null,
}))

// --- i18n: passthrough keys -------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { HlsPlayer } from './HlsPlayer'

beforeEach(() => {
  providerRef.current = null
  videojs.mockClear()
})

describe('HlsPlayer — provider swap', () => {
  it('(a) no provider → renders the built-in video.js player', () => {
    const { container } = render(<HlsPlayer src="https://x/live.m3u8" app="live" />)
    expect(container.querySelector('[data-vjs-player]')).toBeTruthy()
    expect(videojs).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="provider-player"]')).toBeFalsy()
  })

  it('(b) active provider → renders its PlayerComponent with src + type "hls"', () => {
    const seen: PlayerComponentProps[] = []
    const PlayerComponent = (props: PlayerComponentProps) => {
      seen.push(props)
      return <div data-testid="provider-mock" />
    }
    providerRef.current = {
      id: 'vidstack',
      config: { theme: 'dark' },
      registered: { PlayerComponent },
    }

    const { getByTestId, container } = render(
      <HlsPlayer src="https://x/live.m3u8" app="live" room="cam1" />,
    )

    expect(getByTestId('provider-mock')).toBeTruthy()
    expect(container.querySelector('[data-provider="vidstack"]')).toBeTruthy()
    // video.js must NOT be initialised when a provider is active.
    expect(videojs).not.toHaveBeenCalled()

    expect(seen).toHaveLength(1)
    expect(seen[0].src).toBe('https://x/live.m3u8')
    expect(seen[0].type).toBe('hls')
    expect(seen[0].live).toBe(true)
    expect(seen[0].config).toEqual({ theme: 'dark' })
  })

  it('(c) forcePlayer="builtin" → video.js even when a provider is active', () => {
    // The dual-player selector's "video.js" choice: an active provider must be
    // ignored so the operator can watch the SAME stream in the built-in player.
    providerRef.current = {
      id: 'vidstack',
      config: {},
      registered: { PlayerComponent: () => <div data-testid="provider-mock" /> },
    }

    const { container, queryByTestId } = render(
      <HlsPlayer src="https://x/live.m3u8" app="live" forcePlayer="builtin" />,
    )

    expect(container.querySelector('[data-vjs-player]')).toBeTruthy()
    expect(videojs).toHaveBeenCalledTimes(1)
    expect(queryByTestId('provider-mock')).toBeFalsy()
  })
})
