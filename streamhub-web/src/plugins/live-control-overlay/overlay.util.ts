/**
 * Live Control Overlay — PURE helpers (no React, no network) so they run under
 * `node --test`. The index.tsx shell owns the DOM + poll + data-channel.
 */

/** LiveKit data-channel topic the console pushes state changes on. */
export const LIVE_CONTROL_TOPIC = 'live-control'

export type CoverMode = 'image' | 'video' | 'text'
export type LiveControlState = 'live' | 'paused' | 'finished'

export interface PublicCover {
  mode: CoverMode
  assetId: number | null
  cardTitle: string | null
  cardText: string | null
  cardColor: string
  assetUrl: string | null
}

export interface PublicState {
  streamId: string
  room: string | null
  state: LiveControlState
  since: string | null
  cover: PublicCover | null
}

export interface OverlaySettings {
  fit: 'cover' | 'contain'
  showFinishedBadge: boolean
}

/** Resolve the overlay's display settings from its persisted config (defaults). */
export function resolveSettings(config: Record<string, unknown> | undefined): OverlaySettings {
  const fit = config?.fit === 'contain' ? 'contain' : 'cover'
  const showFinishedBadge = config?.showFinishedBadge !== false
  return { fit, showFinishedBadge }
}

/** Whether a state hides the live feed behind a cover. */
export function coverVisible(state: LiveControlState | undefined): boolean {
  return state === 'paused' || state === 'finished'
}

/** object-fit utility class for the cover media. */
export function fitClass(fit: 'cover' | 'contain'): string {
  return fit === 'contain' ? 'object-contain' : 'object-cover'
}

/** Narrow an unknown API payload into a PublicState (defensive). */
export function parsePublicState(raw: unknown): PublicState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const state: LiveControlState =
    o.state === 'paused' ? 'paused' : o.state === 'finished' ? 'finished' : 'live'
  let cover: PublicCover | null = null
  if (o.cover && typeof o.cover === 'object') {
    const c = o.cover as Record<string, unknown>
    const mode: CoverMode = c.mode === 'image' ? 'image' : c.mode === 'video' ? 'video' : 'text'
    cover = {
      mode,
      assetId: typeof c.assetId === 'number' ? c.assetId : null,
      cardTitle: typeof c.cardTitle === 'string' ? c.cardTitle : null,
      cardText: typeof c.cardText === 'string' ? c.cardText : null,
      cardColor: typeof c.cardColor === 'string' ? c.cardColor : '#0b0b0f',
      assetUrl: typeof c.assetUrl === 'string' ? c.assetUrl : null,
    }
  }
  return {
    streamId: typeof o.streamId === 'string' ? o.streamId : '',
    room: typeof o.room === 'string' ? o.room : null,
    state,
    since: typeof o.since === 'string' ? o.since : null,
    cover: coverVisible(state) ? cover : null,
  }
}

/**
 * Is a LiveKit data-channel message a live-control state push? Accepts the raw
 * Uint8Array/string payload and checks the `type` marker — the overlay reacts by
 * refetching the public state immediately (the poll stays as the fallback).
 */
export function isLiveControlPush(payload: unknown): boolean {
  try {
    const text =
      typeof payload === 'string'
        ? payload
        : payload instanceof Uint8Array
          ? new TextDecoder().decode(payload)
          : ''
    if (!text) return false
    const o = JSON.parse(text) as { type?: unknown }
    return o?.type === 'live-control'
  } catch {
    return false
  }
}
