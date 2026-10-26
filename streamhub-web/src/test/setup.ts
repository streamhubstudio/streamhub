/**
 * Global setup for the vitest component/DOM suite (jsdom).
 *
 * jsdom ships a partial DOM: it has no layout engine and stubs out the media +
 * observer APIs that real players (video.js, Vidstack) reach for on mount. These
 * shims let those components MOUNT without crashing so the tests can assert on
 * the rendered DOM + wiring (which src/type reached the player) rather than on
 * real playback (which only a browser can do).
 *
 * Loaded via `test.setupFiles` in vitest.config.ts.
 */
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount React trees between tests so players dispose and listeners don't leak.
afterEach(() => cleanup())

// --- matchMedia (used by prefers-reduced-motion, theme + player layouts) -----
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

// --- ResizeObserver / IntersectionObserver (Vidstack layout + lazy load) -----
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
;(globalThis as Record<string, unknown>).ResizeObserver ??= NoopObserver
;(globalThis as Record<string, unknown>).IntersectionObserver ??= NoopObserver

// --- HTMLMediaElement playback stubs (jsdom throws "Not implemented") --------
if (typeof HTMLMediaElement !== 'undefined') {
  Object.defineProperties(HTMLMediaElement.prototype, {
    play: { configurable: true, value: () => Promise.resolve() },
    pause: { configurable: true, value: () => {} },
    load: { configurable: true, value: () => {} },
    muted: { configurable: true, writable: true, value: false },
  })
}
