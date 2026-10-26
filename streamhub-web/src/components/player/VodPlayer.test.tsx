/**
 * Component/DOM test — VodPlayer player-provider SWAP (vitest + jsdom).
 *
 *   (a) no active provider (or no `app`) → the built-in video.js MP4 player;
 *   (b) an active provider → its PlayerComponent renders INSTEAD and receives the
 *       right media contract ({ src, type:'mp4', live:false }), video.js unused.
 *
 * video.js + the plugin resolver are mocked so the test observes the branch, not
 * real playback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { PlayerComponentProps } from '@/plugins'

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

const providerRef = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/plugins', () => ({
  usePlayerProvider: () => providerRef.current,
  PluginSlot: () => null,
}))

import { VodPlayer } from './VodPlayer'

beforeEach(() => {
  providerRef.current = null
  videojs.mockClear()
})

describe('VodPlayer — provider swap', () => {
  it('(a) no provider → renders the built-in video.js player', () => {
    const { container } = render(
      <VodPlayer src="https://x/rec.mp4" poster="https://x/p.jpg" app="live" />,
    )
    expect(container.querySelector('[data-vjs-player]')).toBeTruthy()
    expect(videojs).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="provider-player"]')).toBeFalsy()
  })

  it('(b) active provider → renders its PlayerComponent with src + type "mp4"', () => {
    const seen: PlayerComponentProps[] = []
    const PlayerComponent = (props: PlayerComponentProps) => {
      seen.push(props)
      return <div data-testid="provider-mock" />
    }
    providerRef.current = {
      id: 'vidstack',
      config: { theme: 'auto' },
      registered: { PlayerComponent },
    }

    const { getByTestId } = render(
      <VodPlayer src="https://x/rec.mp4" poster="https://x/p.jpg" app="live" />,
    )

    expect(getByTestId('provider-mock')).toBeTruthy()
    expect(videojs).not.toHaveBeenCalled()

    expect(seen).toHaveLength(1)
    expect(seen[0].src).toBe('https://x/rec.mp4')
    expect(seen[0].type).toBe('mp4')
    expect(seen[0].live).toBe(false)
    expect(seen[0].poster).toBe('https://x/p.jpg')
  })
})
