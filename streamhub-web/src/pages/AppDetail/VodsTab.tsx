/**
 * Grabaciones (VODs) tab.
 *
 * Top: recording config (split_minutes / snapshot_seconds) → PATCH
 * /apps/:app/config (config.recording). These govern how live recordings are
 * cut and snapshotted.
 *
 * Below: the VOD list with DURATION (durationS, mm:ss / h:mm:ss) and CREATED
 * date (startedAt) columns, and icon actions: play fetches a fresh presigned
 * publicUrl via GET /apps/:app/vods/:id and plays it with <VodPlayer>
 * (video.js), download uses /download, delete confirms first. Legacy VODs
 * with no duration get a probe icon → POST /apps/:app/vods/:id/probe
 * (ffprobe backfill, best-effort).
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  HiOutlineClock,
  HiOutlineDownload,
  HiOutlinePlay,
  HiOutlineTrash,
} from 'react-icons/hi'
import { api } from '@/api'
import { Dialog, Notification, Pagination, Tooltip, toast } from '@/ui'
import type { RecordingConfig, SortDir, Vod, VodOrder } from '@/api'
import { VodPlayer } from '@/components/player'
import {
  formatDateTime,
  formatDuration,
  vodDurationS,
  vodStartedAt,
} from '@/lib/mediaFormat'
import {
  Badge,
  Button,
  Card,
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
  errMessage,
} from './ui'

const PAGE_SIZE = 20

/** Status options for the filter Select (empty = any). */
const STATUS_VALUES = ['ready', 'recording', 'uploading', 'failed']

/** Combined order options (encoded as `${order}:${dir}`) for a single Select. */
const ORDER_OPTIONS: { key: string; order: VodOrder; dir: SortDir }[] = [
  { key: 'newest', order: 'started_at', dir: 'desc' },
  { key: 'oldest', order: 'started_at', dir: 'asc' },
  { key: 'largest', order: 'size_bytes', dir: 'desc' },
  { key: 'smallest', order: 'size_bytes', dir: 'asc' },
]

/** Small debounce so typing in the room filter doesn't spam the API. */
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

/** Open a presigned download URL via a temporary anchor (falls back to open). */
function triggerDownload(url: string, filename?: string): void {
  try {
    const a = document.createElement('a')
    a.href = url
    if (filename) a.download = filename
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}

// Fixed UI choices from the spec (§3). Labels are resolved via i18n.
const SPLIT_VALUES = [0, 15, 30, 60, 90, 120]
const SNAPSHOT_VALUES = [0, 1, 30, 60, 120, 360]

function RecordingConfigCard({ app }: { app: string }) {
  const { t } = useTranslation(['vodsTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config', app],
    queryFn: ({ signal }) => api.apps.getConfig(app, signal),
  })

  const [split, setSplit] = useState(0)
  const [snapshot, setSnapshot] = useState(0)

  useEffect(() => {
    const rec = data?.recording
    setSplit(Number(rec?.split_minutes ?? 0))
    setSnapshot(Number(rec?.snapshot_seconds ?? 0))
  }, [data])

  const save = useMutation({
    mutationFn: (patch: RecordingConfig) =>
      api.apps.updateConfig(app, {
        recording: { ...(data?.recording ?? {}), ...patch },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-config', app] }),
  })

  if (isLoading) return <Loading label={t('config.loading')} />
  if (isError)
    return (
      <ErrorBanner
        message={errMessage(error, t('config.loadError'))}
      />
    )

  return (
    <Card>
      <SectionTitle
        title={t('config.title')}
        subtitle={t('config.subtitle')}
        right={
          save.isPending ? (
            <span className="text-xs text-slate-400">{t('common:state.saving')}</span>
          ) : save.isSuccess ? (
            <span className="text-xs text-success">{t('config.saved')}</span>
          ) : undefined
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('config.splitLabel')}
          hint={t('config.splitHint')}
        >
          <Select
            value={split}
            disabled={save.isPending}
            onChange={(e) => {
              const v = Number(e.target.value)
              setSplit(v)
              save.mutate({ split_minutes: v })
            }}
          >
            {SPLIT_VALUES.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? t('split.none') : t('split.minutes', { n: v })}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('config.snapshotLabel')}
          hint={t('config.snapshotHint')}
        >
          <Select
            value={snapshot}
            disabled={save.isPending}
            onChange={(e) => {
              const v = Number(e.target.value)
              setSnapshot(v)
              save.mutate({ snapshot_seconds: v })
            }}
          >
            {SNAPSHOT_VALUES.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? t('snapshot.off') : t('snapshot.every', { n: v })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {save.isError && (
        <div className="mt-4">
          <ErrorBanner
            message={errMessage(save.error, t('config.saveError'))}
          />
        </div>
      )}
    </Card>
  )
}

/** Pick the best playable URL from a VOD record (presigned / public / cdn). */
function vodUrl(v: Vod): string | undefined {
  return v.publicUrl ?? v.presignedUrl ?? v.url
}

export function VodsTab({ app }: { app: string }) {
  const { t } = useTranslation(['vodsTab', 'common', 'appDetail'])
  const qc = useQueryClient()
  const [playing, setPlaying] = useState<{ vod: Vod; url: string } | null>(null)
  const [confirmDel, setConfirmDel] = useState<Vod | null>(null)

  // Filters + paging. Any filter change resets to the first page.
  const [room, setRoom] = useState('')
  const [status, setStatus] = useState('')
  const [orderKey, setOrderKey] = useState(ORDER_OPTIONS[0].key)
  const [page, setPage] = useState(1)
  const debouncedRoom = useDebounced(room)

  useEffect(() => {
    setPage(1)
  }, [debouncedRoom, status, orderKey])

  const sort = useMemo(
    () => ORDER_OPTIONS.find((o) => o.key === orderKey) ?? ORDER_OPTIONS[0],
    [orderKey],
  )
  const params = useMemo(
    () => ({
      room: debouncedRoom || undefined,
      status: status || undefined,
      order: sort.order,
      dir: sort.dir,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [debouncedRoom, status, sort, page],
  )

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['app-vods', app, params],
    queryFn: ({ signal }) => api.vods.list(app, params, signal),
    placeholderData: keepPreviousData,
  })

  const play = useMutation({
    mutationFn: (id: number) => api.vods.get(app, id),
    onSuccess: (vod) => {
      const url = vodUrl(vod)
      if (url) setPlaying({ vod, url })
    },
  })

  const download = useMutation({
    mutationFn: (id: number) => api.vods.download(app, id),
    onSuccess: (dl) => triggerDownload(dl.url, dl.filename),
    onError: (err) => {
      toast.push(
        <Notification title={t('download.errorTitle')} type="danger">
          {errMessage(err, t('download.error'))}
        </Notification>,
      )
    },
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.vods.remove(app, id),
    onSuccess: () => {
      setConfirmDel(null)
      qc.invalidateQueries({ queryKey: ['app-vods', app] })
    },
  })

  // Legacy VODs (pre-metadata pipeline) have no duration: ffprobe backfill.
  const probe = useMutation({
    mutationFn: (id: number) => api.vods.probe(app, id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['app-vods', app] })
      if (!res.probed) {
        toast.push(
          <Notification title={t('probe.noneTitle')} type="warning">
            {t('probe.none')}
          </Notification>,
        )
      }
    },
    onError: (err) => {
      toast.push(
        <Notification title={t('probe.errorTitle')} type="danger">
          {errMessage(err, t('probe.error'))}
        </Notification>,
      )
    },
  })

  const vods = data?.items ?? []
  const total = data?.total ?? vods.length
  const hasFilters = Boolean(debouncedRoom || status)

  return (
    <div className="space-y-5">
      <RecordingConfigCard app={app} />

      <Card className="p-0">
        <div className="p-5">
          <SectionTitle
            title={t('title')}
            subtitle={t('subtitle')}
            right={
              <Button variant="ghost" onClick={() => refetch()}>
                {isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
              </Button>
            }
          />

          {/* Filters */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="max-md:w-full">
              <TextInput
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder={t('filters.room')}
              />
            </div>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-auto"
            >
              <option value="">{t('filters.allStatuses')}</option>
              {STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Select
              value={orderKey}
              onChange={(e) => setOrderKey(e.target.value)}
              className="w-auto"
            >
              {ORDER_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {t(`filters.order.${o.key}`)}
                </option>
              ))}
            </Select>
          </div>

          {play.isError && (
            <div className="mt-3">
              <ErrorBanner message={errMessage(play.error, t('playError'))} />
            </div>
          )}
        </div>

        {isLoading ? (
          <Loading label={t('loading')} />
        ) : isError ? (
          <div className="p-5">
            <ErrorBanner message={errMessage(error, t('loadError'))} />
          </div>
        ) : vods.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-slate-500">
              {hasFilters ? t('emptyFiltered') : t('empty')}
            </p>
            {!hasFilters && (
              <div className="mt-4 flex justify-center">
                <Link
                  to="?tab=streams"
                  className="btn-accent inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition"
                >
                  {t('emptyCta.goLive')}
                </Link>
              </div>
            )}
          </div>
        ) : (
          <RTable
            head={
              <tr>
                <RTh>#</RTh>
                <RTh>{t('table.room')}</RTh>
                <RTh>{t('table.status')}</RTh>
                <RTh>{t('table.duration')}</RTh>
                <RTh>{t('table.size')}</RTh>
                <RTh>{t('table.created')}</RTh>
                <RTh className="text-right">{t('table.actions')}</RTh>
              </tr>
            }
          >
            {vods.map((v: Vod) => {
              const ready = v.status === 'ready'
              const duration = vodDurationS(v)
              const playPending = play.isPending && play.variables === v.id
              const dlPending = download.isPending && download.variables === v.id
              const probePending = probe.isPending && probe.variables === v.id
              return (
                <RTr key={v.id}>
                  <RTd label="#" className="font-mono text-xs text-slate-400">
                    {v.id}
                  </RTd>
                  <RTd label={t('table.room')} className="text-slate-300">
                    {v.room ?? '—'}
                  </RTd>
                  <RTd label={t('table.status')}>
                    <Badge tone={ready ? 'green' : 'slate'}>{v.status ?? '—'}</Badge>
                  </RTd>
                  <RTd label={t('table.duration')} className="tabular-nums text-slate-300">
                    <span className="inline-flex items-center gap-1.5 max-md:justify-end">
                      {formatDuration(duration)}
                      {ready && !duration && (
                        <Tooltip title={t('probe.tooltip')}>
                          <Button
                            variant="ghost"
                            aria-label={t('probe.tooltip')}
                            disabled={probePending}
                            onClick={() => probe.mutate(v.id)}
                            className="px-1.5!"
                          >
                            <HiOutlineClock
                              className={`text-base ${probePending ? 'animate-pulse' : ''}`}
                            />
                          </Button>
                        </Tooltip>
                      )}
                    </span>
                  </RTd>
                  <RTd label={t('table.size')} className="text-slate-300">
                    {fmtBytes(v.sizeBytes)}
                  </RTd>
                  <RTd label={t('table.created')} className="text-xs text-slate-400">
                    {formatDateTime(vodStartedAt(v))}
                  </RTd>
                  <RTd actions className="text-right">
                    <div className="inline-flex gap-2 max-md:w-full max-md:justify-end">
                      <Tooltip title={t('actions.play')}>
                        <Button
                          variant="accent"
                          aria-label={t('actions.play')}
                          disabled={!ready || playPending}
                          onClick={() => play.mutate(v.id)}
                        >
                          <HiOutlinePlay
                            className={`text-base ${playPending ? 'animate-pulse' : ''}`}
                          />
                        </Button>
                      </Tooltip>
                      <Tooltip title={t('actions.download')}>
                        <Button
                          variant="ghost"
                          aria-label={t('actions.download')}
                          disabled={!ready || dlPending}
                          onClick={() => download.mutate(v.id)}
                        >
                          <HiOutlineDownload
                            className={`text-base ${dlPending ? 'animate-pulse' : ''}`}
                          />
                        </Button>
                      </Tooltip>
                      <Tooltip title={t('common:actions.delete')}>
                        <Button
                          variant="danger"
                          aria-label={t('common:actions.delete')}
                          disabled={remove.isPending}
                          onClick={() => setConfirmDel(v)}
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

      {playing && (
        <Dialog
          isOpen
          width={820}
          closable={false}
          onClose={() => setPlaying(null)}
          onRequestClose={() => setPlaying(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h5 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('player.title', { id: playing.vod.id })}
            </h5>
            <Button variant="ghost" onClick={() => setPlaying(null)}>
              {t('common:actions.close')}
            </Button>
          </div>
          <VodPlayer src={playing.url} poster={playing.vod.snapshotUrl} />
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
            <Meta label={t('meta.room')} value={playing.vod.room ?? '—'} />
            <Meta
              label={t('meta.duration')}
              value={formatDuration(vodDurationS(playing.vod))}
            />
            <Meta label={t('meta.size')} value={fmtBytes(playing.vod.sizeBytes)} />
            <Meta
              label={t('meta.created')}
              value={formatDateTime(vodStartedAt(playing.vod))}
            />
          </dl>
        </Dialog>
      )}

      {confirmDel && (
        <Dialog
          isOpen
          width={460}
          closable={false}
          onClose={() => !remove.isPending && setConfirmDel(null)}
          onRequestClose={() => !remove.isPending && setConfirmDel(null)}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h5 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('delete.title', { id: confirmDel.id })}
            </h5>
            <Badge tone="red">{t('delete.destructive')}</Badge>
          </div>
          <p className="mb-4 text-xs font-medium text-amber-600 dark:text-amber-300">
            {t('delete.warning')}
          </p>
          {remove.isError && (
            <div className="mb-3">
              <ErrorBanner
                message={errMessage(remove.error, t('delete.error'))}
              />
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => setConfirmDel(null)}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(confirmDel.id)}
            >
              {remove.isPending ? t('delete.deleting') : t('delete.confirm')}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="truncate text-slate-300">{value}</dd>
    </div>
  )
}
