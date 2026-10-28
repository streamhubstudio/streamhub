/**
 * Ingress tab — create a publish endpoint (POST /apps/:app/ingress) and show
 * the copyable rtmp_url / stream_key / stream_password / player_url /
 * embed_iframe it returns.
 *
 * The listing is PAGINATED (GET /apps/:app/ingress?limit&offset&q → { data,
 * total, limit, offset }) so apps with hundreds of ingest endpoints (CCTV
 * fleets) stay usable. Each row shows name/room/status/bitrate/viewers and an
 * EYE action that opens the credentials dialog: ingest URL + stream key —
 * the key stays MASKED until explicitly revealed, with copy buttons.
 *
 * WS ingest (ESP32-WS-INGEST.md): a fourth ingest kind — "WebSocket
 * (ESP32/MJPEG)" — mints a `wsk_` key via POST /apps/:app/ws-ingest and shows
 * the copyable wss://…/ingest/ws URL (OBS-style Server + Key). Its cameras are
 * listed in a dedicated card with live state, frame.jpg thumbnail and a link
 * to the public /play page (which renders the MJPEG player).
 *
 * MPEG-TS ingest (features/mpegts-multicast.md): "MPEG-TS / UDP" is passthrough-ONLY
 * and a PULL — the server reads a udp://@GROUP:PORT multicast/unicast source and
 * remuxes it to HLS. Selecting it forces+locks passthrough ON, hides the backup
 * control (no push key), and shows structured udp fields (source + SSM sources +
 * localaddr + fifo_size). The create response carries `source_url` (not rtmp/srt).
 *
 * SRT ingest (features/rtmp-passthrough.md): "SRT (push)" is passthrough-ONLY —
 * LiveKit's ingress API has no SRT input type, so selecting it forces+locks the
 * passthrough toggle ON (the backend 400s anything else). The create response
 * carries `srt_url` (srt://host:port?streamid=<key> — the key IS the
 * credential, no user/password; UDP) instead of `rtmp_url`, plus
 * `capabilities.latencyMs` (~120 ms receive-latency budget). To PULL a remote
 * SRT source through LiveKit instead, use the "URL (pull)" kind with an
 * srt:// url (server-version dependent).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HiOutlineEye, HiOutlineEyeOff, HiOutlineExternalLink, HiOutlineTrash } from 'react-icons/hi'
import { api } from '@/api'
import type { CreateIngressRequest, Ingress, IngressInputType, WsIngestKey } from '@/api'
import { Dialog, Input, Pagination, Tooltip } from '@/ui'
import { DocsHint } from '@/components/DocsHint'
import { PassthroughLostWarning } from './passthrough'
import { formatBitrate } from '@/lib/mediaFormat'
import { isMpegtsIngress, isSrtIngress, maskSecret, splitIngestUrl } from '@/lib/ingest'
import { ingressKeyPair, ingressRole } from '@/lib/ingressBackup'
import { absoluteUrl, frameUrl, withCacheBuster, wsPublishUrl } from '@/lib/mjpeg'
import {
  Badge,
  Button,
  Card,
  CopyButton,
  CopyField,
  ErrorBanner,
  Field,
  Loading,
  RTable,
  RTd,
  RTh,
  RTr,
  SectionTitle,
  Select,
  TextInput,
  Toggle,
  errMessage,
  isServiceUnavailable,
} from './ui'

/** Ingest kinds offered by the create form: LiveKit ingress + SRT/MPEG-TS + direct WS MJPEG. */
type IngestKind = IngressInputType | 'ws-mjpeg'
const INPUT_TYPE_VALUES: IngestKind[] = ['rtmp', 'srt', 'mpegts', 'whip', 'url', 'ws-mjpeg']
const PAGE_SIZE = 20

/** Endpoint state → badge tone. */
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate' | 'cyan'> = {
  publishing: 'green',
  buffering: 'amber',
  error: 'red',
  inactive: 'slate',
  complete: 'slate',
}

/** Small debounce so typing in the search box doesn't spam the API. */
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

/** One primary/backup credential block (RTMP URL + stream key + optional password). */
function KeyBlock({
  tone,
  label,
  rtmpUrl,
  streamKey,
  password,
}: {
  tone: 'green' | 'amber'
  label: string
  rtmpUrl?: string
  streamKey?: string
  password?: string
}) {
  const { t } = useTranslation('ingressTab')
  return (
    <div className="space-y-3 rounded-md border border-navy-600 bg-navy-700/40 p-3">
      <Badge tone={tone}>{label}</Badge>
      {typeof rtmpUrl === 'string' && <CopyField label={t('details.rtmpUrl')} value={rtmpUrl} />}
      {typeof streamKey === 'string' && (
        <CopyField label={t('details.streamKey')} value={streamKey} />
      )}
      {typeof password === 'string' && (
        <CopyField label={t('details.streamPassword')} value={password} />
      )}
    </div>
  )
}

/** The static "what you lose" lines shown in the create form before submit. */
function usePassthroughLostLines() {
  const { t } = useTranslation('ingressTab')
  return [
    t('create.passthrough.lost.webrtc'),
    t('create.passthrough.lost.abr'),
    t('create.passthrough.lost.h264'),
    t('create.passthrough.lost.recording'),
    t('create.passthrough.lost.room'),
    t('create.passthrough.lost.backup'),
  ]
}

/**
 * Credentials + playback surface returned after a passthrough (remux) create.
 * Transport-aware: an RTMP create carries `rtmp_url`, an SRT create carries
 * `srt_url` instead (the key rides as `?streamid=` — the key IS the credential)
 * plus `capabilities.latencyMs` (the SRT receive-latency budget, UDP).
 */
function PassthroughIngressDetails({ ing }: { ing: Ingress }) {
  const { t } = useTranslation('ingressTab')
  const rtmp = ing.rtmp_url
  const srt = ing.srt_url
  const source = ing.source_url
  const key = ing.stream_key
  const hls = ing.hls_url
  const isSrt = isSrtIngress(ing)
  const isMpegts = isMpegtsIngress(ing)
  const latencyMs = ing.capabilities?.latencyMs
  const lost = ing.capabilities?.lost ?? []
  // MPEG-TS PULLS, so the stream key is not a push credential — hide it.
  const helpKey = isMpegts ? 'details.mpegtsHelp' : isSrt ? 'details.srtHelp' : 'details.passthroughHelp'
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center gap-2">
        <Badge tone="amber">{t('details.passthroughBadge')}</Badge>
        {isSrt && <Badge tone="cyan">{t('details.srtBadge')}</Badge>}
        {isMpegts && <Badge tone="cyan">{t('details.mpegtsBadge')}</Badge>}
        <span className="font-mono text-xs text-slate-400">{ing.ingressId}</span>
      </div>
      {typeof source === 'string' && (
        <CopyField label={t('details.sourceUrl')} value={source} />
      )}
      {typeof srt === 'string' && <CopyField label={t('details.srtUrl')} value={srt} />}
      {typeof rtmp === 'string' && <CopyField label={t('details.rtmpUrl')} value={rtmp} />}
      {!isMpegts && typeof key === 'string' && (
        <CopyField label={t('details.streamKey')} value={key} />
      )}
      {typeof hls === 'string' && (
        <CopyField label={t('details.hlsUrl')} value={hls} mono={false} />
      )}
      {typeof ing.player_url === 'string' && (
        <CopyField label={t('details.playerUrl')} value={ing.player_url} mono={false} />
      )}
      {lost.length > 0 && (
        <PassthroughLostWarning title={t('details.passthroughLostTitle')} items={lost} />
      )}
      {typeof latencyMs === 'number' && (
        <p className="text-[11px] font-medium text-amber-300">
          {t('details.srtLatency', { ms: latencyMs })}
        </p>
      )}
      <p className="text-[11px] text-gray-400">{t(helpKey)}</p>
    </div>
  )
}

/** Renders the credentials returned right after creating an ingress. */
function IngressDetails({ ing }: { ing: Ingress }) {
  const { t } = useTranslation('ingressTab')
  const pair = ingressKeyPair(ing)
  // Legacy fallback for non-RTMP ingresses (WHIP/URL): the primary key set may
  // be empty while LiveKit still reports a bare `url` (ingressKeyPair already
  // folds the stream_key/rtmp_url aliases into pair.primary).
  const bareUrl = typeof ing.url === 'string' ? ing.url : undefined
  const primaryRtmp = pair.primary.rtmpUrl ?? bareUrl
  const primaryKey = pair.primary.streamKey
  const primaryPassword = ing.requires_password ? pair.primary.password : undefined
  return (
    <div className="space-y-3 rounded-lg border border-blue2/30 bg-blue2/5 p-4">
      <div className="flex items-center gap-2">
        <Badge tone="cyan">ingress</Badge>
        <span className="font-mono text-xs text-slate-400">{ing.ingressId}</span>
        {ing.adaptive && <Badge tone="green">adaptive</Badge>}
        {pair.backup && <Badge tone="amber">{t('details.backupLabel')}</Badge>}
      </div>
      {pair.backup ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <KeyBlock
              tone="green"
              label={t('details.primaryLabel')}
              rtmpUrl={primaryRtmp}
              streamKey={primaryKey}
              password={primaryPassword}
            />
            <KeyBlock
              tone="amber"
              label={t('details.backupLabel')}
              rtmpUrl={pair.backup.rtmpUrl}
              streamKey={pair.backup.streamKey}
              password={ing.requires_password ? pair.backup.password : undefined}
            />
          </div>
          <p className="text-[11px] text-gray-400">{t('details.failoverHelp')}</p>
        </>
      ) : (
        <>
          {typeof primaryRtmp === 'string' && (
            <CopyField label={t('details.rtmpUrl')} value={primaryRtmp} />
          )}
          {typeof primaryKey === 'string' && (
            <CopyField label={t('details.streamKey')} value={primaryKey} />
          )}
          {typeof primaryPassword === 'string' && (
            <CopyField label={t('details.streamPassword')} value={primaryPassword} />
          )}
        </>
      )}
      {typeof ing.player_url === 'string' && (
        <CopyField label={t('details.playerUrl')} value={ing.player_url} mono={false} />
      )}
      {typeof ing.embed_iframe === 'string' && (
        <CopyField label={t('details.embedIframe')} value={ing.embed_iframe} />
      )}
    </div>
  )
}

/** Read-only secret: masked until the eye reveals it; copy uses the real value. */
function SecretField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation('ingressTab')
  const [revealed, setRevealed] = useState(false)
  return (
    <div>
      <span className="mb-1.5 block text-sm font-semibold text-gray-100">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          size="sm"
          value={revealed ? value : maskSecret(value)}
          onFocus={(e) => revealed && e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button
          variant="ghost"
          aria-label={revealed ? t('reveal.hide') : t('reveal.show')}
          title={revealed ? t('reveal.hide') : t('reveal.show')}
          onClick={() => setRevealed((v) => !v)}
          className="shrink-0"
        >
          {revealed ? <HiOutlineEyeOff className="text-base" /> : <HiOutlineEye className="text-base" />}
        </Button>
        <CopyButton value={value} />
      </div>
    </div>
  )
}

/** Credentials dialog for one ingress row (URL + stream key, revealable). */
function CredentialsDialog({ ing, onClose }: { ing: Ingress; onClose: () => void }) {
  const { t } = useTranslation(['ingressTab', 'common'])
  const rtmp = (ing.rtmp_url ?? ing.rtmpUrl) as string | undefined
  const key = (ing.stream_key ?? ing.streamKey) as string | undefined
  const parts = splitIngestUrl(rtmp ?? ing.url, key)
  const role = ingressRole(ing)
  // A primary row is annotated with its sibling backup key on the listing.
  const backupKey = ing.backupStreamKey ?? ing.backup_stream_key
  const backupRtmp = ing.backup_rtmp_url
  return (
    <Dialog
      isOpen
      width={640}
      closable={false}
      onClose={onClose}
      onRequestClose={onClose}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h5 className="text-base font-semibold text-gray-100">
            {t('reveal.title')}
          </h5>
          {role && (
            <Badge tone={role === 'backup' ? 'amber' : 'green'}>
              {t(`list.${role}Badge`)}
            </Badge>
          )}
          <span className="truncate font-mono text-xs text-slate-400">
            {ing.ingressId}
          </span>
        </div>
        <Button variant="ghost" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
      </div>

      <div className="space-y-4">
        {parts && (
          <CopyField label={t('reveal.server')} value={parts.server} />
        )}
        {typeof rtmp === 'string' && (
          <CopyField label={t('reveal.rtmpUrl')} value={rtmp} />
        )}
        {typeof ing.srt_url === 'string' && (
          <CopyField label={t('reveal.srtUrl')} value={ing.srt_url} />
        )}
        {typeof key === 'string' && key && (
          <SecretField label={t('reveal.streamKey')} value={key} />
        )}
        {typeof backupKey === 'string' && backupKey && (
          <>
            {typeof backupRtmp === 'string' && (
              <CopyField label={t('reveal.backupRtmpUrl')} value={backupRtmp} />
            )}
            <SecretField label={t('reveal.backupStreamKey')} value={backupKey} />
            <p className="text-[11px] text-gray-400">
              {t('reveal.failoverNote')}
            </p>
          </>
        )}
        {ing.requires_password && (
          <p className="text-[11px] font-medium text-amber-300">
            {t('reveal.passwordRequired')}
          </p>
        )}
        <p className="text-[11px] text-gray-400">
          {t('reveal.help')}
        </p>
      </div>
    </Dialog>
  )
}

/** Credentials returned right after minting a WS (ESP32/MJPEG) camera key. */
function WsIngestDetails({ ws }: { ws: WsIngestKey }) {
  const { t } = useTranslation('ingressTab')
  const origin = window.location.origin
  const wsUrl = absoluteUrl(ws.wsUrl, origin)
  return (
    <div className="space-y-3 rounded-lg border border-blue2/30 bg-blue2/5 p-4">
      <div className="flex items-center gap-2">
        <Badge tone="cyan">ws-mjpeg</Badge>
        <span className="font-mono text-xs text-slate-400">{ws.id}</span>
      </div>
      {wsUrl && <CopyField label={t('ws.details.wsUrl')} value={wsUrl} />}
      {typeof ws.streamKey === 'string' && (
        <CopyField label={t('ws.details.streamKey')} value={ws.streamKey} />
      )}
      {typeof ws.mjpegUrl === 'string' && (
        <CopyField label={t('ws.details.mjpegUrl')} value={absoluteUrl(ws.mjpegUrl, origin)} />
      )}
      {typeof ws.playerUrl === 'string' && (
        <CopyField
          label={t('details.playerUrl')}
          value={absoluteUrl(ws.playerUrl, origin)}
          mono={false}
        />
      )}
      <p className="text-[11px] text-gray-400">{t('ws.details.help')}</p>
    </div>
  )
}

/** Credentials dialog for one WS camera key (wss URL + revealable wsk_ key). */
function WsCredentialsDialog({
  app,
  row,
  onClose,
}: {
  app: string
  row: WsIngestKey
  onClose: () => void
}) {
  const { t } = useTranslation(['ingressTab', 'common'])
  const origin = window.location.origin
  const room = row.room ?? ''
  const wsUrl = wsPublishUrl(undefined, origin, app, room)
  return (
    <Dialog isOpen width={640} closable={false} onClose={onClose} onRequestClose={onClose}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h5 className="text-base font-semibold text-gray-100">
            {t('ws.reveal.title')}
          </h5>
          <span className="truncate font-mono text-xs text-slate-400">{row.id}</span>
        </div>
        <Button variant="ghost" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
      </div>
      <div className="space-y-4">
        <CopyField label={t('ws.details.wsUrl')} value={wsUrl} />
        {typeof row.streamKey === 'string' && row.streamKey && (
          <SecretField label={t('ws.reveal.streamKey')} value={row.streamKey} />
        )}
        <CopyField
          label={t('ws.details.mjpegUrl')}
          value={`${origin}/live/${encodeURIComponent(app)}/${encodeURIComponent(room)}/mjpeg`}
        />
        <p className="text-[11px] text-gray-400">{t('ws.reveal.help')}</p>
      </div>
    </Dialog>
  )
}

/** Live thumbnail of an active camera (frame.jpg, refreshed periodically). */
function CameraThumb({ app, room }: { app: string; room: string }) {
  const [epoch, setEpoch] = useState(() => Date.now())
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    const id = setInterval(() => {
      setBroken(false)
      setEpoch(Date.now())
    }, 15_000)
    return () => clearInterval(id)
  }, [])
  if (broken) return null
  return (
    <img
      src={withCacheBuster(frameUrl(app, room), epoch)}
      alt=""
      className="h-10 w-16 shrink-0 rounded object-cover ring-1 ring-white/10"
      onError={() => setBroken(true)}
    />
  )
}

/** WS (ESP32/MJPEG) camera keys card: list + reveal + open player + revoke. */
function WsCamerasCard({ app }: { app: string }) {
  const { t } = useTranslation(['ingressTab', 'common', 'appDetail'])
  const qc = useQueryClient()
  const [credsFor, setCredsFor] = useState<WsIngestKey | null>(null)

  const list = useQuery({
    queryKey: ['ws-ingest-keys', app],
    queryFn: ({ signal }) => api.wsIngest.list(app, signal),
    refetchInterval: 15_000,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.wsIngest.remove(app, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws-ingest-keys', app] }),
  })

  const rows = list.data ?? []

  return (
    <Card className="p-0">
      <div className="p-5">
        <SectionTitle
          title={t('ws.list.title')}
          subtitle={t('ws.list.subtitle')}
          right={
            <Button variant="ghost" onClick={() => list.refetch()}>
              {list.isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
            </Button>
          }
        />
        {remove.isError && (
          <div className="mt-3">
            <ErrorBanner message={errMessage(remove.error, t('ws.list.removeError'))} />
          </div>
        )}
      </div>

      {list.isLoading ? (
        <Loading label={t('ws.list.loading')} />
      ) : list.isError ? (
        <div className="p-5">
          <ErrorBanner message={errMessage(list.error, t('ws.list.loadError'))} />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-slate-500">{t('ws.list.empty')}</p>
        </div>
      ) : (
        <RTable
          head={
            <tr>
              <RTh>{t('ws.list.table.camera')}</RTh>
              <RTh>{t('list.table.room')}</RTh>
              <RTh>{t('list.table.status')}</RTh>
              <RTh className="text-right">{t('list.table.actions')}</RTh>
            </tr>
          }
        >
          {rows.map((row) => {
            const room = row.room ?? ''
            return (
              <RTr key={row.id}>
                <RTd label={t('ws.list.table.camera')} className="text-slate-300">
                  <span className="flex min-w-0 items-center gap-2 max-md:justify-end">
                    {row.active && room && <CameraThumb app={app} room={room} />}
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{row.id}</span>
                      {row.identity && (
                        <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                          {row.identity}
                        </span>
                      )}
                    </span>
                  </span>
                </RTd>
                <RTd label={t('list.table.room')} className="font-mono text-xs text-slate-300">
                  {room || '—'}
                </RTd>
                <RTd label={t('list.table.status')}>
                  <Badge tone={row.active ? 'green' : 'slate'}>
                    {row.active ? t('ws.status.active') : t('ws.status.inactive')}
                  </Badge>
                </RTd>
                <RTd actions className="text-right">
                  <div className="inline-flex gap-2 max-md:w-full max-md:justify-end">
                    <Tooltip title={t('ws.list.revealTooltip')}>
                      <Button
                        variant="ghost"
                        aria-label={t('ws.list.revealTooltip')}
                        onClick={() => setCredsFor(row)}
                      >
                        <HiOutlineEye className="text-base" />
                      </Button>
                    </Tooltip>
                    {room && (
                      <Tooltip title={t('ws.list.openPlayer')}>
                        <Button
                          variant="ghost"
                          aria-label={t('ws.list.openPlayer')}
                          onClick={() =>
                            window.open(
                              `/play/${encodeURIComponent(app)}/${encodeURIComponent(room)}`,
                              '_blank',
                              'noopener',
                            )
                          }
                        >
                          <HiOutlineExternalLink className="text-base" />
                        </Button>
                      </Tooltip>
                    )}
                    <Tooltip title={t('common:actions.delete')}>
                      <Button
                        variant="danger"
                        aria-label={t('common:actions.delete')}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(t('ws.list.confirmRemove', { id: row.id })))
                            remove.mutate(row.id)
                        }}
                      >
                        <HiOutlineTrash className="text-base" />
                      </Button>
                    </Tooltip>
                  </div>
                </RTd>
              </RTr>
            )
          })}
        </RTable>
      )}

      {credsFor && (
        <WsCredentialsDialog app={app} row={credsFor} onClose={() => setCredsFor(null)} />
      )}
    </Card>
  )
}

export function IngressTab({ app }: { app: string }) {
  const { t } = useTranslation(['ingressTab', 'common', 'appDetail'])
  const qc = useQueryClient()

  const [inputType, setInputType] = useState<IngestKind>('rtmp')
  const [room, setRoom] = useState('')
  const [participantIdentity, setParticipantIdentity] = useState('')
  const [url, setUrl] = useState('')
  // MPEG-TS (udp multicast/unicast) structured fields.
  const [mpegtsSources, setMpegtsSources] = useState('')
  const [mpegtsLocaladdr, setMpegtsLocaladdr] = useState('')
  const [mpegtsFifoSize, setMpegtsFifoSize] = useState('')
  const [enableTranscoding, setEnableTranscoding] = useState(true)
  // Primary + backup (failover) key — RTMP only, on by default so the operator
  // gets a redundant key out of the box (Dacast/Vimeo-style).
  const [withBackup, setWithBackup] = useState(true)
  // RTMP→HLS passthrough (remux, no transcode). Mutually exclusive with
  // transcode/backup — selecting it disables both (the backend also rejects the
  // mix with a 400).
  const [passthrough, setPassthrough] = useState(false)

  // Listing: search + page (offset paging against the backend).
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebounced(search)
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch])

  // Which row's credentials dialog is open.
  const [credsFor, setCredsFor] = useState<Ingress | null>(null)

  const params = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [debouncedSearch, page],
  )

  const list = useQuery({
    queryKey: ['app-ingress', app, params],
    queryFn: ({ signal }) => api.ingress.list(app, params, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  })

  const isWs = inputType === 'ws-mjpeg'
  const isRtmp = inputType === 'rtmp'
  const isSrt = inputType === 'srt'
  const isMpegts = inputType === 'mpegts'
  // Passthrough is an RTMP/SRT/MPEG-TS-only plane; ignore a stale toggle for
  // other inputs. SRT and MPEG-TS FORCE it: LiveKit's ingress API has no input
  // type for either, so they can only land on the remux plane (the backend 400s
  // otherwise).
  const passthroughActive = (isRtmp && passthrough) || isSrt || isMpegts
  const lostLines = usePassthroughLostLines()

  const create = useMutation({
    mutationFn: () => {
      const payload: CreateIngressRequest = {
        inputType: inputType as IngressInputType,
      }
      if (passthroughActive) {
        // Remux plane: no transcode, no backup (both are 400s server-side).
        payload.mode = 'passthrough'
      } else {
        payload.enableTranscoding = enableTranscoding
        if (isRtmp && withBackup) payload.backup = true
      }
      if (room.trim()) payload.room = room.trim()
      if (participantIdentity.trim()) payload.participantIdentity = participantIdentity.trim()
      // Both `url` (pull) and `mpegts` (udp source) ride in `url`.
      if ((inputType === 'url' || isMpegts) && url.trim()) payload.url = url.trim()
      if (isMpegts) {
        // Structured udp options — only sent when provided (backend applies safe
        // defaults incl. overrun_nonfatal on).
        if (mpegtsSources.trim()) payload.sources = mpegtsSources.trim()
        if (mpegtsLocaladdr.trim()) payload.localaddr = mpegtsLocaladdr.trim()
        const fifo = Number(mpegtsFifoSize.trim())
        if (mpegtsFifoSize.trim() && Number.isFinite(fifo)) payload.fifoSize = fifo
      }
      return api.ingress.create(app, payload)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-ingress', app] }),
  })

  // Direct WS MJPEG camera key (ESP32) — separate endpoint + result shape.
  const createWs = useMutation({
    mutationFn: () =>
      api.wsIngest.create(app, {
        room: room.trim(),
        identity: participantIdentity.trim() || undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws-ingest-keys', app] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.ingress.remove(app, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-ingress', app] }),
  })

  const ingresses = list.data?.items ?? []
  const total = list.data?.total ?? ingresses.length
  const createRef = useRef<HTMLDivElement>(null)

  function statusBadge(ing: Ingress) {
    const status = typeof ing.status === 'string' ? ing.status : 'inactive'
    const known = status in STATUS_TONE
    return (
      <Badge tone={known ? STATUS_TONE[status] : 'slate'}>
        {known ? t(`status.${status}`) : status}
      </Badge>
    )
  }

  return (
    <div className="space-y-5">
      <div ref={createRef}>
        <Card>
        <SectionTitle title={t('create.title')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('create.inputTypeLabel')}>
            <Select
              value={inputType}
              onChange={(e) => setInputType(e.target.value as IngestKind)}
            >
              {INPUT_TYPE_VALUES.map((v) => (
                <option key={v} value={v}>
                  {t(`inputType.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('create.roomLabel')}
            hint={isWs ? t('ws.create.roomHint') : t('create.roomHint')}
          >
            <TextInput
              value={room}
              placeholder={isWs ? 'cam1' : 'demo'}
              onChange={(e) => setRoom(e.target.value)}
            />
          </Field>
          <Field label={t('create.identityLabel')} hint={t('create.identityHint')}>
            <TextInput
              value={participantIdentity}
              placeholder={isWs ? 'porton-norte' : 'rtmp-publisher'}
              onChange={(e) => setParticipantIdentity(e.target.value)}
            />
          </Field>
          {inputType === 'url' && (
            <Field label={t('create.urlLabel')} hint={t('create.urlHint')}>
              <TextInput
                value={url}
                placeholder="rtsp://camera.local/stream"
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          )}
          {isMpegts && (
            <>
              <Field
                label={t('create.mpegts.sourceLabel')}
                hint={t('create.mpegts.sourceHint')}
              >
                <TextInput
                  value={url}
                  placeholder="udp://@239.1.1.1:5000"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Field
                label={t('create.mpegts.sourcesLabel')}
                hint={t('create.mpegts.sourcesHint')}
              >
                <TextInput
                  value={mpegtsSources}
                  placeholder="10.0.0.5"
                  onChange={(e) => setMpegtsSources(e.target.value)}
                />
              </Field>
              <Field
                label={t('create.mpegts.localaddrLabel')}
                hint={t('create.mpegts.localaddrHint')}
              >
                <TextInput
                  value={mpegtsLocaladdr}
                  placeholder="192.168.1.10"
                  onChange={(e) => setMpegtsLocaladdr(e.target.value)}
                />
              </Field>
              <Field
                label={t('create.mpegts.fifoLabel')}
                hint={t('create.mpegts.fifoHint')}
              >
                <TextInput
                  value={mpegtsFifoSize}
                  placeholder="1000000"
                  onChange={(e) => setMpegtsFifoSize(e.target.value)}
                />
              </Field>
            </>
          )}
          {isWs ? (
            <div className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2">
              <div className="text-sm text-slate-100">{t('ws.create.infoTitle')}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {t('ws.create.infoHint')}
              </div>
            </div>
          ) : (
            <div
              className={`flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2 ${
                passthroughActive ? 'opacity-50' : ''
              }`}
            >
              <div>
                <div className="text-sm text-slate-100">{t('create.transcodeTitle')}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {t('create.transcodeHint')}
                </div>
              </div>
              <Toggle
                checked={passthroughActive ? false : enableTranscoding}
                onChange={setEnableTranscoding}
                disabled={passthroughActive}
                ariaLabel={t('create.transcodeTitle')}
              />
            </div>
          )}
          {(isRtmp || isSrt || isMpegts) && (
            <>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2">
                <div>
                  <div className="flex items-center gap-1.5 text-sm text-slate-100">
                    {t('create.passthrough.title')}
                    <DocsHint section="rtmpPassthrough" />
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {t('create.passthrough.hint')}
                  </div>
                  {isSrt && (
                    <div className="mt-0.5 text-[11px] font-medium text-amber-300">
                      {t('create.passthrough.srtForced')}
                    </div>
                  )}
                  {isMpegts && (
                    <div className="mt-0.5 text-[11px] font-medium text-amber-300">
                      {t('create.passthrough.mpegtsForced')}
                    </div>
                  )}
                </div>
                {/* SRT + MPEG-TS are passthrough-ONLY: the toggle locks checked+disabled. */}
                <Toggle
                  checked={isSrt || isMpegts || passthrough}
                  onChange={setPassthrough}
                  disabled={isSrt || isMpegts}
                  ariaLabel={t('create.passthrough.title')}
                />
              </div>
              {passthroughActive && (
                <div className="sm:col-span-2">
                  <PassthroughLostWarning
                    title={t('create.passthrough.warningTitle')}
                    items={lostLines}
                  />
                </div>
              )}
              {isSrt && (
                <div
                  role="note"
                  className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2"
                >
                  <div className="text-sm text-slate-100">{t('create.srt.noteTitle')}</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[11px] text-slate-500">
                    <li>{t('create.srt.note.udp')}</li>
                    <li>{t('create.srt.note.latency')}</li>
                    <li>{t('create.srt.note.credential')}</li>
                  </ul>
                </div>
              )}
              {isMpegts && (
                <div
                  role="note"
                  className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2"
                >
                  <div className="text-sm text-slate-100">{t('create.mpegts.noteTitle')}</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[11px] text-slate-500">
                    <li>{t('create.mpegts.note.pull')}</li>
                    <li>{t('create.mpegts.note.multicast')}</li>
                    <li>{t('create.mpegts.note.ssm')}</li>
                  </ul>
                </div>
              )}
              {/* Backup (failover) key is RTMP/SRT push-only — an MPEG-TS PULL has
                  no push credential to fail over, so hide the whole control. */}
              {!isMpegts && (
                <div
                  className={`flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2 ${
                    passthroughActive ? 'opacity-50' : ''
                  }`}
                >
                  <div>
                    <div className="text-sm text-slate-100">{t('create.backupTitle')}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {t('create.backupHint')}
                    </div>
                  </div>
                  <Toggle
                    checked={passthroughActive ? false : withBackup}
                    onChange={setWithBackup}
                    disabled={passthroughActive}
                    ariaLabel={t('create.backupTitle')}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="accent"
            disabled={
              isWs
                ? createWs.isPending || !room.trim()
                : create.isPending ||
                  ((inputType === 'url' || isMpegts) && !url.trim())
            }
            onClick={() => (isWs ? createWs.mutate() : create.mutate())}
          >
            {(isWs ? createWs.isPending : create.isPending)
              ? t('create.submitting')
              : t('create.submit')}
          </Button>
        </div>

        {!isWs && create.isError && (
          <div className="mt-4">
            <ErrorBanner
              message={
                isServiceUnavailable(create.error)
                  ? t('create.passthrough.disabled503')
                  : errMessage(create.error, t('create.error'))
              }
            />
          </div>
        )}
        {isWs && createWs.isError && (
          <div className="mt-4">
            <ErrorBanner message={errMessage(createWs.error, t('ws.create.error'))} />
          </div>
        )}
        {!isWs && create.data && (
          <div className="mt-4">
            {create.data.mode === 'passthrough' ? (
              <PassthroughIngressDetails ing={create.data} />
            ) : (
              <IngressDetails ing={create.data} />
            )}
          </div>
        )}
        {isWs && createWs.data && (
          <div className="mt-4">
            <WsIngestDetails ws={createWs.data} />
          </div>
        )}
        </Card>
      </div>

      {/* Direct WS MJPEG cameras (ESP32) — separate store from LiveKit ingress. */}
      <WsCamerasCard app={app} />

      <Card className="p-0">
        <div className="p-5">
          <SectionTitle
            title={t('list.title')}
            subtitle={t('list.subtitle')}
            right={
              <Button variant="ghost" onClick={() => list.refetch()}>
                {list.isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
              </Button>
            }
          />
          <div className="mt-3 max-w-xs">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('list.searchPlaceholder')}
            />
          </div>
          {remove.isError && (
            <div className="mt-3">
              <ErrorBanner message={errMessage(remove.error, t('list.removeError'))} />
            </div>
          )}
        </div>

        {list.isLoading ? (
          <Loading label={t('list.loading')} />
        ) : list.isError ? (
          <div className="p-5">
            <ErrorBanner message={errMessage(list.error, t('list.loadError'))} />
          </div>
        ) : ingresses.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-slate-500">
              {debouncedSearch ? t('list.emptyFiltered') : t('list.empty')}
            </p>
            {!debouncedSearch && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="accent"
                  onClick={() =>
                    createRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  {t('list.emptyCta')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <RTable
            head={
              <tr>
                <RTh>{t('list.table.ingress')}</RTh>
                <RTh>{t('list.table.room')}</RTh>
                <RTh>{t('list.table.status')}</RTh>
                <RTh>{t('list.table.bitrate')}</RTh>
                <RTh>{t('list.table.viewers')}</RTh>
                <RTh className="text-right">{t('list.table.actions')}</RTh>
              </tr>
            }
          >
            {ingresses.map((ing: Ingress) => {
              const live = ing.status === 'publishing'
              const res =
                ing.width && ing.height ? `${ing.width}×${ing.height}` : null
              const role = ingressRole(ing)
              // SRT push rows (id `pti_srt_…`) and MPEG-TS pull rows
              // (id `pti_mpegts_…`) get a dedicated badge next to the passthrough one.
              const srt = isSrtIngress(ing)
              const mpegts = isMpegtsIngress(ing)
              return (
                <RTr key={ing.ingressId}>
                  <RTd label={t('list.table.ingress')} className="text-slate-300">
                    <span className="min-w-0 max-md:text-right">
                      <span className="block truncate text-sm">
                        {ing.name || ing.ingressId}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500 max-md:justify-end">
                        {ing.ingressId}
                        {ing.inputType && !srt && !mpegts && (
                          <Badge tone="cyan">{ing.inputType}</Badge>
                        )}
                        {ing.mode === 'passthrough' && (
                          <Badge tone="amber">{t('list.passthroughBadge')}</Badge>
                        )}
                        {srt && <Badge tone="cyan">{t('list.srtBadge')}</Badge>}
                        {mpegts && <Badge tone="cyan">{t('list.mpegtsBadge')}</Badge>}
                        {role && (
                          <Badge tone={role === 'backup' ? 'amber' : 'green'}>
                            {t(`list.${role}Badge`)}
                          </Badge>
                        )}
                        {ing.requires_password && (
                          <Badge tone="amber">{t('list.passwordBadge')}</Badge>
                        )}
                      </span>
                    </span>
                  </RTd>
                  <RTd label={t('list.table.room')} className="font-mono text-xs text-slate-300">
                    {ing.room ?? ing.roomName ?? '—'}
                  </RTd>
                  <RTd label={t('list.table.status')}>
                    <div className="flex flex-wrap items-center gap-1.5 max-md:justify-end">
                      {statusBadge(ing)}
                      {res && (
                        <span className="text-[11px] text-slate-500">{res}</span>
                      )}
                    </div>
                  </RTd>
                  <RTd label={t('list.table.bitrate')} className="text-xs tabular-nums text-slate-300">
                    {live ? formatBitrate(ing.bitrate) : '—'}
                  </RTd>
                  <RTd label={t('list.table.viewers')} className="text-xs tabular-nums text-slate-300">
                    {typeof ing.viewers === 'number' ? ing.viewers : '—'}
                  </RTd>
                  <RTd actions className="text-right">
                    <div className="inline-flex gap-2 max-md:w-full max-md:justify-end">
                      <Tooltip title={t('list.revealTooltip')}>
                        <Button
                          variant="ghost"
                          aria-label={t('list.revealTooltip')}
                          onClick={() => setCredsFor(ing)}
                        >
                          <HiOutlineEye className="text-base" />
                        </Button>
                      </Tooltip>
                      <Tooltip title={t('common:actions.delete')}>
                        <Button
                          variant="danger"
                          aria-label={t('common:actions.delete')}
                          disabled={remove.isPending}
                          onClick={() => {
                            const msg =
                              role === 'primary'
                                ? t('list.confirmRemovePrimary', { id: ing.ingressId })
                                : t('list.confirmRemove', { id: ing.ingressId })
                            if (confirm(msg)) remove.mutate(ing.ingressId)
                          }}
                        >
                          <HiOutlineTrash className="text-base" />
                        </Button>
                      </Tooltip>
                    </div>
                  </RTd>
                </RTr>
              )
            })}
          </RTable>
        )}

        {total > PAGE_SIZE && (
          <div className="flex justify-end border-t p-4 border-gray-700">
            <Pagination
              currentPage={page}
              pageSize={PAGE_SIZE}
              total={total}
              displayTotal
              onChange={setPage}
            />
          </div>
        )}
      </Card>

      {credsFor && (
        <CredentialsDialog ing={credsFor} onClose={() => setCredsFor(null)} />
      )}
    </div>
  )
}
