/**
 * Unit specs for the Safari/iOS browser-compat helpers (pure).
 * Run with Node's built-in runner (see package.json "test").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isIOS,
  isSafari,
  isWebKit,
  supportsScreenShare,
  applyInlinePlayback,
  isAutoplayBlockedError,
  LEGACY_INLINE_VIDEO_ATTRS,
} from './browserCompat.ts'

// Real-world user agents (trimmed to the discriminating parts).
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadSafari:
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ masquerading as desktop macOS (touch is the only tell).
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iosFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
}

test('isIOS: iPhone/iPad UAs, incl. iPadOS desktop-mode masquerade', () => {
  assert.equal(isIOS({ userAgent: UA.iphoneSafari }), true)
  assert.equal(isIOS({ userAgent: UA.ipadSafari }), true)
  assert.equal(isIOS({ userAgent: UA.iosChrome }), true)
  assert.equal(isIOS({ userAgent: UA.iosFirefox }), true)
  // iPadOS 13+ pretends to be macOS; touch points are the discriminator.
  assert.equal(isIOS({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 }), true)
  assert.equal(isIOS({ userAgent: UA.macSafari, maxTouchPoints: 0 }), false)
  assert.equal(isIOS({ userAgent: UA.macChrome }), false)
  assert.equal(isIOS({ userAgent: UA.androidChrome }), false)
  assert.equal(isIOS(undefined), false)
  assert.equal(isIOS({}), false)
})

test('isSafari: Safari proper only — Chrome/Edge/iOS shells excluded', () => {
  assert.equal(isSafari({ userAgent: UA.macSafari }), true)
  assert.equal(isSafari({ userAgent: UA.iphoneSafari }), true)
  assert.equal(isSafari({ userAgent: UA.ipadSafari }), true)
  assert.equal(isSafari({ userAgent: UA.macChrome }), false)
  assert.equal(isSafari({ userAgent: UA.iosChrome }), false)
  assert.equal(isSafari({ userAgent: UA.iosFirefox }), false)
  assert.equal(isSafari({ userAgent: UA.androidChrome }), false)
  assert.equal(isSafari({ userAgent: UA.windowsEdge }), false)
  assert.equal(isSafari({ userAgent: UA.linuxFirefox }), false)
  assert.equal(isSafari(undefined), false)
})

test('isWebKit: Safari anywhere + every iOS browser (all WebKit)', () => {
  assert.equal(isWebKit({ userAgent: UA.macSafari }), true)
  assert.equal(isWebKit({ userAgent: UA.iosChrome }), true)
  assert.equal(isWebKit({ userAgent: UA.iosFirefox }), true)
  assert.equal(isWebKit({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 }), true)
  assert.equal(isWebKit({ userAgent: UA.macChrome }), false)
  assert.equal(isWebKit({ userAgent: UA.androidChrome }), false)
  assert.equal(isWebKit({ userAgent: UA.linuxFirefox }), false)
})

test('supportsScreenShare: only when getDisplayMedia is a function', () => {
  assert.equal(
    supportsScreenShare({ mediaDevices: { getDisplayMedia: () => {} } }),
    true,
  )
  // iOS Safari: mediaDevices exists but getDisplayMedia does not.
  assert.equal(supportsScreenShare({ mediaDevices: {} }), false)
  assert.equal(supportsScreenShare({ mediaDevices: null }), false)
  assert.equal(supportsScreenShare({}), false)
  assert.equal(supportsScreenShare(null), false)
})

test('applyInlinePlayback sets playsinline + legacy webkit-playsinline', () => {
  const calls: Array<[string, string]> = []
  applyInlinePlayback({ setAttribute: (n, v) => calls.push([n, v]) })
  assert.deepEqual(calls, [
    ['playsinline', ''],
    ['webkit-playsinline', ''],
  ])
})

test('applyInlinePlayback tolerates null / non-DOM stand-ins', () => {
  assert.doesNotThrow(() => applyInlinePlayback(null))
  assert.doesNotThrow(() => applyInlinePlayback(undefined))
  assert.doesNotThrow(() => applyInlinePlayback({} as never))
})

test('LEGACY_INLINE_VIDEO_ATTRS is a JSX-spreadable webkit-playsinline attr', () => {
  assert.deepEqual(LEGACY_INLINE_VIDEO_ATTRS, { 'webkit-playsinline': 'true' })
})

test('isAutoplayBlockedError: only NotAllowedError means "needs a gesture"', () => {
  assert.equal(isAutoplayBlockedError({ name: 'NotAllowedError' }), true)
  // Same shape a real DOMException would have.
  assert.equal(
    isAutoplayBlockedError(Object.assign(new Error('denied'), { name: 'NotAllowedError' })),
    true,
  )
  assert.equal(isAutoplayBlockedError({ name: 'AbortError' }), false)
  assert.equal(isAutoplayBlockedError({ name: 'NotSupportedError' }), false)
  assert.equal(isAutoplayBlockedError(new Error('play failed')), false)
  assert.equal(isAutoplayBlockedError(undefined), false)
  assert.equal(isAutoplayBlockedError(null), false)
  assert.equal(isAutoplayBlockedError('NotAllowedError'), false)
})
