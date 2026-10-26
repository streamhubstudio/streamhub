/**
 * Component/DOM test (c) — the REAL Vidstack player mounts, in jsdom.
 *
 * Mounts the actual <VidstackPlayer> (the component the `vidstack` provider
 * ships) for BOTH an HLS `.m3u8` source and a progressive MP4, and asserts it
 * renders a real Vidstack media surface (`[data-media-player]` + its provider)
 * without crashing. hls.js is mocked so the HLS provider wires up deterministically
 * with no network — exactly the seam the plugin funnels playback through.
 *
 * This is the layer the fast node:test suite is blind to: it proves the provider
 * is a working browser player, not just a valid manifest.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

// Deterministic, network-free hls.js. VidstackPlayer hands THIS class to the
// Vidstack HLS provider (provider.library = Hls), so the provider never reaches
// for the CDN build and never opens a socket.
vi.mock('hls.js', () => {
  const passthrough = new Proxy({}, { get: (_t, p) => String(p) })
  class MockHls {
    static isSupported() {
      return true
    }
    static Events = passthrough
    static ErrorTypes = passthrough
    static ErrorDetails = passthrough
    config = {}
    on() {}
    off() {}
    once() {}
    loadSource() {}
    attachMedia() {}
    detachMedia() {}
    startLoad() {}
    stopLoad() {}
    recoverMediaError() {}
    destroy() {}
  }
  return { default: MockHls }
})

import { VidstackPlayer } from './VidstackPlayer'

function mediaPlayerEl(container: HTMLElement) {
  return container.querySelector('[data-media-player]')
}

describe('VidstackPlayer (real Vidstack, jsdom)', () => {
  it('mounts for an HLS source without crashing', () => {
    const { container } = render(
      <VidstackPlayer src="https://cdn.example/live/stream.m3u8" type="hls" live />,
    )
    const player = mediaPlayerEl(container)
    expect(player).toBeTruthy()
    // The provider slot is present (the <video> is lazily attached).
    expect(container.querySelector('[data-media-provider]')).toBeTruthy()
  })

  it('mounts for an MP4 source without crashing', () => {
    const { container } = render(
      <VidstackPlayer
        src="https://cdn.example/vod/recording.mp4"
        type="mp4"
        poster="https://cdn.example/vod/poster.jpg"
      />,
    )
    expect(mediaPlayerEl(container)).toBeTruthy()
  })

  it('respects autoplay=false from config (no forced autoplay)', () => {
    const { container } = render(
      <VidstackPlayer
        src="https://cdn.example/vod/recording.mp4"
        type="mp4"
        autoplay
        config={{ autoplay: false }}
      />,
    )
    const player = mediaPlayerEl(container)
    expect(player).toBeTruthy()
    // Vidstack reflects autoplay intent on the host element's data attributes.
    expect(player?.hasAttribute('data-autoplay')).toBe(false)
  })
})
