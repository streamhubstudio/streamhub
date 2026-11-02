import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'

/**
 * Dashboard (authenticated) HLS token, G2 (3.4.0): an app with
 * public_playback:false serves /hls only with `?st=`. The panel mints it through
 * api.playTokenSign (stream:read), whose answer carries `hlsToken` for a private
 * app and nothing for a public one — so for public apps `st` stays undefined
 * and every URL is unchanged. `pending` lets callers hold the HLS probe until
 * the token is known. Any error resolves to "no token" (the probe then fails
 * and the caller falls back exactly as before).
 */
export function useDashboardHlsToken(
  app: string,
  room: string,
  enabled = true,
): { st: string | undefined; pending: boolean } {
  const on = enabled && Boolean(app && room)
  const q = useQuery({
    queryKey: ['dashboard-hls-token', app, room],
    enabled: on,
    // Only the HLS token is used: the playback capability itself may be short.
    queryFn: () => api.playTokenSign(app, room, { ttlSeconds: 60 }),
    staleTime: 30 * 60_000,
    retry: false,
  })
  return { st: q.data?.hlsToken, pending: on && q.isPending }
}
