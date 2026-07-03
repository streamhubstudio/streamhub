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
 */
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { LivePlayer, MjpegPlayer } from '@/components/player'
import { pickPlayerMode } from '@/lib/mjpeg'

export default function Embed() {
  const { t } = useTranslation('player')
  const { app, room } = useParams<{ app: string; room: string }>()

  const live = useQuery({
    queryKey: ['ws-live-info', app, room],
    enabled: Boolean(app && room),
    queryFn: ({ signal }) => api.wsIngest.liveInfo(app!, room!, signal),
    refetchInterval: 15_000,
    retry: false,
  })
  const mjpeg = !live.isError && pickPlayerMode(live.data) === 'mjpeg'

  if (!app || !room) {
    return (
      <div className="flex min-h-full items-center justify-center bg-navy-900 p-4 text-center text-sm text-slate-400">
        {t('invalid.desc')}
      </div>
    )
  }

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-black">
      {live.isPending ? (
        <div className="aspect-video w-full bg-black" />
      ) : mjpeg ? (
        <MjpegPlayer app={app} room={room} access="public" className="!rounded-none" />
      ) : (
        <LivePlayer
          app={app}
          room={room}
          access="public"
          addons={{ viewers: true, reactions: true }}
          className="!rounded-none"
        />
      )}
    </div>
  )
}
