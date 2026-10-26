/**
 * LPR panel API — the authenticated live-data read the app-tab polls.
 *
 * Backend: GET /apps/:app/plugins/lpr/data?room=… (PluginsController) —
 * the dashboard counterpart of the public overlay feed, returning
 * { ts, ageMs, payload } where payload is the worker's { room, ts, last,
 * recent } ring. Config writes go through the shared pluginsApi (PATCH).
 */
import { request } from '@/api/http'
import { parseLivePayload, type LprLiveView } from './util.ts'

export interface LprLiveResult extends LprLiveView {
  /** ms since the worker's last push, or null when nothing arrived yet. */
  ageMs: number | null
}

export async function fetchLprLive(
  app: string,
  room: string,
  signal?: AbortSignal,
): Promise<LprLiveResult> {
  const raw = await request<{
    ts: number | null
    ageMs: number | null
    payload: unknown
  }>(`/apps/${encodeURIComponent(app)}/plugins/lpr/data`, {
    query: { room },
    signal,
  })
  return { ...parseLivePayload(raw?.payload), ageMs: raw?.ageMs ?? null }
}
