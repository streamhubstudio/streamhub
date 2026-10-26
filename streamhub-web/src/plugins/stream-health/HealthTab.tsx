/**
 * Stream Health Monitor — the Studio App tab (React shell; every data
 * decision lives in logic.ts, node:test covered).
 *
 * Two sections (Studio deep-linkable via useSection):
 *   - monitor: at-a-glance grid of every live stream — status chip
 *     (healthy/degraded/critical, or stale when the worker feed is old),
 *     reasons, key facts + metrics. Click a card → drill-down with the full
 *     numbers, that room's recent events and the per-room THRESHOLD editor
 *     (PUT …/streams/:room/settings — applied live by the worker).
 *   - events: the recent health.* transition history (per-app db).
 *
 * Data in:
 *   GET  …/plugins/stream-health/live/state?room=overview   (worker feed)
 *   GET  …/plugins/stream-health/overview                   (db tiles)
 *   GET  …/plugins/stream-health/events[?room=]             (history)
 *   GET/PUT …/plugins/stream-health/streams/:room/settings  (thresholds)
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import type { PluginComponentProps } from '../types.ts'
import { useSection } from '../useSection.ts'
import {
  buildOverride,
  formFromOverride,
  formatAgo,
  formatDb,
  formatKbps,
  formatMs,
  formatResolution,
  parseOverviewLive,
  statusDot,
  statusTone,
  THRESHOLD_KEYS,
  THRESHOLD_BOUNDS,
  type StreamSnapshot,
  type ThresholdKey,
} from './logic.ts'

const POLL_MS = 5000
type Section = 'monitor' | 'events'
const SECTIONS: readonly Section[] = ['monitor', 'events']

interface EventRow {
  id: number
  room: string
  event: string
  status: string | null
  reasons: string | null
  ts: string
  data: Record<string, unknown>
}

interface SettingsView {
  room: string
  override: Partial<Record<ThresholdKey, number>>
  resolved: Record<ThresholdKey, number>
  updatedAt: string | null
}

const base = (app: string) => `/apps/${encodeURIComponent(app)}/plugins/stream-health`
const enc = encodeURIComponent

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function StatusChip({ status }: { status: StreamSnapshot['status'] }) {
  const { t } = useTranslation('streamHealth')
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusTone(status)}`}
    >
      <span className={`h-2 w-2 rounded-full ${statusDot(status)}`} />
      {t(`status.${status}`)}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-sm font-semibold text-fg tabular-nums">{value}</span>
    </div>
  )
}

function ReasonBadges({ reasons }: { reasons: string[] }) {
  const { t } = useTranslation('streamHealth')
  if (!reasons.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {reasons.map((r) => (
        <span
          key={r}
          className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400"
        >
          {t(`reason.${r}`, r)}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Threshold editor (per room)
// ---------------------------------------------------------------------------

function ThresholdEditor({ app, room }: { app: string; room: string }) {
  const { t } = useTranslation('streamHealth')
  const [view, setView] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<Partial<Record<ThresholdKey, string>>>({})
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<'ok' | 'err' | 'invalid' | null>(null)

  useEffect(() => {
    let alive = true
    setView(null)
    setNote(null)
    request<SettingsView>(`${base(app)}/streams/${enc(room)}/settings`)
      .then((v) => {
        if (!alive) return
        setView(v)
        setForm(formFromOverride(v.override))
      })
      .catch(() => alive && setView(null))
    return () => {
      alive = false
    }
  }, [app, room])

  const save = useCallback(async () => {
    const override = buildOverride(form)
    if (override === null) {
      setNote('invalid')
      return
    }
    setSaving(true)
    setNote(null)
    try {
      const v = await request<SettingsView>(
        `${base(app)}/streams/${enc(room)}/settings`,
        { method: 'PUT', body: { config: override } },
      )
      setView(v)
      setForm(formFromOverride(v.override))
      setNote('ok')
    } catch {
      setNote('err')
    } finally {
      setSaving(false)
    }
  }, [app, room, form])

  if (!view) return <p className="text-sm text-gray-400">{t('loading')}</p>

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('thresholds.hint')}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THRESHOLD_KEYS.map((key) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
              {t(`thresholds.${key}`)}
            </span>
            <input
              type="number"
              value={form[key] ?? ''}
              min={THRESHOLD_BOUNDS[key][0]}
              max={THRESHOLD_BOUNDS[key][1]}
              placeholder={String(view.resolved[key])}
              onChange={(e) =>
                setForm((f) => ({ ...f, [key]: e.target.value }))
              }
              className="rounded-lg border border-gray-200 bg-transparent px-2 py-1.5 text-sm text-fg dark:border-gray-700"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? t('actions.saving') : t('actions.save')}
        </button>
        {note === 'ok' && <span className="text-xs text-emerald-500">{t('savedOk')}</span>}
        {note === 'err' && <span className="text-xs text-red-500">{t('savedErr')}</span>}
        {note === 'invalid' && (
          <span className="text-xs text-amber-500">{t('savedInvalid')}</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Events table
// ---------------------------------------------------------------------------

function EventsTable({ app, room }: { app: string; room?: string }) {
  const { t } = useTranslation('streamHealth')
  const [rows, setRows] = useState<EventRow[]>([])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const res = await request<EventRow[]>(`${base(app)}/events`, {
          query: { limit: 100, room },
        })
        if (alive) setRows(Array.isArray(res) ? res : [])
      } catch {
        /* keep last */
      }
      if (alive) timer = setTimeout(run, POLL_MS)
    }
    void run()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, room])

  if (!rows.length) {
    return <p className="text-sm text-gray-400">{t('events.empty')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-gray-400">
            <th className="py-1.5 pr-4">{t('events.time')}</th>
            {!room && <th className="py-1.5 pr-4">{t('events.stream')}</th>}
            <th className="py-1.5 pr-4">{t('events.event')}</th>
            <th className="py-1.5">{t('events.detail')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
              <td className="whitespace-nowrap py-1.5 pr-4 text-gray-500 dark:text-gray-400">
                {new Date(r.ts).toLocaleString()}
              </td>
              {!room && <td className="py-1.5 pr-4 font-mono text-xs">{r.room}</td>}
              <td className="py-1.5 pr-4">
                <span className="font-mono text-xs">{r.event}</span>
              </td>
              <td className="py-1.5 text-xs text-gray-500 dark:text-gray-400">
                {r.reasons ?? (typeof r.data.reason === 'string' ? r.data.reason : '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monitor grid + drill-down
// ---------------------------------------------------------------------------

function StreamCard({
  snap,
  onClick,
}: {
  snap: StreamSnapshot
  onClick: () => void
}) {
  const { t } = useTranslation('streamHealth')
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`health-card-${snap.room}`}
      className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4 text-left transition hover:border-emerald-400 dark:border-gray-700"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm font-semibold text-fg">{snap.room}</span>
        <StatusChip status={snap.status} />
      </div>
      <ReasonBadges reasons={snap.reasons} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label={t('metric.resolution')} value={formatResolution(snap.facts)} />
        <Metric
          label={t('metric.codecs')}
          value={
            snap.facts
              ? `${snap.facts.videoCodec ?? '—'}/${snap.facts.audioCodec ?? t('metric.noAudio')}`
              : '—'
          }
        />
        <Metric label={t('metric.bitrate')} value={formatKbps(snap.metrics.measuredKbps)} />
        <Metric label={t('metric.volume')} value={formatDb(snap.metrics.meanDb)} />
        <Metric label={t('metric.desync')} value={formatMs(snap.metrics.desyncMs)} />
        <Metric
          label={t('metric.lastSegment')}
          value={formatAgo(snap.metrics.secondsSinceAdvance)}
        />
      </div>
    </button>
  )
}

function DrillDown({
  app,
  snap,
  onBack,
}: {
  app: string
  snap: StreamSnapshot
  onBack: () => void
}) {
  const { t } = useTranslation('streamHealth')
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:border-emerald-400 dark:border-gray-700 dark:text-gray-400"
        >
          ← {t('actions.back')}
        </button>
        <span className="font-mono text-base font-semibold text-fg">{snap.room}</span>
        <StatusChip status={snap.status} />
      </div>
      <ReasonBadges reasons={snap.reasons} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label={t('metric.resolution')} value={formatResolution(snap.facts)} />
        <Metric
          label={t('metric.codecs')}
          value={
            snap.facts
              ? `${snap.facts.videoCodec ?? '—'}/${snap.facts.audioCodec ?? t('metric.noAudio')}`
              : '—'
          }
        />
        <Metric label={t('metric.bitrate')} value={formatKbps(snap.metrics.measuredKbps)} />
        <Metric
          label={t('metric.baseline')}
          value={formatKbps(snap.metrics.baselineKbps)}
        />
        <Metric label={t('metric.volume')} value={formatDb(snap.metrics.meanDb)} />
        <Metric label={t('metric.desync')} value={formatMs(snap.metrics.desyncMs)} />
        <Metric
          label={t('metric.ccErrors')}
          value={snap.metrics.ccErrors === null ? '—' : String(snap.metrics.ccErrors)}
        />
        <Metric
          label={t('metric.lastSegment')}
          value={formatAgo(snap.metrics.secondsSinceAdvance)}
        />
      </div>
      <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <h3 className="mb-3 text-sm font-semibold text-fg">{t('thresholds.title')}</h3>
        <ThresholdEditor app={app} room={snap.room} />
      </section>
      <section className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <h3 className="mb-3 text-sm font-semibold text-fg">{t('events.roomTitle')}</h3>
        <EventsTable app={app} room={snap.room} />
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function HealthTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('streamHealth')
  const app = ctx.app ?? ''
  const [section, setSection] = useSection<Section>(ctx, SECTIONS, 'monitor')
  const [streams, setStreams] = useState<StreamSnapshot[]>([])
  const [stale, setStale] = useState(true)
  const [today, setToday] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!app) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const live = await request<{
          ts: number | null
          ageMs: number | null
          payload: unknown
        }>(`${base(app)}/live/state`, { query: { room: 'overview' } })
        if (!alive) return
        const parsed = parseOverviewLive(live)
        setStreams(parsed.streams)
        setStale(parsed.stale)
      } catch {
        if (alive) setStale(true)
      }
      try {
        const ov = await request<{ today: number }>(`${base(app)}/overview`)
        if (alive) setToday(ov.today)
      } catch {
        /* keep last */
      }
      if (alive) timer = setTimeout(run, POLL_MS)
    }
    void run()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app])

  const current = selected
    ? (streams.find((s) => s.room === selected) ?? null)
    : null

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <nav className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSelected(null)
                setSection(s)
              }}
              className={`rounded-md px-3 py-1 text-sm font-medium ${
                section === s
                  ? 'bg-white text-fg shadow dark:bg-gray-900'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {t(`section.${s}`)}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
          {today !== null && <span>{t('tiles.today', { count: today })}</span>}
          <span>{t('tiles.tracked', { count: streams.length })}</span>
          {stale && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
              {t('tiles.stale')}
            </span>
          )}
        </div>
      </div>

      {section === 'events' ? (
        <EventsTable app={app} />
      ) : current ? (
        <DrillDown app={app} snap={current} onBack={() => setSelected(null)} />
      ) : streams.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400 dark:border-gray-700">
          {stale ? t('noFeed') : t('noStreams')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {streams.map((s) => (
            <StreamCard key={s.room} snap={s} onClick={() => setSelected(s.room)} />
          ))}
        </div>
      )}
    </div>
  )
}
