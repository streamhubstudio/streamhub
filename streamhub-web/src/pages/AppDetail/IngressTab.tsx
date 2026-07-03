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
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HiOutlineEye, HiOutlineEyeOff, HiOutlineExternalLink, HiOutlineTrash } from 'react-icons/hi'
import { api } from '@/api'
import type { CreateIngressRequest, Ingress, IngressInputType, WsIngestKey } from '@/api'
import { Dialog, Input, Pagination, Tooltip } from '@/ui'
import { formatBitrate } from '@/lib/mediaFormat'
import { maskSecret, splitIngestUrl } from '@/lib/ingest'
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
} from './ui'

/** Ingest kinds offered by the create form: LiveKit ingress + direct WS MJPEG. */
type IngestKind = IngressInputType | 'ws-mjpeg'
const INPUT_TYPE_VALUES: IngestKind[] = ['rtmp', 'whip', 'url', 'ws-mjpeg']
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

/** Renders the credentials returned right after creating an ingress. */
function IngressDetails({ ing }: { ing: Ingress }) {
  const { t } = useTranslation('ingressTab')
  const rtmp = ing.rtmp_url ?? ing.rtmpUrl
  const key = ing.stream_key ?? ing.streamKey
  return (
    <div className="space-y-3 rounded-lg border border-blue2/30 bg-blue2/5 p-4">
      <div className="flex items-center gap-2">
        <Badge tone="cyan">ingress</Badge>
        <span className="font-mono text-xs text-slate-400">{ing.ingressId}</span>
        {ing.adaptive && <Badge tone="green">adaptive</Badge>}
      </div>
      {typeof rtmp === 'string' && <CopyField label={t('details.rtmpUrl')} value={rtmp} />}
      {typeof key === 'string' && <CopyField label={t('details.streamKey')} value={key} />}
      {ing.requires_password && typeof ing.stream_password === 'string' && (
        <CopyField label={t('details.streamPassword')} value={ing.stream_password} />
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
      <span className="mb-1.5 block text-sm font-semibold text-gray-700 dark:text-gray-100">
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
          <h5 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('reveal.title')}
          </h5>
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
        {typeof key === 'string' && key && (
          <SecretField label={t('reveal.streamKey')} value={key} />
        )}
        {ing.requires_password && (
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-300">
            {t('reveal.passwordRequired')}
          </p>
        )}
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
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
      <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('ws.details.help')}</p>
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
          <h5 className="text-base font-semibold text-gray-900 dark:text-gray-100">
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
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('ws.reveal.help')}</p>
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
  const [enableTranscoding, setEnableTranscoding] = useState(true)

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

  const create = useMutation({
    mutationFn: () => {
      const payload: CreateIngressRequest = {
        inputType: inputType as IngressInputType,
        enableTranscoding,
      }
      if (room.trim()) payload.room = room.trim()
      if (participantIdentity.trim()) payload.participantIdentity = participantIdentity.trim()
      if (inputType === 'url' && url.trim()) payload.url = url.trim()
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
          {isWs ? (
            <div className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2">
              <div className="text-sm text-slate-100">{t('ws.create.infoTitle')}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {t('ws.create.infoHint')}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3 sm:col-span-2">
              <div>
                <div className="text-sm text-slate-100">{t('create.transcodeTitle')}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {t('create.transcodeHint')}
                </div>
              </div>
              <Toggle checked={enableTranscoding} onChange={setEnableTranscoding} />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="accent"
            disabled={
              isWs
                ? createWs.isPending || !room.trim()
                : create.isPending || (inputType === 'url' && !url.trim())
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
            <ErrorBanner message={errMessage(create.error, t('create.error'))} />
          </div>
        )}
        {isWs && createWs.isError && (
          <div className="mt-4">
            <ErrorBanner message={errMessage(createWs.error, t('ws.create.error'))} />
          </div>
        )}
        {!isWs && create.data && (
          <div className="mt-4">
            <IngressDetails ing={create.data} />
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
              return (
                <RTr key={ing.ingressId}>
                  <RTd label={t('list.table.ingress')} className="text-slate-300">
                    <span className="min-w-0 max-md:text-right">
                      <span className="block truncate text-sm">
                        {ing.name || ing.ingressId}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500 max-md:justify-end">
                        {ing.ingressId}
                        {ing.inputType && <Badge tone="cyan">{ing.inputType}</Badge>}
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
                            if (confirm(t('list.confirmRemove', { id: ing.ingressId })))
                              remove.mutate(ing.ingressId)
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
          <div className="flex justify-end border-t border-gray-200 p-4 dark:border-gray-700">
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
