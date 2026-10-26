/**
 * Frontend plugin: perimeter — after-hours intrusion detection (app tab).
 *
 * Auto-discovered (src/plugins/perimeter/index.tsx default-export). Mirrors
 * the streamhub-core `perimeter` plugin's config so the Marketplace renders
 * the generic settings form, and ships the TabComponent with:
 *
 *   - an ARMED-state indicator + arm/disarm control (writes `armMode` via the
 *     plugin config PATCH — the worker restarts with the new mode);
 *   - a ZONE EDITOR: drag rectangles over the live frame preview (the worker
 *     pushes a small base64 frame + live person boxes through the live-data
 *     channel), rename/delete, then save (`zones` config JSON);
 *   - the ALERT QUEUE: recent intrusions with snapshot thumbnails; the
 *     acknowledge button PATCHes `ackThrough=<alert ts>` and the restarted
 *     worker marks that alert AND OLDER ones acked in perimeter.db.
 *
 * Data in: the AUTHENTICATED live read GET :id/live/state (armed state, zone
 * layout and alerts are security-sensitive — never the public overlay read).
 * All pure logic (zone JSON ⇄ editor model, drag commit, payload validation)
 * lives in logic.ts (node:test-covered); this file is the thin React shell.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import { definePlugin } from '../../plugins/types.ts'
import type { PluginComponentProps } from '../../plugins/types.ts'
import { useUpdatePluginConfig } from '../../plugins/usePlugins.ts'
import {
  clamp01,
  formatConfidence,
  nextZoneId,
  parseStatus,
  parseZonesConfig,
  pointsToSvg,
  rectToZone,
  resolveArmMode,
  resolveRoom,
  zonesToConfig,
  type ArmMode,
  type PerimeterStatus,
  type Zone,
} from './logic.ts'

const POLL_MS = 2500
/** Older than this the worker feed is reported as stale/offline. */
const STALE_MS = 10_000

interface LiveResponse {
  ts: number | null
  ageMs: number | null
  payload: unknown
}

// ---------------------------------------------------------------------------
// Live status poll (authenticated live/state endpoint)
// ---------------------------------------------------------------------------

function usePerimeterStatus(
  app: string,
  room: string,
): { status: PerimeterStatus | null; stale: boolean } {
  const [status, setStatus] = useState<PerimeterStatus | null>(null)
  const [stale, setStale] = useState(true)

  useEffect(() => {
    if (!app || !room) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await request<LiveResponse>(
          `/apps/${encodeURIComponent(app)}/plugins/perimeter/live/state`,
          { query: { room } },
        )
        if (!alive) return
        const fresh = typeof res?.ageMs === 'number' && res.ageMs <= STALE_MS
        const parsed = parseStatus(res?.payload)
        if (parsed) setStatus(parsed)
        setStale(!fresh || !parsed)
      } catch {
        if (!alive) return
        setStale(true)
      }
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, room])

  return { status, stale }
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function ArmBadge({
  status,
  stale,
}: {
  status: PerimeterStatus | null
  stale: boolean
}) {
  const { t } = useTranslation('perimeter')
  if (!status || stale) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-200 px-3 py-1 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300">
        <span className="h-2 w-2 rounded-full bg-gray-400" />
        {t('badge.offline')}
      </span>
    )
  }
  return status.armed ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 text-xs font-semibold text-red-600 dark:text-red-400">
      <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
      {t('badge.armed')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
      {t('badge.disarmed')}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function PerimeterTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('perimeter')
  const app = ctx.app ?? ''
  const room = resolveRoom(ctx.config)
  const armMode = resolveArmMode(ctx.config)
  const save = useUpdatePluginConfig(app)
  const { status, stale } = usePerimeterStatus(app, room)

  // Zone editor state, seeded from the saved config; while the editor is
  // dirty a background config refresh must not clobber unsaved drawing.
  const [zones, setZones] = useState<Zone[]>(() =>
    parseZonesConfig(ctx.config.zones),
  )
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) setZones(parseZonesConfig(ctx.config.zones))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.config.zones])

  // Drag-to-draw state (normalized coords).
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<{
    a: { x: number; y: number }
    b: { x: number; y: number }
  } | null>(null)

  const toNorm = (e: React.MouseEvent): { x: number; y: number } => {
    const box = stageRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 }
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    }
  }

  const commitDraft = () => {
    if (!draft) return
    const zone = rectToZone(draft.a, draft.b, nextZoneId(zones))
    setDraft(null)
    if (!zone) return
    setZones((zs) => [...zs, zone])
    setDirty(true)
  }

  const setArmMode = (mode: ArmMode) => {
    if (mode !== armMode) save.mutate({ id: 'perimeter', config: { armMode: mode } })
  }

  const acknowledge = (ts: number) => {
    save.mutate({ id: 'perimeter', config: { ackThrough: String(ts) } })
  }

  if (!app) return null

  const alerts = status?.alerts ?? []
  const busy = save.isPending

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      {/* Zone editor over the live frame */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-fg">{t('zones.title')}</h2>
            <ArmBadge status={status} stale={stale} />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
            {(['schedule', 'armed', 'disarmed'] as ArmMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={busy}
                onClick={() => setArmMode(mode)}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  armMode === mode
                    ? mode === 'armed'
                      ? 'bg-red-500/15 font-semibold text-red-600 dark:text-red-400'
                      : mode === 'disarmed'
                        ? 'bg-emerald-500/15 font-semibold text-emerald-600 dark:text-emerald-400'
                        : 'bg-gray-200 font-semibold text-fg dark:bg-gray-700'
                    : 'text-gray-500 hover:text-fg dark:text-gray-400'
                }`}
              >
                {t(`mode.${mode}`)}
              </button>
            ))}
          </div>
        </div>

        {!room && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t('zones.noRoom')}
          </p>
        )}

        <div
          ref={stageRef}
          className="relative aspect-video w-full cursor-crosshair select-none overflow-hidden rounded-xl border border-gray-200 bg-black dark:border-gray-700"
          onMouseDown={(e) => {
            e.preventDefault()
            const p = toNorm(e)
            setDraft({ a: p, b: p })
          }}
          onMouseMove={(e) => {
            if (draft) setDraft({ a: draft.a, b: toNorm(e) })
          }}
          onMouseUp={commitDraft}
          onMouseLeave={() => setDraft(null)}
          role="application"
          aria-label={t('zones.stageAria')}
        >
          {status?.frame ? (
            <img
              src={`data:image/jpeg;base64,${status.frame}`}
              alt={t('zones.frameAlt')}
              className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-90"
              draggable={false}
            />
          ) : (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-500">
              {t('zones.noFrame')}
            </div>
          )}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {zones.map((zone) => (
              <polygon
                key={zone.id}
                points={pointsToSvg(zone.points)}
                fill="rgba(239, 68, 68, 0.18)"
                stroke="rgba(239, 68, 68, 0.9)"
                strokeWidth="0.4"
              />
            ))}
            {(status?.persons ?? []).map((person, i) => {
              const [x, y, w, h] = person.bbox
              return (
                <rect
                  key={i}
                  x={x * 100}
                  y={y * 100}
                  width={w * 100}
                  height={h * 100}
                  fill="none"
                  stroke="rgba(74, 222, 128, 0.95)"
                  strokeWidth="0.5"
                />
              )
            })}
            {draft && (
              <rect
                x={Math.min(draft.a.x, draft.b.x) * 100}
                y={Math.min(draft.a.y, draft.b.y) * 100}
                width={Math.abs(draft.a.x - draft.b.x) * 100}
                height={Math.abs(draft.a.y - draft.b.y) * 100}
                fill="rgba(59, 130, 246, 0.15)"
                stroke="rgba(59, 130, 246, 0.9)"
                strokeWidth="0.4"
                strokeDasharray="1.5 1"
              />
            )}
          </svg>
        </div>
        <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          {t('zones.hint')}
        </p>

        {/* Zone list + save */}
        <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          {zones.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('zones.empty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {zones.map((zone, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-red-500/70" />
                  <input
                    value={zone.id}
                    onChange={(e) => {
                      const id = e.target.value
                      setZones((zs) =>
                        zs.map((z, j) => (j === i ? { ...z, id } : z)),
                      )
                      setDirty(true)
                    }}
                    className="w-40 rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs text-fg dark:border-gray-700"
                    aria-label={t('zones.nameAria')}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setZones((zs) => zs.filter((_, j) => j !== i))
                      setDirty(true)
                    }}
                    className="rounded-md px-2 py-1 text-xs text-gray-500 transition hover:text-red-500"
                  >
                    {t('zones.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dirty && (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  save.mutate(
                    { id: 'perimeter', config: { zones: zonesToConfig(zones) } },
                    { onSuccess: () => setDirty(false) },
                  )
                }
                className="rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-500 disabled:opacity-50"
              >
                {busy ? t('zones.saving') : t('zones.save')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setZones(parseZonesConfig(ctx.config.zones))
                  setDirty(false)
                }}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition hover:text-fg dark:border-gray-700 dark:text-gray-300"
              >
                {t('zones.discard')}
              </button>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                {t('zones.saveNote')}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Alert queue */}
      <aside className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">{t('alerts.title')}</h2>
          {status && status.unacked > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
              {t('alerts.unacked', { count: status.unacked })}
            </span>
          )}
        </div>
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          {alerts.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
              {stale ? t('alerts.offline') : t('alerts.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
              {alerts.map((alert) => (
                <li
                  key={`${alert.id}-${alert.ts}`}
                  className={`flex items-center gap-3 px-3 py-2.5 ${alert.acked ? 'opacity-55' : ''}`}
                >
                  {alert.thumb ? (
                    <img
                      src={`data:image/jpeg;base64,${alert.thumb}`}
                      alt={t('alerts.thumbAlt', { zone: alert.zone })}
                      className="h-12 w-20 shrink-0 rounded-md border border-gray-200 object-cover dark:border-gray-700"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-md bg-gray-100 text-[10px] text-gray-400 dark:bg-gray-700/60">
                      {t('alerts.noThumb')}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-fg">
                      {alert.zone}
                      <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
                        {formatConfidence(alert.confidence)}
                      </span>
                    </p>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400">
                      {new Date(alert.ts * 1000).toLocaleString()}
                    </p>
                  </div>
                  {alert.acked ? (
                    <span className="shrink-0 rounded-md bg-gray-100 px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-700/60 dark:text-gray-400">
                      {t('alerts.acked')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => acknowledge(alert.ts)}
                      className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
                    >
                      {t('alerts.ack')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          {t('alerts.ackNote')}
        </p>
      </aside>
    </div>
  )
}

export default definePlugin({
  id: 'perimeter',
  kind: 'app',
  edge: true,
  name: 'Perimeter — Intrusion Detection',
  description:
    'Watches restricted zones on a live camera and, while armed (schedule or manual), alerts on any person inside them — with evidence and an acknowledgeable alert queue.',
  category: 'security',
  ui: 'app-tab',
  version: '0.1.0',
  icon: 'M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z M12 8.5v4 M12 15.5h.01',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / camera', required: true },
      { key: 'zones', type: 'string', label: 'Restricted zones (JSON)', default: '[]' },
      {
        key: 'armMode',
        type: 'select',
        label: 'Arming',
        default: 'schedule',
        options: [
          { value: 'schedule', label: 'Follow schedule' },
          { value: 'armed', label: 'Armed (manual override)' },
          { value: 'disarmed', label: 'Disarmed (manual override)' },
        ],
      },
      {
        key: 'armSchedule',
        type: 'string',
        label: 'Armed window (daily)',
        default: '22:00-06:00',
        placeholder: '22:00-06:00',
      },
      { key: 'armWeekends', type: 'boolean', label: 'Armed all weekend', default: true },
      {
        key: 'timezone',
        type: 'string',
        label: 'Schedule timezone',
        default: '',
        placeholder: 'America/Argentina/Buenos_Aires',
      },
      {
        key: 'confidence',
        type: 'number',
        label: 'Person confidence',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 1, min: 0.1, max: 10, step: 0.5 },
      {
        key: 'cooldown',
        type: 'number',
        label: 'Per-zone cooldown (s)',
        default: 60,
        min: 1,
        max: 3600,
        step: 1,
      },
      {
        key: 'clipSeconds',
        type: 'number',
        label: 'Evidence clip length (s)',
        default: 10,
        min: 0,
        max: 60,
        step: 1,
      },
      {
        key: 'anchor',
        type: 'select',
        label: 'Trigger point',
        default: 'foot',
        options: [
          { value: 'foot', label: 'Feet (bottom-center)' },
          { value: 'center', label: 'Box center' },
        ],
      },
      {
        key: 'model',
        type: 'select',
        label: 'Model size',
        default: 'nano',
        options: [
          { value: 'nano', label: 'Nano (CPU-friendly)' },
          { value: 'small', label: 'Small (2x CPU)' },
        ],
      },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
      { key: 'callbackUrl', type: 'url', label: 'Alert webhook URL', default: '' },
      { key: 'callbackSecret', type: 'secret', label: 'Webhook HMAC secret', default: '' },
      { key: 'ackThrough', type: 'string', label: 'Acknowledged through (ts)', default: '' },
    ],
  },
  TabComponent: PerimeterTab,
})
