/**
 * Plugins API client — PER-APP (base /api/v1/apps/:app/plugins).
 *
 * Plugins are installed/configured per tenant app, so every call is scoped to an
 * `app` slug. Isolated here (rather than folded into src/api/client.ts) so the
 * plugins feature owns its own surface and doesn't contend with other agents
 * editing the central client. Uses the shared low-level `request` (bearer +
 * envelope unwrap + typed errors).
 *
 * Backend contract (PluginsController, all under /apps/:app/plugins):
 *   GET    /apps/:app/plugins                → BackendPluginView[]
 *   GET    /apps/:app/plugins/:id            → BackendPluginView
 *   POST   /apps/:app/plugins/:id/install    → BackendPluginView
 *   PATCH  /apps/:app/plugins/:id            → BackendPluginView  ({ enabled?, config? })
 *   DELETE /apps/:app/plugins/:id            → { removed: true }   (uninstall)
 *   GET    /apps/:app/plugins/:id/logs       → { pluginId, workerLogs, persisted, ... }
 *
 * The backend returns a nested `{ manifest, installed, enabled, config }` shape;
 * we flatten it to the framework's `InstalledPlugin` so `mergeCatalog` (which
 * combines it with the auto-discovered frontend registry) stays unchanged.
 */
import { request } from '@/api/http'
import type {
  ConfigValues,
  InstalledPlugin,
  PluginKind,
  PluginLogEntry,
  PluginStorageDescriptor,
} from './types.ts'

export interface PluginLogQuery {
  level?: string
  limit?: number
  offset?: number
}

/**
 * Optional per-stream scope for the overlay list endpoints. When a player
 * passes its `room` (or an exact `stream` id), the backend subtracts that
 * stream's opted-OUT plugins so overlays honor the per-stream opt-out. Omitted
 * → the unmodified app-level list.
 */
export interface PluginScope {
  room?: string
  stream?: string
}

/** Serializable plugin manifest as returned inside a backend marketplace entry. */
interface BackendManifest {
  id: string
  name?: string
  description?: string
  category?: string
  version?: string
  icon?: string
  ui?: string
  needsWorker?: boolean
  /** Studio taxonomy — 'app' | 'plugin' (the manifest projects a default). */
  kind?: PluginKind
  /** Edge-capable — the worker declares `worker.edge`. */
  edge?: boolean
  /** Persistent state the app owns (informational). */
  storage?: PluginStorageDescriptor | null
  /** Whether a standalone export bundle can be produced for this extension. */
  exportable?: boolean
}

/** Backend marketplace entry (catalog manifest + this app's install state). */
interface BackendPluginView {
  manifest: BackendManifest
  installed?: boolean
  enabled?: boolean
  config?: ConfigValues
  installedAt?: string | null
  updatedAt?: string | null
}

/** Flatten the backend's nested entry into the framework's `InstalledPlugin`. */
function toInstalled(e: BackendPluginView): InstalledPlugin {
  const m = e.manifest ?? ({ id: '' } as BackendManifest)
  return {
    id: m.id,
    installed: e.installed,
    active: e.enabled,
    enabled: e.enabled,
    config: e.config,
    version: m.version,
    name: m.name,
    description: m.description,
    category: m.category,
    kind: m.kind,
    edge: m.edge,
    storage: m.storage ?? null,
    exportable: m.exportable,
    needsWorker: m.needsWorker,
  }
}

/**
 * PUBLIC (no-auth) overlay entry as returned by GET /apps/:app/plugins/public.
 * Trimmed manifest + already-sanitized config (secrets/callback URLs stripped).
 */
interface BackendPublicOverlay {
  id: string
  manifest?: {
    name?: string
    ui?: string
    icon?: string
    configSchema?: unknown
  }
  config?: ConfigValues
}

/**
 * Flatten a public overlay entry into an InstalledPlugin. The public endpoint
 * only ever returns installed+enabled overlays, so both flags are true — this
 * lets `mergeCatalog` treat it identically to an authenticated install row.
 */
function publicToInstalled(e: BackendPublicOverlay): InstalledPlugin {
  return {
    id: e.id,
    installed: true,
    active: true,
    enabled: true,
    config: e.config,
    name: e.manifest?.name,
  }
}

function base(app: string): string {
  return `/apps/${encodeURIComponent(app)}/plugins`
}

export const pluginsApi = {
  /**
   * GET /apps/:app/plugins — the app's marketplace + install state. With a
   * `scope` (a player's room/stream) the list is STREAM-AWARE: a plugin the
   * stream opted out of comes back inactive so the overlay host drops it.
   */
  async list(
    app: string,
    signal?: AbortSignal,
    scope?: PluginScope,
  ): Promise<InstalledPlugin[]> {
    const rows = await request<BackendPluginView[]>(base(app), {
      signal,
      query: { stream: scope?.stream, room: scope?.room },
    })
    return (rows ?? []).map(toInstalled)
  },

  /**
   * GET /apps/:app/plugins/public — PUBLIC (no bearer). The app's ENABLED
   * player-overlay plugins with sanitized config, for anonymous /play + /embed
   * viewers. Returned as InstalledPlugin[] so it merges with the frontend
   * registry exactly like the authenticated list (no 401 for logged-out users).
   * A `scope` (room/stream) subtracts that stream's opted-out overlays.
   */
  async listPublicOverlays(
    app: string,
    signal?: AbortSignal,
    scope?: PluginScope,
  ): Promise<InstalledPlugin[]> {
    const rows = await request<BackendPublicOverlay[]>(`${base(app)}/public`, {
      auth: false,
      signal,
      query: { stream: scope?.stream, room: scope?.room },
    })
    return (rows ?? []).map(publicToInstalled)
  },

  /** POST /apps/:app/plugins/:id/install — install (idempotent). */
  async install(app: string, id: string): Promise<InstalledPlugin> {
    const row = await request<BackendPluginView>(
      `${base(app)}/${encodeURIComponent(id)}/install`,
      { method: 'POST' },
    )
    return toInstalled(row)
  },

  /** DELETE /apps/:app/plugins/:id — uninstall + drop its config. */
  uninstall(app: string, id: string): Promise<void> {
    return request<void>(`${base(app)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },

  /** PATCH /apps/:app/plugins/:id { enabled } — enable / disable an install. */
  async setActive(
    app: string,
    id: string,
    active: boolean,
  ): Promise<InstalledPlugin> {
    const row = await request<BackendPluginView>(
      `${base(app)}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: { enabled: active } },
    )
    return toInstalled(row)
  },

  /** PATCH /apps/:app/plugins/:id { config } — persist a plugin's settings. */
  async config(
    app: string,
    id: string,
    config: ConfigValues,
  ): Promise<InstalledPlugin> {
    const row = await request<BackendPluginView>(
      `${base(app)}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: { config } },
    )
    return toInstalled(row)
  },

  /** GET /apps/:app/plugins/:id/logs — recent plugin log lines (newest first). */
  async logs(
    app: string,
    id: string,
    params: PluginLogQuery = {},
    signal?: AbortSignal,
  ): Promise<PluginLogEntry[]> {
    const raw = await request<
      | PluginLogEntry[]
      | { items?: PluginLogEntry[]; persisted?: PluginLogEntry[] }
    >(`${base(app)}/${encodeURIComponent(id)}/logs`, {
      query: { level: params.level, limit: params.limit, offset: params.offset },
      signal,
    })
    if (Array.isArray(raw)) return raw
    // Backend returns { pluginId, workerLogs, persisted, ... }; prefer persisted
    // rows, then any generic items array.
    return raw?.persisted ?? raw?.items ?? []
  },

  /** GET /apps/:app/plugins/:id/worker/status — the worker's real process state. */
  async workerStatus(
    app: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<PluginWorkerStatus> {
    return request<PluginWorkerStatus>(
      `${base(app)}/${encodeURIComponent(id)}/worker/status`,
      { signal },
    )
  },
}

/** Worker process state as the backend reports it (`WorkerState`). */
export interface PluginWorkerStatus {
  status: string // running | stopped | crashed | starting | …
  pid?: number | null
  exitCode?: number | null
  placement?: string
}

export type PluginsApi = typeof pluginsApi
