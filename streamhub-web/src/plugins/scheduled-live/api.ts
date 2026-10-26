/**
 * Scheduled-live agenda API client (base /api/v1/apps/:app/scheduled-live).
 *
 * Thin wrapper over the shared low-level `request` (bearer + envelope unwrap +
 * typed errors). The operator agenda calls are authenticated (config RBAC); the
 * public listing is anonymous (auth:false) so the /play + /embed players can
 * read the upcoming events without a login.
 */
import { request } from '@/api/http'
import type { ScheduledEvent } from './overlay.util.ts'

/** Body accepted by create/update (absolute startAt in unix ms, UTC). */
export interface ScheduledEventInput {
  startAt?: number
  timezone?: string
  room?: string | null
  title?: string | null
  message?: string | null
  enabled?: boolean
}

function base(app: string): string {
  return `/apps/${encodeURIComponent(app)}/scheduled-live`
}

/** GET /apps/:app/scheduled-live — the full agenda (authenticated). */
export function listEvents(app: string, signal?: AbortSignal): Promise<ScheduledEvent[]> {
  return request<ScheduledEvent[]>(base(app), { signal }).then((r) => r ?? [])
}

/**
 * GET /apps/:app/scheduled-live/public — enabled + upcoming events (no bearer),
 * optionally scoped to a room.
 */
export function listPublicEvents(
  app: string,
  room?: string,
  signal?: AbortSignal,
): Promise<ScheduledEvent[]> {
  return request<ScheduledEvent[]>(`${base(app)}/public`, {
    auth: false,
    query: { room },
    signal,
  }).then((r) => r ?? [])
}

/** POST /apps/:app/scheduled-live — schedule a new premiere. */
export function createEvent(app: string, body: ScheduledEventInput): Promise<ScheduledEvent> {
  return request<ScheduledEvent>(base(app), { method: 'POST', body })
}

/** PATCH /apps/:app/scheduled-live/:id — update a scheduled event. */
export function updateEvent(
  app: string,
  id: number,
  body: ScheduledEventInput,
): Promise<ScheduledEvent> {
  return request<ScheduledEvent>(`${base(app)}/${id}`, { method: 'PATCH', body })
}

/** DELETE /apps/:app/scheduled-live/:id — delete a scheduled event. */
export function deleteEvent(app: string, id: number): Promise<void> {
  return request<void>(`${base(app)}/${id}`, { method: 'DELETE' })
}
