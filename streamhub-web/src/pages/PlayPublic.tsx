/**
 * PlayPublic (/play/:app/:room) — PUBLIC, no-login low-latency WebRTC playback
 * for a single room, with the share panel.
 *
 * Unlike /player/:app/:room (authenticated, mints its own subscribe token), this
 * page is served OUTSIDE the auth guard: <LivePlayer access="public"> fetches the
 * PUBLIC play-token (GET /apps/:app/play-token/:room) so anonymous viewers can
 * watch without any bearer. Same full-screen chrome as the internal player, but
 * without the "Salir" / management links (public visitors have no dashboard).
 *
 * MJPEG mode (ESP32-WS-INGEST.md F2): before mounting the WebRTC player the
 * page asks the PUBLIC live-info endpoint whether the room is fed by a direct
 * WS camera (type 'ws-mjpeg'). If so it renders <MjpegPlayer> (an <img> over
 * /live/<app>/<room>/mjpeg — sub-second, no transcode) on the SAME URL. Any
 * error falls back to the WebRTC player, so LiveKit playback never breaks.
 *
 * HLS fallback (features/rtmp-passthrough.md): passthrough (remux) channels are
 * HLS-ONLY — no LiveKit room, so <LivePlayer> would show an empty stage. On
 * mount the page probes the public playlist (`/hls/<app>/<room>/index.m3u8`,
 * one cheap HEAD — no polling). If it exists AND is fresh-ish the page defaults
 * to <HlsPlayer access="public"> (which resolves the app's Vidstack/player
 * provider) and offers a WebRTC|HLS toggle so viewers of transcoded rooms can
 * still pick sub-second WebRTC. No playlist → WebRTC-only, unchanged.
 */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { HlsPlayer, LivePlayer, MjpegPlayer } from '@/components/player'
import { pickPlayerMode } from '@/lib/mjpeg'
import { defaultPlayback, hlsPlaylistPath, probeHls } from '@/lib/share'
import { SharePanel } from './Player/SharePanel'
import { Logo } from '@/components/Logo'

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">{children}</div>
  )
}

export default function PlayPublic() {
  const { t } = useTranslation('player')
  const { app, room } = useParams<{ app: string; room: string }>()
  const [params] = useSearchParams()
  // Signed playback capability for a private app's public link (?exp=&sig=),
  // forwarded to the WebRTC player; the server validates it (verifyPlayback).
  const exp = params.get('exp') ?? undefined
  const sig = params.get('sig') ?? undefined
  const [audioOnly, setAudioOnly] = useState(false)

  // ws-mjpeg detection (public, cheap). While the camera is live we keep
  // polling slowly so the page falls back to WebRTC when it goes away.
  const live = useQuery({
    queryKey: ['ws-live-info', app, room],
    enabled: Boolean(app && room),
    queryFn: ({ signal }) => api.wsIngest.liveInfo(app!, room!, signal),
    refetchInterval: 15_000,
    retry: false,
  })
  const mode = live.isError ? 'webrtc' : pickPlayerMode(live.data)
  const mjpeg = mode === 'mjpeg'

  // HLS probe — ONE cheap HEAD on the public playlist (no auth, no polling).
  // Passthrough channels have HLS but no LiveKit room; transcoded rooms may
  // have a live HLS egress running alongside WebRTC.
  const hlsProbe = useQuery({
    queryKey: ['hls-probe', app, room],
    enabled: Boolean(app && room),
    queryFn: () => probeHls(hlsPlaylistPath(app!, room!)),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const hlsAvailable = hlsProbe.data?.available === true
  // The viewer's explicit toggle wins; otherwise default to HLS only when the
  // playlist exists AND looks live (fresh-ish) — see lib/share.defaultPlayback.
  const [chosen, setChosen] = useState<'webrtc' | 'hls' | null>(null)
  const playback = mjpeg ? 'mjpeg' : (chosen ?? defaultPlayback(hlsProbe.data))

  function choose(kind: 'webrtc' | 'hls') {
    setChosen(kind)
    // Re-probe on toggle so a playlist that appeared after mount is seen.
    if (kind === 'hls') void hlsProbe.refetch()
  }

  if (!app || !room) {
    return (
      <Shell>
        <div className="glass max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold text-fg">{t('invalid.title')}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {t('invalid.desc')}
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Header chrome (public page, no sidebar, no management links). */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-navy-600 bg-navy-800/70 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Logo className="h-7 w-auto shrink-0" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-fg">{room}</h1>
            <p className="truncate text-xs text-slate-500">{t('header.appLabel', { app })}</p>
          </div>
        </div>
        {/* MJPEG cameras carry no audio — the toggle only applies to WebRTC. */}
        {!mjpeg && (
          <div className="flex items-center gap-2">
            {/* WebRTC | HLS — only offered when the public playlist exists. */}
            {hlsAvailable && (
              <div
                role="group"
                aria-label={t('mode.label')}
                className="inline-flex overflow-hidden rounded-lg border border-navy-600 text-xs"
              >
                <button
                  type="button"
                  aria-pressed={playback === 'webrtc'}
                  onClick={() => choose('webrtc')}
                  title={t('mode.webrtcTitle')}
                  className={[
                    'px-3 py-1 transition',
                    playback === 'webrtc'
                      ? 'bg-blue2/15 text-fg'
                      : 'text-slate-300 hover:text-fg',
                  ].join(' ')}
                >
                  {t('mode.webrtc')}
                </button>
                <button
                  type="button"
                  aria-pressed={playback === 'hls'}
                  onClick={() => choose('hls')}
                  title={t('mode.hlsTitle')}
                  className={[
                    'border-l border-navy-600 px-3 py-1 transition',
                    playback === 'hls'
                      ? 'bg-blue2/15 text-fg'
                      : 'text-slate-300 hover:text-fg',
                  ].join(' ')}
                >
                  {t('mode.hls')}
                </button>
              </div>
            )}
            {playback === 'webrtc' && (
              <button
                type="button"
                role="switch"
                aria-checked={audioOnly}
                onClick={() => setAudioOnly((v) => !v)}
                className={[
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-1 text-xs transition',
                  audioOnly
                    ? 'border-blue2/40 bg-blue2/15 text-fg'
                    : 'border-navy-600 text-slate-300 hover:text-fg',
                ].join(' ')}
                title={t('header.audioOnlyTitle')}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${audioOnly ? 'bg-sky2' : 'bg-navy-600'}`}
                />
                {t('header.audioOnly')}
              </button>
            )}
          </div>
        )}
      </header>

      {/* Stage + share. */}
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-5 p-4 sm:p-6 lg:grid-cols-[1fr_320px]">
        {live.isPending || hlsProbe.isPending ? (
          /* Don't mount a player until the mode is known (avoids a token mint
             + flicker when the room turns out to be a camera or HLS-only). */
          <div className="relative aspect-video w-full self-start overflow-hidden rounded-xl bg-black/40 ring-1 ring-white/10" />
        ) : mjpeg ? (
          <MjpegPlayer app={app} room={room} access="public" className="self-start" />
        ) : playback === 'hls' && hlsAvailable ? (
          /* HLS playback — resolves the app's player provider (Vidstack, …)
             through the PUBLIC plugins endpoint; video.js is the fallback. */
          <HlsPlayer
            src={hlsPlaylistPath(app, room)}
            app={app}
            room={room}
            access="public"
            className="self-start"
          />
        ) : (
          <LivePlayer
            app={app}
            room={room}
            access="public"
            exp={exp}
            sig={sig}
            audioOnly={audioOnly}
            audioLabel={room}
            addons={
              audioOnly
                ? { viewers: true }
                : { chat: true, reactions: true, viewers: true }
            }
            className="self-start"
          />
        )}
        <aside className="lg:max-w-[320px]">
          <SharePanel app={app} room={room} />
        </aside>
      </main>
    </div>
  )
}
