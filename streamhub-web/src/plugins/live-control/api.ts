/**
 * Live Control API client (base /api/v1/apps/:app/plugins/live-control).
 *
 * Thin wrappers over the shared low-level `request` (bearer + envelope unwrap +
 * typed errors). The asset UPLOAD is multipart, which `request` (JSON-only) does
 * not cover, so it uses `fetch` directly with the same Bearer + envelope rules.
 */
import { API_BASE, ApiRequestError, getToken, request } from '@/api/http'

export type LiveControlState = 'live' | 'paused' | 'finished'
export type CoverMode = 'image' | 'video' | 'text'

export interface ResolvedCover {
  mode: CoverMode
  assetId: number | null
  cardTitle: string | null
  cardText: string | null
  cardColor: string
  assetUrl: string | null
}

export interface StreamControl {
  streamId: string
  room: string | null
  state: LiveControlState
  since: string | null
  cover: ResolvedCover | null
}

export interface StreamListItem {
  streamId: string
  type: string
  room: string
  status: string
  startedAt: string
  participant: string | null
  viewers?: number
  control: StreamControl
}

export interface CoverAsset {
  id: number
  kind: 'image' | 'video'
  s3Key: string
  filename: string
  contentType: string
  sizeBytes: number
  label: string | null
  createdAt: string
  url: string | null
}

export interface LiveControlSettings {
  defaultMode: CoverMode
  defaultCardTitle: string
  defaultCardText: string
  defaultCardColor: string
  muteAudioServerSide: boolean
  pollSeconds: number
  defaultPauseAssetId: number | null
  defaultFinishAssetId: number | null
}

/** Per-stream cover override sent on pause/finish (all optional). */
export interface CoverOverride {
  mode?: CoverMode
  assetId?: number
  cardTitle?: string
  cardText?: string
  cardColor?: string
}

function base(app: string): string {
  return `/apps/${encodeURIComponent(app)}/plugins/live-control`
}

export function listStreams(
  app: string,
  signal?: AbortSignal,
): Promise<{ streams: StreamListItem[]; generatedAt: string }> {
  return request(`${base(app)}/streams`, { signal }).then(
    (r) => (r as { streams: StreamListItem[]; generatedAt: string }) ?? { streams: [], generatedAt: '' },
  )
}

export function pauseStream(app: string, streamId: string, override: CoverOverride = {}): Promise<StreamControl> {
  return request(`${base(app)}/streams/${encodeURIComponent(streamId)}/pause`, {
    method: 'POST',
    body: override,
  })
}

export function resumeStream(app: string, streamId: string): Promise<StreamControl> {
  return request(`${base(app)}/streams/${encodeURIComponent(streamId)}/resume`, { method: 'POST' })
}

export function finishStream(app: string, streamId: string, override: CoverOverride = {}): Promise<StreamControl> {
  return request(`${base(app)}/streams/${encodeURIComponent(streamId)}/finish`, {
    method: 'POST',
    body: override,
  })
}

export function listAssets(app: string, signal?: AbortSignal): Promise<CoverAsset[]> {
  return request<CoverAsset[]>(`${base(app)}/assets`, { signal }).then((r) => r ?? [])
}

export function deleteAsset(app: string, id: number): Promise<void> {
  return request<void>(`${base(app)}/assets/${id}`, { method: 'DELETE' })
}

export function getSettings(app: string, signal?: AbortSignal): Promise<LiveControlSettings> {
  return request<LiveControlSettings>(`${base(app)}/settings`, { signal })
}

export function updateSettings(
  app: string,
  patch: { defaultPauseAssetId?: number | null; defaultFinishAssetId?: number | null },
): Promise<LiveControlSettings> {
  return request<LiveControlSettings>(`${base(app)}/settings`, { method: 'PUT', body: patch })
}

/**
 * Multipart upload of a cover asset. `request` only serializes JSON, so this
 * posts a FormData with the same Bearer + envelope handling by hand.
 */
export async function uploadAsset(app: string, file: File, label?: string): Promise<CoverAsset> {
  const form = new FormData()
  form.append('file', file)
  if (label && label.trim()) form.append('label', label.trim())

  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${base(app)}/assets`, {
    method: 'POST',
    headers,
    body: form,
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  if (!res.ok) {
    const body = parsed as { error?: unknown; message?: string } | undefined
    const msg =
      (body && typeof body === 'object' && (body.message || (typeof body.error === 'string' ? body.error : ''))) ||
      `HTTP ${res.status}`
    throw new ApiRequestError(String(msg), res.status, parsed)
  }
  const env = parsed as { data?: CoverAsset } | undefined
  return (env?.data ?? parsed) as CoverAsset
}
