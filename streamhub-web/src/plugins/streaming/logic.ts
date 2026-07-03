/**
 * Pure helpers for the Video Streaming plugin — no React/DOM (unit-tested via
 * src/plugins/streaming.spec.ts). The React surface (index.tsx) imports these so
 * validation stays identical to what's tested.
 */
import type { ConfigValues } from '../types.ts'

export const DEFAULT_STREAM_ROOM = 'studio'

/** Resolve the effective room from plugin config, falling back to the default. */
export function resolveRoom(config: ConfigValues | undefined): string {
  const raw = config?.room
  const room = typeof raw === 'string' ? raw.trim() : ''
  return room || DEFAULT_STREAM_ROOM
}

/** The pre-filled RTMP destination from config (empty string when unset). */
export function resolveRtmpUrl(config: ConfigValues | undefined): string {
  const raw = config?.defaultRtmpUrl
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Whether the tool should default to audio-only publishing. */
export function resolveAudioOnly(config: ConfigValues | undefined): boolean {
  return Boolean(config?.audioOnly)
}

/**
 * Accept rtmp:// or rtmps:// with a host AND a path (the stream key). Mirrors
 * Broadcast/usePublisher.isValidRtmpUrl but kept local + pure so it is testable
 * without pulling livekit-client into node:test.
 */
export function isRtmpValid(raw: string): boolean {
  return /^rtmps?:\/\/[^\s/]+\/.+/i.test(raw.trim())
}
