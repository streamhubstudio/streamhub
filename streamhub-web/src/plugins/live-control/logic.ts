/**
 * Live Control console — PURE helpers (no React, no network) so they run under
 * `node --test`. The index.tsx shell owns the DOM + data hooks.
 */
import type {
  CoverAsset,
  CoverMode,
  LiveControlSettings,
  LiveControlState,
  StreamListItem,
} from './api.ts'

export type { CoverAsset, CoverMode, LiveControlSettings, LiveControlState, StreamListItem }

/** Which operator op is being edited before it is applied. */
export type ControlOp = 'pause' | 'finish'

/** Badge tone for a stream state (one of the shared Badge tones). */
export function stateTone(state: LiveControlState): 'green' | 'amber' | 'slate' {
  if (state === 'live') return 'green'
  if (state === 'paused') return 'amber'
  return 'slate'
}

/** Human byte size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const num = v >= 10 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
  return `${num} ${units[i]}`
}

export function isImageAsset(a: CoverAsset): boolean {
  return a.kind === 'image'
}
export function isVideoAsset(a: CoverAsset): boolean {
  return a.kind === 'video'
}

export function assetById(assets: CoverAsset[], id: number | null | undefined): CoverAsset | null {
  if (id === null || id === undefined) return null
  return assets.find((a) => a.id === id) ?? null
}

/**
 * The initial cover-editor values when the operator opens pause/finish, seeded
 * from the per-app defaults so a one-click confirm reproduces the default cover.
 */
export interface EditorState {
  mode: CoverMode
  assetId: number | null
  cardTitle: string
  cardText: string
  cardColor: string
}

export function initialEditor(op: ControlOp, settings: LiveControlSettings | null): EditorState {
  const s = settings
  return {
    mode: s?.defaultMode ?? 'text',
    assetId: (op === 'finish' ? s?.defaultFinishAssetId : s?.defaultPauseAssetId) ?? null,
    cardTitle: s?.defaultCardTitle ?? '',
    cardText: s?.defaultCardText ?? '',
    cardColor: s?.defaultCardColor ?? '#0b0b0f',
  }
}

/** Build the API override body from the editor, dropping empty/irrelevant fields. */
export function editorToOverride(e: EditorState): {
  mode: CoverMode
  assetId?: number
  cardTitle?: string
  cardText?: string
  cardColor?: string
} {
  if (e.mode === 'text') {
    return {
      mode: 'text',
      cardTitle: e.cardTitle.trim() || undefined,
      cardText: e.cardText.trim() || undefined,
      cardColor: e.cardColor.trim() || undefined,
    }
  }
  return {
    mode: e.mode,
    assetId: e.assetId ?? undefined,
  }
}

/** Assets that can back a given cover mode (image mode ⇒ images, etc). */
export function assetsForMode(assets: CoverAsset[], mode: CoverMode): CoverAsset[] {
  if (mode === 'image') return assets.filter(isImageAsset)
  if (mode === 'video') return assets.filter(isVideoAsset)
  return []
}

/** A one-line summary of a stream's current cover (for the row). */
export function coverSummary(item: StreamListItem): string {
  const c = item.control.cover
  if (!c) return ''
  if (c.mode === 'text') return c.cardTitle || 'Text card'
  return `${c.mode}${c.assetId != null ? ` #${c.assetId}` : ''}`
}
