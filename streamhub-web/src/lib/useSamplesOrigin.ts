import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { samplesIsolated, samplesOrigin } from './samplesOrigin'

/**
 * The origin sample pages are served from (GET /auth/config `samplesUrl`,
 * else this page's origin) and whether it is a separate one. Shares the
 * `auth-config` query cache with the login screen.
 */
export function useSamplesOrigin(): { origin: string; isolated: boolean } {
  const cfg = useQuery({
    queryKey: ['auth-config'],
    queryFn: ({ signal }) => api.auth.config(signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const page = typeof window !== 'undefined' ? window.location.origin : ''
  const configured = cfg.data?.samplesUrl
  return { origin: samplesOrigin(configured, page), isolated: samplesIsolated(configured, page) }
}
