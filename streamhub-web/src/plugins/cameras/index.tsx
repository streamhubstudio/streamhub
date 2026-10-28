/**
 * Frontend plugin: cameras — OpenCam fleet console over MQTT (app tab).
 *
 * Auto-discovered (src/plugins/cameras/index.tsx default export). Mirrors the
 * streamhub-core `cameras` built-in config (builtins.json) so the Marketplace
 * renders the generic settings form, and ships the TabComponent:
 *
 *   - a filterable camera GRID (online/offline + site) with the retained
 *     thumbnail, online badge, firmware, RSSI, stream, SD, queue and safe-mode;
 *   - a DETAIL panel: live HLS player (the camera's passthrough room), PTZ pad
 *     with press-and-hold (ptz/dir repeated every 300 ms with hold_ms = the
 *     camera's deadman; release → ptz/stop), preset go-to, stream start/stop +
 *     HD, snapshot, voice test, reboot (inline confirm), the command log with
 *     phases and the event log with level/src filters;
 *   - an ALTA form (optionally creating the passthrough RTMP ingress first) and
 *     a config.ini download per camera.
 *
 * Data in: GET /apps/:app/plugins/cameras/cameras (+ /cameras/:device, events,
 * thumb). Pure shaping + formatting + the PTZ hold controller live in logic.ts.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { request, requestBlob, saveBlob } from '@/api/http'
import { HlsPlayer } from '@/components/player'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  PTZ_HOLD_MS,
  PtzHold,
  cameraCounts,
  filterCameras,
  formatAge,
  formatBytes,
  formatRssi,
  formatSdUsed,
  formatUptime,
  hasCap,
  isOpen,
  parseCameras,
  parseDetail,
  parseEvents,
  rssiBars,
  sitesOf,
  splitRtmpUrl,
  validDevice,
  type CameraDetail,
  type CameraFilter,
  type CameraView,
  type CommandRow,
  type EventRow,
  type PtzDir,
} from './logic.ts'

const LIST_POLL_MS = 4000
const DETAIL_POLL_MS = 3000
const EVENTS_POLL_MS = 5000

const base = (app: string) => `/apps/${encodeURIComponent(app)}/plugins/cameras`
const camPath = (app: string, device: string) => `${base(app)}/cameras/${encodeURIComponent(device)}`

function errText(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : fallback
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function usePoll<T>(
  url: string | null,
  ms: number,
  parse: (raw: unknown) => T,
): { data: T | null; error: boolean; refetch: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState(false)
  const tick = useRef<() => void>(() => {})
  const parseRef = useRef(parse)
  parseRef.current = parse

  useEffect(() => {
    setData(null)
    if (!url) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const res = await request<unknown>(url)
        if (!alive) return
        setData(parseRef.current(res))
        setError(false)
      } catch {
        if (!alive) return
        setError(true)
      }
      timer = setTimeout(run, ms)
    }
    tick.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void run()
    }
    void run()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [url, ms])

  return { data, error, refetch: () => tick.current() }
}

/** The retained thumbnail as an object URL (re-fetched when thumbAt moves). */
function useThumb(app: string, device: string, thumbAt: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!thumbAt) {
      setSrc(null)
      return
    }
    let alive = true
    let url: string | null = null
    requestBlob(`${camPath(app, device)}/thumb`)
      .then((blob) => {
        if (!alive || typeof URL.createObjectURL !== 'function') return
        url = URL.createObjectURL(blob)
        setSrc(url)
      })
      .catch(() => {
        if (alive) setSrc(null)
      })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [app, device, thumbAt])
  return src
}

// ---------------------------------------------------------------------------
// Presentational bits
// ---------------------------------------------------------------------------

function StatusBadge({ camera }: { camera: CameraView }) {
  const { t } = useTranslation('cameras')
  const tone =
    camera.status === 'online'
      ? 'bg-emerald-500/15 text-emerald-400'
      : camera.status === 'offline'
        ? 'bg-gray-700 text-gray-300'
        : 'bg-amber-500/15 text-amber-400'
  const dot =
    camera.status === 'online' ? 'bg-emerald-500' : camera.status === 'offline' ? 'bg-gray-400' : 'bg-amber-400'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {t(`status.${camera.status}`)}
    </span>
  )
}

function Bars({ rssi }: { rssi: number | null }) {
  const n = rssiBars(rssi)
  return (
    <span className="inline-flex items-end gap-0.5" aria-label={formatRssi(rssi)} title={formatRssi(rssi)}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-sm ${i <= n ? 'bg-emerald-400' : 'bg-gray-600'}`}
          style={{ height: `${3 + i * 3}px` }}
        />
      ))}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="truncate text-sm font-semibold text-fg tabular-nums">{value}</span>
    </div>
  )
}

function Thumb({ app, camera, className }: { app: string; camera: CameraView; className?: string }) {
  const { t } = useTranslation('cameras')
  const src = useThumb(app, camera.device, camera.thumbAt)
  return src ? (
    <img src={src} alt={camera.device} className={`object-cover ${className ?? ''}`} />
  ) : (
    <div className={`flex items-center justify-center bg-gray-900 text-[11px] text-gray-500 ${className ?? ''}`}>
      {t('card.noThumb')}
    </div>
  )
}

function CameraCard({
  app,
  camera,
  selected,
  onClick,
}: {
  app: string
  camera: CameraView
  selected: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('cameras')
  const s = camera.summary
  const where = [camera.site, camera.stand].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`camera-card-${camera.device}`}
      className={`flex flex-col overflow-hidden rounded-xl border text-left transition ${
        selected ? 'border-emerald-500 ring-1 ring-emerald-500/40' : 'border-gray-700 hover:border-emerald-400'
      }`}
    >
      <Thumb app={app} camera={camera} className="aspect-video w-full" />
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-sm font-semibold text-fg">{camera.name || camera.device}</span>
            {where ? <span className="truncate text-[11px] text-gray-400">{where}</span> : null}
          </div>
          <StatusBadge camera={camera} />
        </div>
        {s.safeMode ? (
          <div className="rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-400">
            {t('card.safeMode')}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Metric label={t('metric.fw')} value={camera.fw ?? '—'} />
          <Metric
            label={t('metric.signal')}
            value={
              <span className="inline-flex items-center gap-1.5">
                <Bars rssi={s.rssi} />
                <span className="text-[11px] text-gray-300">{s.rssi == null ? '—' : Math.round(s.rssi)}</span>
              </span>
            }
          />
          <Metric
            label={t('metric.stream')}
            value={
              s.streamRunning == null
                ? '—'
                : s.streamRunning
                  ? `${t('stream.on')}${s.streamSource === 0 ? ' · HD' : ''}`
                  : t('stream.off')
            }
          />
          <Metric label={t('metric.sd')} value={s.sdPresent === false ? t('sd.none') : formatSdUsed(s.sdFreeKb, s.sdTotalKb)} />
          <Metric label={t('metric.queue')} value={formatBytes(s.queueBytes)} />
          <Metric label={t('metric.seen')} value={formatAge(camera.ageMs)} />
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// PTZ pad
// ---------------------------------------------------------------------------

const PAD: (PtzDir | 'stop')[] = ['ul', 'up', 'ur', 'left', 'stop', 'right', 'dl', 'down', 'dr']
const ARROWS: Record<PtzDir | 'stop', string> = {
  ul: '↖',
  up: '↑',
  ur: '↗',
  left: '←',
  stop: '■',
  right: '→',
  dl: '↙',
  down: '↓',
  dr: '↘',
}

function PtzPad({ app, device, disabled, onSent }: { app: string; device: string; disabled: boolean; onSent: () => void }) {
  const { t } = useTranslation('cameras')
  const [speed, setSpeed] = useState(5)
  const [preset, setPreset] = useState('1')
  const [err, setErr] = useState<string | null>(null)
  const speedRef = useRef(speed)
  speedRef.current = speed
  const holdRef = useRef<PtzHold | null>(null)

  if (holdRef.current === null) {
    holdRef.current = new PtzHold(
      (dir) => {
        request(`${camPath(app, device)}/ptz/move`, {
          method: 'POST',
          body: { dir, speed: speedRef.current, holdMs: PTZ_HOLD_MS },
        }).catch((e) => setErr(errText(e, t('cmd.failed'))))
      },
      () => {
        request(`${camPath(app, device)}/ptz/stop`, { method: 'POST', body: {} })
          .then(onSent)
          .catch((e) => setErr(errText(e, t('cmd.failed'))))
      },
    )
  }

  useEffect(() => {
    const hold = holdRef.current
    return () => {
      // releasing the pad by navigating away still stops the camera
      hold?.stop()
      hold?.dispose()
    }
  }, [])

  const send = async (path: string, body: Record<string, unknown>) => {
    setErr(null)
    try {
      await request(`${camPath(app, device)}${path}`, { method: 'POST', body })
      onSent()
    } catch (e) {
      setErr(errText(e, t('cmd.failed')))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid grid-cols-3 gap-1" role="group" aria-label={t('ptz.pad')}>
          {PAD.map((d) =>
            d === 'stop' ? (
              <button
                key={d}
                type="button"
                disabled={disabled}
                data-testid="ptz-stop"
                onClick={() => {
                  holdRef.current?.stop()
                  void send('/ptz/stop', {})
                }}
                className="h-10 w-10 rounded-lg border border-gray-700 text-sm text-gray-300 transition hover:border-red-500 disabled:opacity-40"
                aria-label={t('ptz.stop')}
              >
                {ARROWS[d]}
              </button>
            ) : (
              <button
                key={d}
                type="button"
                disabled={disabled}
                data-testid={`ptz-${d}`}
                aria-label={t(`ptz.dir.${d}`)}
                onPointerDown={(e) => {
                  e.preventDefault()
                  setErr(null)
                  holdRef.current?.start(d)
                }}
                onPointerUp={() => holdRef.current?.stop()}
                onPointerLeave={() => holdRef.current?.stop()}
                onPointerCancel={() => holdRef.current?.stop()}
                onContextMenu={(e) => e.preventDefault()}
                className="h-10 w-10 touch-none select-none rounded-lg border border-gray-700 bg-gray-800 text-base text-fg transition hover:border-emerald-500 active:bg-emerald-600 disabled:opacity-40"
              >
                {ARROWS[d]}
              </button>
            ),
          )}
        </div>
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex items-center gap-2 text-gray-300">
            {t('ptz.speed')}
            <input
              type="range"
              min={1}
              max={10}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              aria-label={t('ptz.speed')}
            />
            <span className="w-4 tabular-nums">{speed}</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              aria-label={t('ptz.preset')}
              className="w-16 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs"
            />
            <button
              type="button"
              disabled={disabled || preset.trim() === ''}
              onClick={() => void send('/ptz/preset', { preset: Number(preset) })}
              className="rounded-lg border border-gray-700 px-3 py-1 text-xs text-gray-200 transition hover:border-emerald-500 disabled:opacity-40"
            >
              {t('ptz.goPreset')}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void send('/ptz/home', {})}
              className="rounded-lg border border-gray-700 px-3 py-1 text-xs text-gray-200 transition hover:border-emerald-500 disabled:opacity-40"
            >
              {t('ptz.home')}
            </button>
          </div>
          <p className="max-w-56 text-[11px] leading-snug text-gray-400">{t('ptz.hint')}</p>
        </div>
      </div>
      {err ? <p className="text-xs text-red-400">{err}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Actions (stream / HD / snapshot / voice / reboot)
// ---------------------------------------------------------------------------

const btn =
  'rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 border-gray-700 text-gray-200 hover:border-emerald-500'

function Actions({ app, camera, onSent }: { app: string; camera: CameraView; onSent: () => void }) {
  const { t } = useTranslation('cameras')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [confirmReboot, setConfirmReboot] = useState(false)
  const running = camera.summary.streamRunning === true
  const hdOn = camera.hdUntil !== null

  const send = useCallback(
    async (key: string, path: string, body: Record<string, unknown> = {}) => {
      setBusy(key)
      setMsg(null)
      try {
        const rec = await request<{ id?: string; command?: { id?: string } }>(`${camPath(app, camera.device)}${path}`, {
          method: 'POST',
          body,
        })
        const id = rec?.id ?? rec?.command?.id ?? ''
        setMsg({ kind: 'ok', text: t('cmd.queued', { command: t(`action.${key}`), id: id.slice(0, 8) }) })
        onSent()
      } catch (e) {
        setMsg({ kind: 'err', text: errText(e, t('cmd.failed')) })
      } finally {
        setBusy(null)
      }
    },
    [app, camera.device, onSent, t],
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void send(running ? 'streamStop' : 'streamStart', running ? '/stream/stop' : '/stream/start')}
          className={btn}
        >
          {running ? t('action.streamStop') : t('action.streamStart')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void send('hd', '/stream/hd', { on: !hdOn })}
          className={`${btn} ${hdOn ? 'border-emerald-600 text-emerald-400' : ''}`}
          data-testid="action-hd"
        >
          {hdOn ? t('action.hdOff') : t('action.hd')}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void send('snapshot', '/snapshot')} className={btn}>
          {t('action.snapshot')}
        </button>
        {hasCap(camera, 'voice') ? (
          <button type="button" disabled={busy !== null} onClick={() => void send('voiceTest', '/voice/test')} className={btn}>
            {t('action.voiceTest')}
          </button>
        ) : null}
        {confirmReboot ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-700/60 px-2 py-1 text-xs text-amber-400">
            {t('reboot.confirm')}
            <button
              type="button"
              data-testid="reboot-confirm"
              disabled={busy !== null}
              onClick={() => {
                setConfirmReboot(false)
                void send('reboot', '/reboot', { reason: 'streamhub-console' })
              }}
              className="rounded bg-amber-600 px-2 py-0.5 font-semibold text-white hover:bg-amber-500"
            >
              {t('reboot.yes')}
            </button>
            <button type="button" onClick={() => setConfirmReboot(false)} className="px-1 text-gray-300">
              {t('reboot.no')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="action-reboot"
            disabled={busy !== null}
            onClick={() => setConfirmReboot(true)}
            className="rounded-lg border border-amber-700/60 px-3 py-1.5 text-xs font-medium text-amber-400 transition hover:border-amber-500 disabled:opacity-50"
          >
            {t('action.reboot')}
          </button>
        )}
      </div>
      {hdOn ? (
        <p className="text-[11px] text-gray-400">
          {t('hd.until', { time: new Date(camera.hdUntil as string).toLocaleTimeString() })}
        </p>
      ) : null}
      {msg ? (
        <p data-testid="cmd-msg" className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}

function CommandLog({ commands }: { commands: CommandRow[] }) {
  const { t } = useTranslation('cameras')
  if (commands.length === 0) return <p className="text-xs text-gray-400">{t('detail.noCommands')}</p>
  const tone = (c: CommandRow) =>
    c.status === 'done'
      ? 'text-emerald-400'
      : c.status === 'failed' || c.status === 'timeout'
        ? 'text-red-400'
        : 'text-amber-400'
  return (
    <ul className="flex flex-col gap-1" data-testid="cmd-log">
      {commands.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-2 rounded-md bg-gray-800/60 px-2 py-1 text-[11px]">
          <span className="font-mono text-fg">{c.cmd}</span>
          <span className={tone(c)}>
            {t(`cmdStatus.${c.status}`)}
            {c.status === 'progress' && c.pct != null ? ` ${Math.round(c.pct)}%` : ''}
            {c.code && !isOpen(c.status) ? ` · ${c.code}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

const LEVELS = ['', 'info', 'warn', 'error', 'debug'] as const

function EventLog({ app, device }: { app: string; device: string }) {
  const { t } = useTranslation('cameras')
  const [level, setLevel] = useState('')
  const [src, setSrc] = useState('')
  const q = new URLSearchParams({ limit: '100' })
  if (level) q.set('level', level)
  if (src.trim()) q.set('src', src.trim())
  const { data } = usePoll<EventRow[]>(`${camPath(app, device)}/events?${q.toString()}`, EVENTS_POLL_MS, parseEvents)
  const events = data ?? []
  const tone = (l: string) => (l === 'error' ? 'text-red-400' : l === 'warn' ? 'text-amber-400' : 'text-gray-300')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('events.level')}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l ? l : t('events.allLevels')}
            </option>
          ))}
        </select>
        <input
          aria-label={t('events.src')}
          placeholder={t('events.src')}
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          className="w-28 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs"
        />
      </div>
      {events.length === 0 ? (
        <p className="text-xs text-gray-400">{t('events.empty')}</p>
      ) : (
        <div className="max-h-64 overflow-auto rounded-lg border border-gray-700">
          <table className="w-full text-left text-[11px]" data-testid="event-log">
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-gray-700/60 last:border-0">
                  <td className="whitespace-nowrap px-2 py-1 text-gray-400 tabular-nums">
                    {e.ts ? new Date(e.ts).toLocaleTimeString() : '—'}
                  </td>
                  <td className={`px-2 py-1 font-semibold ${tone(e.level)}`}>{e.level}</td>
                  <td className="px-2 py-1 font-mono text-gray-300">
                    {e.src ?? ''}
                    {e.event ? `/${e.event}` : ''}
                  </td>
                  <td className="px-2 py-1 text-gray-300">{e.msg ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      {children}
    </div>
  )
}

function CameraDetailView({ app, device, onClose }: { app: string; device: string; onClose: () => void }) {
  const { t } = useTranslation('cameras')
  const { data: detail, refetch } = usePoll<CameraDetail | null>(camPath(app, device), DETAIL_POLL_MS, parseDetail)
  const [iniErr, setIniErr] = useState<string | null>(null)
  const camera = detail?.camera
  const s = camera?.summary

  const downloadIni = async () => {
    setIniErr(null)
    try {
      const blob = await requestBlob(`${camPath(app, device)}/config.ini`)
      saveBlob(blob, `config-${device}.ini`)
    } catch (e) {
      setIniErr(errText(e, t('cmd.failed')))
    }
  }

  return (
    <aside className="flex flex-col gap-4 rounded-xl border border-gray-700 p-4" data-testid="camera-detail">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate font-mono text-sm font-semibold text-fg">{device}</h3>
          {camera ? <StatusBadge camera={camera} /> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-500"
        >
          {t('detail.close')}
        </button>
      </div>

      {camera ? (
        <>
          <div className="overflow-hidden rounded-lg border border-gray-700 bg-black">
            {camera.hlsPath && camera.summary.streamRunning !== false ? (
              <HlsPlayer src={camera.hlsPath} app={app} room={camera.room ?? undefined} />
            ) : (
              <div className="relative">
                <Thumb app={app} camera={camera} className="aspect-video w-full" />
                <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-0.5 text-[11px] text-gray-300">
                  {camera.hlsPath ? t('detail.streamStopped') : t('detail.noRoom')}
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Metric label={t('metric.fw')} value={camera.fw ?? '—'} />
            <Metric label={t('metric.uptime')} value={formatUptime(s?.uptimeS ?? null)} />
            <Metric label={t('metric.signal')} value={`${formatRssi(s?.rssi ?? null)}${s?.ssid ? ` · ${s.ssid}` : ''}`} />
            <Metric label={t('metric.ip')} value={s?.ip ?? '—'} />
            <Metric label={t('metric.mem')} value={s?.memFreeKb == null ? '—' : formatBytes(s.memFreeKb * 1024)} />
            <Metric label={t('metric.load')} value={s?.load1 == null ? '—' : s.load1.toFixed(2)} />
            <Metric label={t('metric.sd')} value={formatSdUsed(s?.sdFreeKb ?? null, s?.sdTotalKb ?? null)} />
            <Metric label={t('metric.queue')} value={`${s?.queueFiles ?? 0} · ${formatBytes(s?.queueBytes ?? null)}`} />
            <Metric label={t('metric.reboot')} value={s?.lastRebootReason ?? '—'} />
          </div>
          {camera.eventsLost > 0 ? (
            <p className="text-[11px] text-amber-400">{t('detail.eventsLost', { count: camera.eventsLost })}</p>
          ) : null}
          {!camera.online ? <p className="text-[11px] text-amber-400">{t('detail.offlineHint')}</p> : null}

          {hasCap(camera, 'ptz') ? (
            <Section title={t('detail.ptz')}>
              <PtzPad app={app} device={device} disabled={!camera.online} onSent={refetch} />
            </Section>
          ) : null}

          <Section title={t('detail.control')}>
            <Actions app={app} camera={camera} onSent={refetch} />
          </Section>

          <Section title={t('detail.commands')}>
            <CommandLog commands={detail?.commands ?? []} />
          </Section>

          <Section title={t('detail.events')}>
            <EventLog app={app} device={device} />
          </Section>

          <Section title={t('detail.provisioning')}>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
              <button type="button" onClick={() => void downloadIni()} className={btn} data-testid="download-ini">
                {t('detail.downloadIni')}
              </button>
              <span>{camera.provisioned ? t('detail.provisioned') : t('detail.discovered')}</span>
            </div>
            {iniErr ? <p className="text-xs text-red-400">{iniErr}</p> : null}
          </Section>
        </>
      ) : (
        <p className="text-xs text-gray-400">{t('detail.loading')}</p>
      )}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Alta (add camera)
// ---------------------------------------------------------------------------

interface IngressCreated {
  room?: string
  rtmpUrl?: string
  streamKey?: string
}

function AddCameraForm({ app, onDone }: { app: string; onDone: (device: string) => void }) {
  const { t } = useTranslation('cameras')
  const [f, setF] = useState({ device: '', name: '', site: '', stand: '', room: '' })
  const [createIngress, setCreateIngress] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF((o) => ({ ...o, [k]: e.target.value }))

  const submit = async () => {
    const device = f.device.trim()
    if (!validDevice(device)) {
      setErr(t('add.badDevice'))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      let room = f.room.trim() || device
      let streamUrl: string | undefined
      let streamKey: string | undefined
      if (createIngress) {
        const ing = await request<IngressCreated>(`/apps/${encodeURIComponent(app)}/ingress`, {
          method: 'POST',
          body: { mode: 'passthrough', inputType: 'rtmp', room },
        })
        if (ing?.room) room = ing.room
        if (ing?.rtmpUrl && ing.streamKey) {
          const split = splitRtmpUrl(ing.rtmpUrl, ing.streamKey)
          streamUrl = split.url
          streamKey = split.key
        }
      }
      const body: Record<string, unknown> = { device, room }
      for (const k of ['name', 'site', 'stand'] as const) if (f[k].trim()) body[k] = f[k].trim()
      if (streamUrl) body.streamUrl = streamUrl
      if (streamKey) body.streamKey = streamKey
      await request(`${base(app)}/cameras`, { method: 'POST', body })
      onDone(device)
    } catch (e) {
      setErr(errText(e, t('cmd.failed')))
    } finally {
      setBusy(false)
    }
  }

  const input = 'rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs'
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-700 p-4" data-testid="add-camera">
      <h3 className="text-sm font-semibold text-fg">{t('add.title')}</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <input aria-label={t('add.device')} placeholder={t('add.device')} value={f.device} onChange={set('device')} className={`${input} font-mono`} />
        <input aria-label={t('add.name')} placeholder={t('add.name')} value={f.name} onChange={set('name')} className={input} />
        <input aria-label={t('add.room')} placeholder={t('add.roomPh')} value={f.room} onChange={set('room')} className={input} />
        <input aria-label={t('add.site')} placeholder={t('add.site')} value={f.site} onChange={set('site')} className={input} />
        <input aria-label={t('add.stand')} placeholder={t('add.stand')} value={f.stand} onChange={set('stand')} className={input} />
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={createIngress} onChange={(e) => setCreateIngress(e.target.checked)} />
        {t('add.createIngress')}
      </label>
      <p className="text-[11px] leading-snug text-gray-400">{t('add.note')}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || f.device.trim() === ''}
          onClick={() => void submit()}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {t('add.submit')}
        </button>
        {err ? <span className="text-xs text-red-400">{err}</span> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function CamerasTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('cameras')
  const app = ctx.app ?? ''
  const { data, error, refetch } = usePoll(app ? `${base(app)}/cameras` : null, LIST_POLL_MS, parseCameras)
  const [filter, setFilter] = useState<CameraFilter>('all')
  const [site, setSite] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  if (!app) return null
  const cameras = data?.cameras ?? []
  const counts = cameraCounts(cameras)
  const shown = filterCameras(cameras, filter, site)
  const sites = sitesOf(cameras)

  return (
    <div className="flex flex-col gap-4">
      {data && !data.active ? (
        <div className="rounded-xl border border-amber-700/60 bg-amber-500/10 p-3 text-xs text-amber-300" data-testid="inactive">
          {t('inactive', { topic: data.baseTopic })}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-gray-700 p-0.5">
                {(['all', 'online', 'offline'] as CameraFilter[]).map((fl) => (
                  <button
                    key={fl}
                    type="button"
                    onClick={() => setFilter(fl)}
                    data-testid={`filter-${fl}`}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                      filter === fl ? 'bg-emerald-600 text-white' : 'text-gray-300 hover:text-emerald-400'
                    }`}
                  >
                    {t(`filter.${fl}`, { count: counts[fl] })}
                  </button>
                ))}
              </div>
              {sites.length > 0 ? (
                <select
                  aria-label={t('filter.site')}
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-xs"
                >
                  <option value="">{t('filter.allSites')}</option>
                  {sites.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {error ? <span className="text-xs text-red-400">{t('error.load')}</span> : null}
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                data-testid="add-toggle"
                className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:border-emerald-500"
              >
                {adding ? t('add.cancel') : t('add.open')}
              </button>
            </div>
          </div>

          {adding ? (
            <AddCameraForm
              app={app}
              onDone={(device) => {
                setAdding(false)
                setSelected(device)
                refetch()
              }}
            />
          ) : null}

          {shown.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-700 p-8 text-center text-sm text-gray-500">
              {t('empty')}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="camera-grid">
              {shown.map((c) => (
                <CameraCard
                  key={c.device}
                  app={app}
                  camera={c}
                  selected={selected === c.device}
                  onClick={() => setSelected(c.device)}
                />
              ))}
            </div>
          )}
        </section>

        {selected ? (
          <CameraDetailView key={selected} app={app} device={selected} onClose={() => setSelected(null)} />
        ) : (
          <aside className="hidden rounded-xl border border-dashed border-gray-700 p-6 text-center text-sm text-gray-400 lg:block">
            {t('detail.pick')}
          </aside>
        )}
      </div>
    </div>
  )
}

export default definePlugin({
  id: 'cameras',
  kind: 'app',
  name: 'Cameras — OpenCam Console',
  description:
    'Fleet console for OpenCam cameras over MQTT: inventory, online/offline, event log and remote ' +
    'control (PTZ, stream, HD, snapshot, voice, reboot) plus the provisioning config.ini.',
  category: 'tool',
  ui: 'app-tab',
  version: '0.1.0',
  icon: 'M3 8a2 2 0 012-2h1.5l1.5-2h8l1.5 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm9 9a4 4 0 100-8 4 4 0 000 8z',
  configSchema: {
    fields: [
      { key: 'baseTopic', type: 'string', label: 'MQTT base topic', default: 'opencam', placeholder: 'opencam' },
      { key: 'offlineAfterSec', type: 'number', label: 'Offline after (seconds)', default: 180, min: 30, max: 3600 },
      { key: 'commandExpSec', type: 'number', label: 'Command expiry (seconds)', default: 30, min: 5, max: 600 },
      {
        key: 'longCommandTimeoutSec',
        type: 'number',
        label: 'Long command timeout (seconds)',
        default: 900,
        min: 60,
        max: 7200,
      },
      { key: 'historyPoints', type: 'number', label: 'State history points per camera', default: 120, min: 10, max: 5000 },
      { key: 'eventsPerCamera', type: 'number', label: 'Events kept per camera', default: 2000, min: 100, max: 100000 },
      { key: 'hdRevertMin', type: 'number', label: 'HD revert (minutes)', default: 5, min: 1, max: 240 },
      {
        key: 'brokerPublicUrl',
        type: 'string',
        label: 'Broker URL for cameras',
        default: '',
        placeholder: 'mqtts://mqtt.example.com:8883',
      },
      {
        key: 'rtmpPublicUrl',
        type: 'string',
        label: 'Default RTMP URL for cameras',
        default: '',
        placeholder: 'rtmp://media.example.com:1935/live',
      },
      {
        key: 'iniUseAppBrokerCredentials',
        type: 'boolean',
        label: "config.ini uses the app's broker credentials",
        default: false,
      },
    ],
  },
  TabComponent: CamerasTab,
})
