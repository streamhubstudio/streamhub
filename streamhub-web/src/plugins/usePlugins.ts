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
import { mergeCatalog } from './state.ts'
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

  const query = useQuery({
    queryKey: isPublic ? [...pluginsKey(app), 'public'] : pluginsKey(app),
    queryFn: ({ signal }) =>
      isPublic
        ? pluginsApi.listPublicOverlays(app, signal)
        : pluginsApi.list(app, signal),
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
