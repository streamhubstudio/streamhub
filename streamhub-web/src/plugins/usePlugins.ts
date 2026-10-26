/**
 * React-Query hooks for the plugins feature — PER-APP.
 *
 * Plugins are installed/configured per tenant app, so every hook is scoped to an
 * `app` slug. `usePluginCatalog(app)` is the single read model both the app-scoped
 * marketplace (AppDetail → Plugins tab) and the plugin-host consume: it fetches
 * the app's backend install state and merges it with the auto-discovered frontend
 * registry into `PluginView[]`. The mutations (install / uninstall / enable /
 * config) invalidate the same per-app query key so every surface updates together.
 */
import { useMemo } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { pluginsApi } from './api.ts'
import { getRegisteredPlugins } from './discovery.ts'
import { mergeCatalog, pickPlayerProvider } from './state.ts'
import type { ConfigValues, InstalledPlugin, PluginView } from './types.ts'

/** Base key + per-app key. */
export const PLUGINS_KEY = ['plugins'] as const
export function pluginsKey(app: string) {
  return ['plugins', app] as const
}

/** Options for the read model. `public` uses the no-auth overlay endpoint. */
export interface PluginCatalogOptions {
  /**
   * Anonymous (public) context — e.g. the /play + /embed players with no logged
   * -in user. Reads GET /apps/:app/plugins/public (no bearer, only the enabled
   * player-overlays with sanitized config) instead of the authenticated list, so
   * overlays render for anonymous viewers WITHOUT a 401.
   */
  public?: boolean
  /**
   * Player scope — the room (or exact stream id) the overlays render over. When
   * set, the backend subtracts that stream's opted-OUT plugins so per-stream
   * opt-out is honored. Omitted → the unmodified app-level catalog (marketplace).
   */
  room?: string
  stream?: string
}

/**
 * Fetch an app's install state and merge with the frontend registry.
 *
 * The backend list is scoped to `app`; with no `app` the query stays idle and we
 * fall back to the registry-only catalog (everything shows as not-installed) so a
 * read-only surface can still render. A failed list surfaces via `backendError`
 * for a non-blocking banner — but inside an app context that should not happen.
 *
 * In a PUBLIC context (`opts.public`) the query hits the no-auth overlay endpoint
 * (keyed separately so it never shares cache with the authenticated list).
 */
export function usePluginCatalog(
  app: string,
  opts: PluginCatalogOptions = {},
): {
  views: PluginView[]
  isLoading: boolean
  isFetching: boolean
  backendError: unknown
  refetch: UseQueryResult<InstalledPlugin[]>['refetch']
} {
  const registered = useMemo(() => getRegisteredPlugins(), [])
  const isPublic = opts.public === true
  const scope =
    opts.stream || opts.room
      ? { stream: opts.stream, room: opts.room }
      : undefined

  // A stream/room scope makes the list stream-aware, so it must NOT share the
  // cache key with the unscoped marketplace list (which stays app-level).
  const scopeKey = scope ? ['scope', opts.stream ?? '', opts.room ?? ''] : []

  const query = useQuery({
    queryKey: isPublic
      ? [...pluginsKey(app), 'public', ...scopeKey]
      : [...pluginsKey(app), ...scopeKey],
    queryFn: ({ signal }) =>
      isPublic
        ? pluginsApi.listPublicOverlays(app, signal, scope)
        : pluginsApi.list(app, signal, scope),
    enabled: Boolean(app),
    retry: false,
  })

  // Memoize on the stable react-query data ref (not a freshly-spread array) so
  // the merge doesn't rerun every render while `data` is undefined.
  const views = useMemo(
    () => mergeCatalog(registered, query.data ?? []),
    [registered, query.data],
  )

  return {
    views,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    backendError: query.isError ? query.error : null,
    refetch: query.refetch,
  }
}

/**
 * The app's ACTIVE media-player provider (a `player`-slot plugin), or null.
 *
 * HlsPlayer/VodPlayer call this to decide whether to render a provider's
 * `PlayerComponent` (Vidstack, …) or fall back to the built-in video.js player.
 * `opts.public` reads the no-auth endpoint so anonymous /play + /embed resolve
 * the same provider. Returns null while loading or when no provider is active,
 * which the players read as "use video.js".
 */
export function usePlayerProvider(
  app: string,
  opts: PluginCatalogOptions = {},
): PluginView | null {
  const { views } = usePluginCatalog(app, opts)
  return useMemo(() => pickPlayerProvider(views), [views])
}

/** Active (installed + enabled) plugins matching a placement (host read model). */
export function usePluginsByPlacement(
  app: string,
  placement: PluginView['ui'],
  opts: PluginCatalogOptions = {},
): PluginView[] {
  const { views } = usePluginCatalog(app, opts)
  return useMemo(
    () =>
      views.filter((v) => v.active && v.hasFrontend && v.ui === placement),
    [views, placement],
  )
}

export function useInstallPlugin(app: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => pluginsApi.install(app, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: pluginsKey(app) }),
  })
}

export function useUninstallPlugin(app: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => pluginsApi.uninstall(app, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: pluginsKey(app) }),
  })
}

export function useSetPluginActive(app: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      pluginsApi.setActive(app, id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: pluginsKey(app) }),
  })
}

export function useUpdatePluginConfig(app: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, config }: { id: string; config: ConfigValues }) =>
      pluginsApi.config(app, id, config),
    onSuccess: () => qc.invalidateQueries({ queryKey: pluginsKey(app) }),
  })
}

export function usePluginLogs(app: string, id: string, enabled = true) {
  return useQuery({
    queryKey: ['plugins', app, id, 'logs'],
    queryFn: ({ signal }) => pluginsApi.logs(app, id, { limit: 200 }, signal),
    enabled: enabled && Boolean(app) && Boolean(id),
    retry: false,
  })
}
