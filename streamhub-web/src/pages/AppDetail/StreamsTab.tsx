/**
 * En vivo (Streams) tab — GET /apps/:app/streams (live + recent).
 *
 * Per active stream:
 *  - Ver:    opens <LivePlayer> (WebRTC) in a modal over the stream's room,
 *            with chat/reactions/viewers addons gated by the app's features.
 *  - Grabar: POST /apps/:app/streams/:id/record/start (room-composite egress),
 *            then Detener via .../record/stop. Shows a "grabando" badge.
 *  - Detener stream: DELETE /apps/:app/streams/:id (uses the public streamId).
 *  - Moderación (LiveKit server-side): Silenciar mic (POST /apps/:app/rooms/
 *    :room/participants/:identity/mute) y Expulsar (DELETE .../participants/
 *    :identity) sobre el publisher del stream.
 *  - Compartir: per-row <ShareMenu> copies the /play URL, /embed iframe, the
 *    public HLS playlist and a video.js snippet.
 *
 * Passthrough (remux) rows — participant 'passthrough' / streamId
 * `<room>/passthrough` — have NO LiveKit room (features/rtmp-passthrough.md):
 * "Ver"/"Ver (HLS)" open the HLS modal DIRECTLY against the already-existing
 * `/hls/<app>/<room>/index.m3u8` (never hlsStart, which is LiveKit egress),
 * and record/restream/moderation don't apply.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { Dialog } from '@/ui'
import type { HlsSession, RecordingHandle, Stream } from '@/api'
import { HlsPlayer, LivePlayer, MjpegPlayer } from '@/components/player'
import { usePluginCatalog, usePlayerProvider } from '@/plugins'
import { hlsPlaylistUrl, isPassthroughStream, publicEmbedUrl } from '@/lib/share'
import {
  embedSnippetFor,
  forcePlayerFor,
  playerSelector,
  type PlayerChoice,
} from '@/lib/playerSelect'
import { formatDateTime as fmtTime } from '@/lib/datetime'
import { useAppTimezone } from '@/lib/appTimezone'
import { KebabMenu } from './KebabMenu'
import { RestreamDialog } from './RestreamDialog'
import { ShareMenu } from './ShareMenu'
import { StreamPluginsEditor } from './StreamPluginsEditor'
import { StreamTagsEditor } from './StreamTagsEditor'
import {
  Badge,
  Button,
  Card,
  CopyButton,
  CopyField,
  ErrorBanner,
  Loading,
  RTable,
  RTd,
  RTh,
  RTr,
  SectionTitle,
  errMessage,
} from './ui'

export function StreamsTab({ app }: { app: string }) {
  const { t } = useTranslation(['streamsTab', 'common', 'appDetail'])
  const tz = useAppTimezone()
  const qc = useQueryClient()

  // Track recordings started in this session: streamId -> egressId.
  const [recordings, setRecordings] = useState<Record<string, string>>({})
  // Live preview modal (WebRTC).
  const [watching, setWatching] = useState<Stream | null>(null)
  // HLS sessions started in this session: streamId -> session (playlistUrl, ...).
  const [hlsSessions, setHlsSessions] = useState<Record<string, HlsSession>>({})
  // Which stream's HLS modal is open (by streamId).
  const [hlsModal, setHlsModal] = useState<string | null>(null)
  // Dual-player selector: which player the HLS modal renders (null = default).
  const [hlsChoice, setHlsChoice] = useState<PlayerChoice | null>(null)
  // Restream (multi-destination forwarding) dialog target.
  const [restreaming, setRestreaming] = useState<Stream | null>(null)
  // Per-stream plugin opt-out editor target.
  const [pluginEditing, setPluginEditing] = useState<Stream | null>(null)
  // Per-stream tag editor target.
  const [tagEditing, setTagEditing] = useState<Stream | null>(null)

  // The app's enabled stream-affecting (player-overlay) plugins — the ones a
  // stream can be opted out of. Read from the app-level catalog (no scope).
  const { views: pluginViews } = usePluginCatalog(app)
  const overlayPlugins = pluginViews
    .filter((v) => v.active && v.ui === 'player-overlay')
    .map((v) => ({ id: v.id, name: v.name }))

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['app-streams', app],
    queryFn: ({ signal }) => api.streams.list(app, signal),
    refetchInterval: 8_000,
    placeholderData: keepPreviousData,
  })

  // App features drive which player addons are offered.
  const { data: config } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })
  const features = config?.features ?? {}
  const addons = {
    chat: Boolean(features.chat),
    reactions: Boolean(features.reactions),
    viewers: Boolean(features.viewerCounter),
  }

  const stop = useMutation({
    mutationFn: (streamId: string) => api.streams.stop(app, streamId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-streams', app] }),
  })

  const recordStart = useMutation<RecordingHandle, unknown, string>({
    mutationFn: (streamId: string) => api.streams.recordStart(app, streamId),
    onSuccess: (handle, streamId) => {
      setRecordings((prev) => ({ ...prev, [streamId]: handle.egressId }))
      qc.invalidateQueries({ queryKey: ['app-streams', app] })
      qc.invalidateQueries({ queryKey: ['app-vods', app] })
    },
  })

  const recordStop = useMutation<unknown, unknown, string>({
    mutationFn: (streamId: string) => api.streams.recordStop(app, streamId),
    onSuccess: (_res, streamId) => {
      setRecordings((prev) => {
        const next = { ...prev }
        delete next[streamId]
        return next
      })
      qc.invalidateQueries({ queryKey: ['app-streams', app] })
      qc.invalidateQueries({ queryKey: ['app-vods', app] })
    },
  })

  // --- server-side moderation (rooms API) -----------------------------------

  // Publishers muted from this session: streamId -> true (drives the toggle).
  const [mutedPubs, setMutedPubs] = useState<Record<string, boolean>>({})

  const kick = useMutation<unknown, unknown, Stream>({
    mutationFn: (s: Stream) =>
      api.rooms.kickParticipant(app, s.room, s.participant as string),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-streams', app] }),
  })

  const mutePub = useMutation<unknown, unknown, { stream: Stream; muted: boolean }>({
    mutationFn: ({ stream, muted }) =>
      api.rooms.muteParticipant(app, stream.room, stream.participant as string, {
        kind: 'audio',
        muted,
      }),
    onSuccess: (_res, { stream, muted }) => {
      setMutedPubs((prev) => ({ ...prev, [stream.streamId]: muted }))
    },
  })

  /** A stream is moderatable when live with a LiveKit publisher identity. */
  function canModerate(s: Stream): boolean {
    return (
      s.status === 'active' &&
      Boolean(s.participant) &&
      s.type !== 'ws-mjpeg' &&
      // Passthrough has no LiveKit participant to mute/kick.
      !isPassthroughStream(s)
    )
  }

  // Start a live HLS egress and open the player modal with its playlist.
  const hlsStart = useMutation<HlsSession, unknown, string>({
    mutationFn: (streamId: string) => api.streams.hlsStart(app, streamId),
    onSuccess: (session, streamId) => {
      setHlsSessions((prev) => ({ ...prev, [streamId]: session }))
      setHlsModal(streamId)
    },
  })

  const hlsStop = useMutation<unknown, unknown, string>({
    mutationFn: (streamId: string) => api.streams.hlsStop(app, streamId),
    onSuccess: (_res, streamId) => {
      setHlsSessions((prev) => {
        const next = { ...prev }
        delete next[streamId]
        return next
      })
      setHlsModal((cur) => (cur === streamId ? null : cur))
    },
  })

  const streams = data ?? []

  function isRecording(s: Stream): boolean {
    return Boolean(s.recording) || s.streamId in recordings
  }

  // Open HLS: passthrough channels ALREADY publish /hls/<app>/<room>/ (no
  // LiveKit egress to start — hlsStart would fail without a room), so their
  // modal opens directly; everything else reuses/starts an egress session.
  function openHls(s: Stream): void {
    if (isPassthroughStream(s) || hlsSessions[s.streamId]) setHlsModal(s.streamId)
    else hlsStart.mutate(s.streamId)
  }

  const hlsStream = hlsModal
    ? streams.find((s) => s.streamId === hlsModal) ?? null
    : null
  // Direct (passthrough) HLS: no server session — synthesize one over the
  // public playlist so the same modal renders it. No egress → no "Detener HLS".
  const hlsDirect = Boolean(hlsStream && isPassthroughStream(hlsStream))
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const hlsSession: HlsSession | null = hlsModal
    ? hlsSessions[hlsModal] ??
      (hlsDirect && hlsStream
        ? { playlistUrl: hlsPlaylistUrl(origin, app, hlsStream.room), status: 'passthrough' }
        : null)
    : null

  // Dual-player selector (Vidstack | video.js) for the HLS modal: only offered
  // when the app has an active player PROVIDER (Vidstack); otherwise video.js is
  // the only player and the toggle is hidden. The provider is the default.
  const playerProvider = usePlayerProvider(app)
  const selector = playerSelector(Boolean(playerProvider))
  const hlsPlayerChoice =
    hlsChoice && selector.choices.includes(hlsChoice) ? hlsChoice : selector.initial
  const hlsEmbedUrl = publicEmbedUrl(origin, app, hlsStream?.room ?? '')

  return (
    <>
      <Card className="p-0">
        <div className="p-5">
          <SectionTitle
            title={t('title')}
            right={
              <Button variant="ghost" onClick={() => refetch()}>
                {isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
              </Button>
            }
          />
          {stop.isError && (
            <ErrorBanner message={errMessage(stop.error, t('error.stopStream'))} />
          )}
          {recordStart.isError && (
            <div className="mt-2">
              <ErrorBanner
                message={errMessage(recordStart.error, t('error.recordStart'))}
              />
            </div>
          )}
          {recordStop.isError && (
            <div className="mt-2">
              <ErrorBanner
                message={errMessage(recordStop.error, t('error.recordStop'))}
              />
            </div>
          )}
          {hlsStart.isError && (
            <div className="mt-2">
              <ErrorBanner message={errMessage(hlsStart.error, t('error.hlsStart'))} />
            </div>
          )}
          {hlsStop.isError && (
            <div className="mt-2">
              <ErrorBanner message={errMessage(hlsStop.error, t('error.hlsStop'))} />
            </div>
          )}
          {kick.isError && (
            <div className="mt-2">
              <ErrorBanner message={errMessage(kick.error, t('error.kick'))} />
            </div>
          )}
          {mutePub.isError && (
            <div className="mt-2">
              <ErrorBanner message={errMessage(mutePub.error, t('error.mute'))} />
            </div>
          )}
        </div>

        {isLoading ? (
          <Loading label={t('loading')} />
        ) : isError ? (
          <div className="p-5">
            <ErrorBanner message={errMessage(error, t('error.load'))} />
          </div>
        ) : streams.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-slate-500">{t('empty')}</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Link
                to={`/broadcast/${encodeURIComponent(app)}`}
                className="btn-accent inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition"
              >
                {t('emptyCta.broadcast')}
              </Link>
              <Link
                to="?tab=ingress"
                className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
              >
                {t('emptyCta.createIngress')}
              </Link>
            </div>
          </div>
        ) : (
          <RTable
            head={
              <tr>
                <RTh>{t('table.stream')}</RTh>
                <RTh>{t('table.room')}</RTh>
                <RTh>{t('table.type')}</RTh>
                <RTh>{t('table.status')}</RTh>
                <RTh>{t('table.startedAt')}</RTh>
                <RTh className="text-right">{t('table.actions')}</RTh>
              </tr>
            }
          >
            {streams.map((s: Stream) => {
              const active = s.status === 'active'
              const recording = isRecording(s)
              const startPending =
                recordStart.isPending && recordStart.variables === s.streamId
              const stopPending =
                recordStop.isPending && recordStop.variables === s.streamId
              const hlsActive = s.streamId in hlsSessions
              const hlsStartPending =
                hlsStart.isPending && hlsStart.variables === s.streamId
              const hlsStopPending =
                hlsStop.isPending && hlsStop.variables === s.streamId
              const pubMuted = Boolean(mutedPubs[s.streamId])
              const mutePubPending =
                mutePub.isPending && mutePub.variables?.stream.streamId === s.streamId
              const kickPending =
                kick.isPending && kick.variables?.streamId === s.streamId
              // HLS-only remux channel: no LiveKit room behind this row.
              const passthrough = isPassthroughStream(s)
              return (
                <RTr key={s.id}>
                  <RTd label={t('table.stream')} className="font-mono text-xs text-slate-300">
                    <span className="min-w-0 max-md:text-right">
                      {s.streamId}
                      {s.participant && (
                        <span className="mt-0.5 block font-sans text-[11px] text-slate-500">
                          {s.participant}
                        </span>
                      )}
                    </span>
                  </RTd>
                  <RTd label={t('table.room')} className="text-slate-300">
                    {s.room}
                  </RTd>
                  <RTd label={t('table.type')}>
                    <Badge tone="cyan">{s.type}</Badge>
                  </RTd>
                  <RTd label={t('table.status')}>
                    <div className="flex flex-wrap items-center gap-1.5 max-md:justify-end">
                      {active ? (
                        <Badge tone="green">{t('common:state.live')}</Badge>
                      ) : (
                        <Badge tone="slate">{t('status.finished')}</Badge>
                      )}
                      {recording && <Badge tone="red">{t('status.recording')}</Badge>}
                      {hlsActive && <Badge tone="cyan">HLS</Badge>}
                      {typeof s.viewers === 'number' && (
                        <span className="text-[11px] text-slate-500">
                          {t('viewers', { count: s.viewers })}
                        </span>
                      )}
                    </div>
                  </RTd>
                  <RTd label={t('table.startedAt')} className="text-xs text-slate-400">
                    {fmtTime(s.startedAt, tz)}
                  </RTd>
                  <RTd actions className="text-right">
                    <div className="inline-flex flex-wrap items-center justify-end gap-2 max-md:w-full">
                      {/* Primary (play / copy) actions stay inline. */}
                      <ShareMenu app={app} room={s.room} />
                      <Button
                        variant="ghost"
                        disabled={!active}
                        onClick={() => (passthrough ? openHls(s) : setWatching(s))}
                      >
                        {t('actions.watch')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!active || hlsStartPending}
                        onClick={() => openHls(s)}
                      >
                        {hlsStartPending ? t('actions.startingHls') : t('actions.watchHls')}
                      </Button>
                      {/* Everything else lives in the ⋯ overflow menu. */}
                      <KebabMenu>
                        {recording ? (
                          <Button
                            variant="danger"
                            disabled={stopPending}
                            onClick={() => recordStop.mutate(s.streamId)}
                          >
                            {stopPending ? t('actions.stopping') : t('actions.stopRecording')}
                          </Button>
                        ) : (
                          <Button
                            variant="accent"
                            disabled={!active || startPending || passthrough}
                            onClick={() => recordStart.mutate(s.streamId)}
                          >
                            {startPending ? t('actions.starting') : t('actions.record')}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          disabled={!active || passthrough}
                          onClick={() => setRestreaming(s)}
                        >
                          {t('actions.restream')}
                        </Button>
                        <Button variant="ghost" onClick={() => setTagEditing(s)}>
                          {t('actions.tags')}
                        </Button>
                        <Button variant="ghost" onClick={() => setPluginEditing(s)}>
                          {t('actions.plugins')}
                        </Button>
                        {hlsActive && (
                          <Button
                            variant="danger"
                            disabled={hlsStopPending}
                            onClick={() => hlsStop.mutate(s.streamId)}
                          >
                            {hlsStopPending ? t('actions.stopping') : t('actions.stopHls')}
                          </Button>
                        )}
                        {canModerate(s) && (
                          <Button
                            variant="ghost"
                            disabled={mutePubPending}
                            onClick={() => mutePub.mutate({ stream: s, muted: !pubMuted })}
                          >
                            {mutePubPending
                              ? t('actions.muting')
                              : pubMuted
                                ? t('actions.unmute')
                                : t('actions.mute')}
                          </Button>
                        )}
                        {canModerate(s) && (
                          <Button
                            variant="danger"
                            disabled={kickPending}
                            onClick={() => {
                              if (confirm(t('confirmKick', { id: s.participant })))
                                kick.mutate(s)
                            }}
                          >
                            {kickPending ? t('actions.kicking') : t('actions.kick')}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          disabled={!active || stop.isPending}
                          onClick={() => {
                            if (confirm(t('confirmStopStream', { id: s.streamId })))
                              stop.mutate(s.streamId)
                          }}
                        >
                          {t('actions.stopStream')}
                        </Button>
                      </KebabMenu>
                    </div>
                  </RTd>
                </RTr>
              )
            })}
          </RTable>
        )}
      </Card>

      {restreaming && (
        <RestreamDialog
          app={app}
          stream={restreaming}
          onClose={() => setRestreaming(null)}
        />
      )}

      {pluginEditing && (
        <Dialog
          isOpen
          width={520}
          closable={false}
          onClose={() => setPluginEditing(null)}
          onRequestClose={() => setPluginEditing(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h5 className="text-base font-semibold text-gray-100">
              {t('plugins.modalTitle')}
            </h5>
            <Button variant="ghost" onClick={() => setPluginEditing(null)}>
              {t('common:actions.close')}
            </Button>
          </div>
          <StreamPluginsEditor
            app={app}
            stream={pluginEditing}
            plugins={overlayPlugins}
            onClose={() => setPluginEditing(null)}
          />
        </Dialog>
      )}

      {tagEditing && (
        <Dialog
          isOpen
          width={520}
          closable={false}
          onClose={() => setTagEditing(null)}
          onRequestClose={() => setTagEditing(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h5 className="text-base font-semibold text-gray-100">
              {t('tags.modalTitle')}
            </h5>
            <Button variant="ghost" onClick={() => setTagEditing(null)}>
              {t('common:actions.close')}
            </Button>
          </div>
          <StreamTagsEditor
            app={app}
            stream={tagEditing}
            onClose={() => setTagEditing(null)}
          />
        </Dialog>
      )}

      {watching && (
        <Dialog
          isOpen
          width={900}
          closable={false}
          onClose={() => setWatching(null)}
          onRequestClose={() => setWatching(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h5 className="text-base font-semibold text-gray-100">
                {t('modal.room')} <span className="font-mono">{watching.room}</span>
              </h5>
              {isRecording(watching) && <Badge tone="red">{t('status.recording')}</Badge>}
            </div>
            <Button variant="ghost" onClick={() => setWatching(null)}>
              {t('common:actions.close')}
            </Button>
          </div>
          {watching.type === 'ws-mjpeg' ? (
            /* Direct WS camera (ESP32) — MJPEG playback, no LiveKit room. */
            <MjpegPlayer app={app} room={watching.room} />
          ) : (
            <LivePlayer app={app} room={watching.room} addons={addons} />
          )}
        </Dialog>
      )}

      {hlsModal && hlsSession && (
        <Dialog
          isOpen
          width={900}
          closable={false}
          onClose={() => setHlsModal(null)}
          onRequestClose={() => setHlsModal(null)}
        >
          <div className="max-h-[80vh] overflow-y-auto">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h5 className="text-base font-semibold text-gray-100">
                  {t('hls.liveTitle')}
                  {hlsStream && (
                    <>
                      {' · '}
                      <span className="font-mono">{hlsStream.room}</span>
                    </>
                  )}
                </h5>
                <Badge tone="cyan">HLS</Badge>
                <span className="text-[11px] text-gray-400">
                  {t('hls.latency')}
                </span>
              </div>
              <Button variant="ghost" onClick={() => setHlsModal(null)}>
                {t('common:actions.close')}
              </Button>
            </div>

            {/* Dual-player selector — only when the app has an active player
                provider (Vidstack). Lets the operator watch the SAME stream in
                the Vidstack player or the built-in video.js player; each choice
                carries its own copy-embed-code below. */}
            {selector.show && (
              <div
                role="group"
                aria-label={t('hls.playerLabel')}
                className="mb-3 inline-flex overflow-hidden rounded-lg border text-xs border-gray-600"
              >
                <button
                  type="button"
                  aria-pressed={hlsPlayerChoice === 'provider'}
                  onClick={() => setHlsChoice('provider')}
                  className={[
                    'px-3 py-1.5 transition',
                    hlsPlayerChoice === 'provider'
                      ? 'bg-primary-500 text-white'
                      : 'text-gray-300 hover:bg-gray-700',
                  ].join(' ')}
                >
                  {playerProvider?.name || t('hls.providerPlayer')}
                </button>
                <button
                  type="button"
                  aria-pressed={hlsPlayerChoice === 'builtin'}
                  onClick={() => setHlsChoice('builtin')}
                  className={[
                    'border-l px-3 py-1.5 transition border-gray-600',
                    hlsPlayerChoice === 'builtin'
                      ? 'bg-primary-500 text-white'
                      : 'text-gray-300 hover:bg-gray-700',
                  ].join(' ')}
                >
                  {t('hls.builtinPlayer')}
                </button>
              </div>
            )}

            <HlsPlayer
              // Re-mount on player switch so video.js/Vidstack init cleanly.
              key={hlsPlayerChoice}
              src={hlsSession.playlistUrl}
              app={app}
              room={hlsStream?.room}
              forcePlayer={forcePlayerFor(hlsPlayerChoice)}
            />

            <div className="mt-4 space-y-4">
              <CopyField label={t('hls.playlistUrl')} value={hlsSession.playlistUrl} />

              <div>
                <span className="mb-1.5 block text-sm font-semibold text-gray-100">
                  {t('hls.embed')}
                </span>
                <div className="flex items-start gap-2">
                  <textarea
                    readOnly
                    rows={5}
                    value={embedSnippetFor(hlsPlayerChoice, {
                      embedUrl: hlsEmbedUrl,
                      playlistUrl: hlsSession.playlistUrl,
                    })}
                    onFocus={(e) => e.currentTarget.select()}
                    className="input min-w-0 flex-1 resize-none break-all font-mono text-xs focus:ring-primary-500 focus:border-primary-500"
                  />
                  <CopyButton
                    value={embedSnippetFor(hlsPlayerChoice, {
                      embedUrl: hlsEmbedUrl,
                      playlistUrl: hlsSession.playlistUrl,
                    })}
                  />
                </div>
                <span className="mt-1 block text-[11px] text-gray-400">
                  {t(
                    hlsPlayerChoice === 'provider'
                      ? 'hls.embedHelpProvider'
                      : 'hls.embedHelp',
                  )}
                </span>
              </div>
            </div>

            {/* Direct (passthrough) HLS has no LiveKit egress to stop. */}
            {!hlsDirect && (
              <div className="mt-4 flex justify-end">
                <Button
                  variant="danger"
                  disabled={hlsStop.isPending}
                  onClick={() => hlsModal && hlsStop.mutate(hlsModal)}
                >
                  {hlsStop.isPending ? t('actions.stopping') : t('actions.stopHls')}
                </Button>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}
