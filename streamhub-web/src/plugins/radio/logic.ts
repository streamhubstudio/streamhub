/**
 * Pure helpers for the Radio plugin — no React/DOM so they can be unit-tested
 * with node:test (see src/plugins/radio.spec.ts). The React surface (index.tsx)
 * imports these to stay DRY with the tested behaviour.
 */
import type { ConfigValues } from '../types.ts'

export const DEFAULT_RADIO_ROOM = 'radio'

/** Resolve the effective room from plugin config, falling back to the default. */
export function resolveRoom(config: ConfigValues | undefined): string {
  const raw = config?.room
  const room = typeof raw === 'string' ? raw.trim() : ''
  return room || DEFAULT_RADIO_ROOM
}

/** The public listener URL for the audio-radio sample page of an app/room. */
export function buildListenerUrl(
  origin: string,
  app: string,
  room: string,
): string {
  const a = encodeURIComponent(app)
  const r = encodeURIComponent(room)
  return `${origin}/samples/${a}/audio-radio.html?room=${r}`
}

/** A ready-to-paste iframe embed wrapping the listener URL. */
export function buildEmbed(listenerUrl: string): string {
  return `<iframe src="${listenerUrl}" width="360" height="120" allow="autoplay" style="border:0"></iframe>`
}
