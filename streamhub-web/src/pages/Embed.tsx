/**
 * Embed (/embed/:app/:room) — PUBLIC, minimal embeddable player for <iframe>.
 *
 * No chrome, no share panel, no auth: just the bare <LivePlayer access="public">
 * filling the frame, so it can be dropped into a third-party page via the iframe
 * snippet produced by the SharePanel. Uses the PUBLIC play-token endpoint.
 *
 * MJPEG mode (ESP32-WS-INGEST.md F2): when the PUBLIC live-info endpoint says
 * the room is fed by a direct WS camera (type 'ws-mjpeg'), the frame renders
 * <MjpegPlayer> (an <img> over /live/<app>/<room>/mjpeg) instead — same URL,
 * sub-second, no transcode. Errors fall back to the WebRTC player.
 *
 * HLS mode (features/rtmp-passthrough.md): passthrough (remux) channels are
 * HLS-ONLY — no LiveKit room. On mount the frame probes the public playlist
 * (`/hls/<app>/<room>/index.m3u8`, one cheap HEAD — no polling); when it exists
 * AND is fresh-ish it renders <HlsPlayer access="public"> (which resolves the
 * app's Vidstack/player provider anonymously). No playlist → WebRTC, unchanged.
 *
 * DVR mode (G5, features/dvr-clips.md): a second one-shot probe looks for the
 * rewindable window (`dvr.m3u8`, written only for apps with features.dvr /
 * hls.list_size). When it is live the frame plays it with the DVR bar (seek,
 * "Ir al vivo", wall clock) and honours `?t=` — an epoch instant or `-5m`
 * behind live (lib/dvr) — so an event can deep-link to the moment it happened.
 *
 * TOKEN SECURITY (embeddable widget, P0-3): a PRIVATE-playback app is embedded
 * with a signed capability on the URL (`?exp=&sig=`, minted by api.playTokenSign
 * — an app+room-scoped, expiring HMAC, never an sk_ token or JWT). When a `sig`
 * is present the frame VALIDATES it server-side first (GET play-token with the
 * capability — the server runs verifyPlayback); an invalid/expired token renders
 * an "unavailable" frame instead of any player. Public apps carry no token and
 * behave exactly as before. The capability is then forwarded to <LivePlayer>.
 *
 * SIGNED HLS (G2): a private app's /hls answers 403 without `?st=`. With a
 * capability on the URL the frame also fetches the HLS token (GET hls-token,
 * same gate) BEFORE probing, and both the probe and <HlsPlayer> use the
 * tokenized playlist (the core rewrites it so every segment carries `st`).
 * A `?token=` on the URL is the viewer's own credential, forwarded to the
 * app's play-auth webhook (features.play_auth).
 */
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError } from '@/api'
import { HlsPlayer, LivePlayer, MjpegPlayer } from '@/components/player'
import { pickPlayerMode } from '@/lib/mjpeg'
import { defaultPlayback, hlsPlaylistPath, probeHls, withHlsToken } from '@/lib/share'
import { dvrPlaylistPath } from '@/lib/dvr'

export default function Embed() {
  const { t } = useTranslation('player')
  const { app, room } = useParams<{ app: string; room: string }>()
  const [params] = useSearchParams()
  const exp = params.get('exp') ?? undefined
  const sig = params.get('sig') ?? undefined
  const viewerToken = params.get('token') ?? undefined
  const startAt = params.get('t')

  // Tokenized embed: validate the signed capability SERVER-SIDE before rendering
  // any player (so the token gates the whole widget, not just the WebRTC path).
  // Only runs when a `sig` is present — untokenized public embeds are unchanged.
  const gate = useQuery({
    queryKey: ['embed-gate', app, room, exp, sig],
    enabled: Boolean(app && room && sig),
    queryFn: ({ signal }) => api.playToken(app!, room!, { exp, sig, token: viewerToken, signal }),
    retry: (count, err) =>
      !(err instanceof ApiRequestError && err.status === 403) && count < 1,
    staleTime: 5 * 60_000,
  })
  const denied = Boolean(sig) && gate.isError

  const live = useQuery({
    queryKey: ['ws-live-info', app, room],
    enabled: Boolean(app && room),
    queryFn: ({ signal }) => api.wsIngest.liveInfo(app!, room!, signal),
    refetchInterval: 15_000,
    retry: false,
  })
  const mjpeg = !live.isError && pickPlayerMode(live.data) === 'mjpeg'

  // Signed HLS (G2): the ?st= of a private app, minted with the capability.
  // Without a capability nothing changes (public apps need no token).
  const hlsTok = useQuery({
    queryKey: ['hls-token', app, room, exp, sig],
    enabled: Boolean(app && room && sig),
    queryFn: ({ signal }) => api.hlsToken(app!, room!, { exp, sig, token: viewerToken, signal }),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const st = hlsTok.data?.st

  // One-shot HLS probe (playlist, tokenized when private). MJPEG keeps precedence.
  const hlsProbe = useQuery({
    queryKey: ['hls-probe', app, room, st ?? ''],
    enabled: Boolean(app && room) && (!sig || !hlsTok.isPending),
    queryFn: () => probeHls(withHlsToken(hlsPlaylistPath(app!, room!), st)),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
  // DVR window probe (G5): preferred over the plain playlist when live.
  const dvrProbe = useQuery({
    queryKey: ['hls-dvr-probe', app, room, st ?? ''],
    enabled: Boolean(app && room) && (!sig || !hlsTok.isPending),
    queryFn: () => probeHls(withHlsToken(dvrPlaylistPath(app!, room!), st)),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const dvr = !mjpeg && defaultPlayback(dvrProbe.data) === 'hls'
  const hls = !mjpeg && (dvr || defaultPlayback(hlsProbe.data) === 'hls')

  if (!app || !room) {
    return (
      <div className="flex min-h-full items-center justify-center bg-navy-900 p-4 text-center text-sm text-slate-400">
        {t('invalid.desc')}
      </div>
    )
  }

  // Invalid / expired signed embed → don't render a player at all.
  if (denied) {
    return (
      <div className="flex min-h-full items-center justify-center bg-black p-4 text-center text-sm text-slate-400">
        {t('embed.unavailable')}
      </div>
    )
  }

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-black">
      {(sig && gate.isPending) || live.isPending || hlsProbe.isPending || dvrProbe.isPending ? (
        <div className="aspect-video w-full bg-black" />
      ) : mjpeg ? (
        <MjpegPlayer app={app} room={room} access="public" className="!rounded-none" />
      ) : hls ? (
        <HlsPlayer
          src={withHlsToken(dvr ? dvrPlaylistPath(app, room) : hlsPlaylistPath(app, room), st)}
          app={app}
          room={room}
          access="public"
          dvr={dvr}
          startAt={dvr ? startAt : null}
          className="!rounded-none w-full"
        />
      ) : (
        <LivePlayer
          app={app}
          room={room}
          access="public"
          exp={exp}
          sig={sig}
          viewerToken={viewerToken}
          addons={{ viewers: true, reactions: true }}
          className="!rounded-none"
        />
      )}
    </div>
  )
}
