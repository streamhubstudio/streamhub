/**
 * Per-app timezone context (owner item 11).
 *
 * `AppDetail` wraps its whole tab-content region in `<AppTimezoneProvider
 * app={app}>` (see `pages/AppDetail.tsx`) so every app-scoped screen — the
 * built-in tabs under `pages/AppDetail/*` AND app-scoped PLUGINS (e.g.
 * `plugins/streamflow`, which render inside the same tab region) — can call
 * `useAppTimezone()` to get the app's configured IANA timezone WITHOUT
 * individually re-fetching/prop-drilling it. Lives in `lib/` (not
 * `pages/AppDetail/`) because plugins must not import from `pages/AppDetail`
 * (see `plugins/ui.tsx`'s own doc comment on that boundary) — `lib/` is the
 * neutral, shared location both layers already import from.
 *
 * Implementation: a single `react-query` fetch of `GET /apps/:app/config`
 * under the SAME query key (`['app-config', app]`) already used by
 * `ConfigTab`/`IntegracionesTab` — react-query dedupes/caches by key, so this
 * provider does NOT add an extra network round-trip on screens that already
 * fetch that config; it's one extra (cheap, cached) fetch on screens that
 * don't.
 *
 * Empty string = server/host local time (no per-app override) — the
 * pre-existing default `formatDateTime` behaviour, so a not-yet-loaded /
 * unconfigured app renders exactly as it did before this feature existed.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'

// eslint-disable-next-line react-refresh/only-export-components
export const AppTimezoneContext = createContext<string>('')

export function AppTimezoneProvider({
  app,
  children,
}: {
  app: string
  children: ReactNode
}) {
  const { data } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
    enabled: Boolean(app),
    // Best-effort: a failed/loading fetch just means "no override yet" —
    // never blocks or breaks the screens that render under this provider.
    retry: false,
  })

  const timezone = useMemo(() => data?.timezone?.trim() || '', [data])

  return (
    <AppTimezoneContext.Provider value={timezone}>
      {children}
    </AppTimezoneContext.Provider>
  )
}

/**
 * The current app's configured IANA timezone, or `''` when the app has none
 * configured (server/host local time) — safe to call outside an
 * `<AppTimezoneProvider>` too (returns `''`, the context default), so a stray
 * import never crashes a screen that isn't app-scoped.
 *
 * Pass the result straight through as `formatDateTime(value, useAppTimezone())`.
 */
export function useAppTimezone(): string {
  return useContext(AppTimezoneContext)
}
