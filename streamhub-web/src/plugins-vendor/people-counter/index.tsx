/**
 * Frontend plugin: people-counter — realtime line-crossing counting (app tab).
 *
 * Auto-discovered (src/plugins/people-counter/index.tsx default-export).
 * Mirrors the streamhub-core `people-counter` plugin's config so the
 * Marketplace renders the generic settings form, and ships the TabComponent:
 *
 *   - the LIVE HLS player with a canvas overlay (LineEditor) where the
 *     operator DRAWS the counting line on the video (owner requirement),
 *     sees its orientation and the rotatable/flippable IN arrow, and SAVES —
 *     persisted via the plugin config PATCH as normalized 0–1 coords
 *     (lineX1..lineY2 + inDirection), which restarts the worker on the spot;
 *   - a live counters panel (IN / OUT / current occupancy vs capacity) fed by
 *     the worker's structured `counters` log lines (GET :id/logs, poll), plus
 *     the worker status.
 *
 * Pure geometry/parsing lives in line.util.ts (node:test-covered); the
 * draw→save flow is covered by the vitest component suite (LineEditor.test).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import { HlsPlayer } from '@/components/player'
import { pluginsApi } from '../../plugins/api.ts'
import { definePlugin } from '../../plugins/types.ts'
import type { PluginComponentProps } from '../../plugins/types.ts'
import { LineEditor } from './LineEditor.tsx'
import {
  angleDeg,
  flipDirection,
  lineToPatch,
  parseCounters,
  resolveInDirection,
  resolveLine,
  sameLine,
  type Counters,
  type InDirection,
  type LineValue,
} from './line.util.ts'

const COUNTERS_POLL_MS = 3000

// ---------------------------------------------------------------------------
// Live counters: poll the worker logs for the latest `counters` line
// ---------------------------------------------------------------------------

interface LogsResponse {
  worker?: { status?: string }
  workerLogs?: { ts?: string; stream?: string; line?: string }[]
}

function useLiveCounters(
  app: string | undefined,
  pluginId: string,
): { counters: Counters | null; workerStatus: string } {
  const [counters, setCounters] = useState<Counters | null>(null)
  const [workerStatus, setWorkerStatus] = useState('unknown')

  useEffect(() => {
    if (!app) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await request<LogsResponse>(
          `/apps/${encodeURIComponent(app)}/plugins/${encodeURIComponent(pluginId)}/logs`,
          { query: { limit: 120 } },
        )
        if (!alive) return
        setWorkerStatus(res?.worker?.status ?? 'stopped')
        const parsed = parseCounters(res?.workerLogs)
        if (parsed) setCounters(parsed)
      } catch {
        if (!alive) return
        setWorkerStatus('unknown')
      }
      timer = setTimeout(tick, COUNTERS_POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, pluginId])

  return { counters, workerStatus }
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function CounterStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: 'in' | 'out' | 'occupancy'
}) {
  const color =
    tone === 'in'
      ? 'text-emerald-400'
      : tone === 'out'
        ? 'text-red-400'
        : 'text-amber-300'
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-center">
      <div className={`font-mono text-2xl font-bold ${color}`}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide opacity-70">
        {label}
      </div>
    </div>
  )
}

function PeopleCounterTab({ ctx, pluginId }: PluginComponentProps) {
  const { t } = useTranslation('peopleCounter')
  const app = ctx.app ?? ''
  const room = typeof ctx.config.room === 'string' ? ctx.config.room : ''

  // Saved values (from config) vs the draft being edited on the canvas.
  const savedLine = useMemo(() => resolveLine(ctx.config), [ctx.config])
  const savedDir = useMemo(() => resolveInDirection(ctx.config), [ctx.config])
  const [line, setLine] = useState<LineValue>(savedLine)
  const [inDirection, setInDirection] = useState<InDirection>(savedDir)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  // Re-sync the draft when the persisted config changes (e.g. saved elsewhere).
  const savedKey = `${savedLine.x1},${savedLine.y1},${savedLine.x2},${savedLine.y2},${savedDir}`
  const lastSyncRef = useRef(savedKey)
  useEffect(() => {
    if (lastSyncRef.current !== savedKey) {
      lastSyncRef.current = savedKey
      setLine(savedLine)
      setInDirection(savedDir)
    }
  }, [savedKey, savedLine, savedDir])

  const dirty = !sameLine(line, savedLine) || inDirection !== savedDir
  const { counters, workerStatus } = useLiveCounters(app, pluginId)

  const save = useCallback(async () => {
    if (!app) return
    setSaving(true)
    setSaveError(false)
    try {
      await pluginsApi.config(app, pluginId, lineToPatch(line, inDirection))
      lastSyncRef.current = `${line.x1},${line.y1},${line.x2},${line.y2},${inDirection}`
      setEditing(false)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }, [app, pluginId, line, inDirection])

  const capacity = counters?.capacity ?? (Number(ctx.config.capacity) || 0)
  const overCapacity =
    capacity > 0 && (counters?.occupancy ?? 0) >= capacity

  if (!room) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
        {t('noRoom')}
      </div>
    )
  }

  const hlsSrc = `/hls/${encodeURIComponent(app)}/${encodeURIComponent(room)}/index.m3u8`

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Live video + the drawn counting line */}
      <div className="min-w-0 flex-1">
        <div className="relative overflow-hidden rounded-lg">
          <HlsPlayer src={hlsSrc} autoplay className="w-full" />
          <LineEditor
            line={line}
            inDirection={inDirection}
            editable={editing}
            onChange={setLine}
            labels={{ in: t('arrow.in'), out: t('arrow.out') }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              editing
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-white/10 hover:bg-white/15'
            }`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? t('actions.done') : t('actions.edit')}
          </button>
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/15"
            onClick={() => setInDirection(flipDirection(inDirection))}
          >
            {t('actions.flip')}
          </button>
          <button
            type="button"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? t('actions.saving') : t('actions.save')}
          </button>
          <span className="text-xs opacity-60">
            {t('lineInfo', {
              angle: angleDeg(line),
              side: t(`side.${inDirection}`),
            })}
          </span>
        </div>
        {editing && (
          <p className="mt-2 text-xs opacity-60">{t('editHint')}</p>
        )}
        {saveError && (
          <p className="mt-2 text-xs text-red-400">{t('saveError')}</p>
        )}
      </div>

      {/* Live counters panel */}
      <div className="w-full shrink-0 lg:w-64">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('counters.title')}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              workerStatus === 'running'
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-white/10 opacity-70'
            }`}
          >
            {t(`worker.${workerStatus}`, { defaultValue: workerStatus })}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
          <CounterStat label={t('counters.in')} value={counters?.in ?? '—'} tone="in" />
          <CounterStat
            label={t('counters.out')}
            value={counters?.out ?? '—'}
            tone="out"
          />
          <CounterStat
            label={t('counters.occupancy')}
            value={
              capacity > 0
                ? `${counters?.occupancy ?? '—'} / ${capacity}`
                : (counters?.occupancy ?? '—')
            }
            tone="occupancy"
          />
        </div>
        {overCapacity && (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {t('counters.overCapacity')}
          </div>
        )}
      </div>
    </div>
  )
}

export default definePlugin({
  id: 'people-counter',
  kind: 'app',
  edge: true,
  name: 'People Counter',
  description:
    'Counts people crossing a line drawn on the live video (YOLOv8 + ByteTrack): IN/OUT, live occupancy and capacity alerts.',
  category: 'analytics',
  ui: 'app-tab',
  icon: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8 M22 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  version: '0.1.0',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / stream', required: true },
      { key: 'lineX1', type: 'number', label: 'Line start X (0–1)', default: 0.2, min: 0, max: 1, step: 0.01 },
      { key: 'lineY1', type: 'number', label: 'Line start Y (0–1)', default: 0.5, min: 0, max: 1, step: 0.01 },
      { key: 'lineX2', type: 'number', label: 'Line end X (0–1)', default: 0.8, min: 0, max: 1, step: 0.01 },
      { key: 'lineY2', type: 'number', label: 'Line end Y (0–1)', default: 0.5, min: 0, max: 1, step: 0.01 },
      {
        key: 'inDirection',
        type: 'select',
        label: '"In" side of the line',
        default: 'right',
        options: [
          { value: 'right', label: 'Right of start→end (arrow side)' },
          { value: 'left', label: 'Left of start→end (flipped)' },
        ],
      },
      { key: 'capacity', type: 'number', label: 'Capacity alert threshold', default: 0, min: 0, step: 1 },
      { key: 'fps', type: 'number', label: 'Sample FPS', default: 5, min: 0.1, max: 30, step: 0.5 },
      {
        key: 'model',
        type: 'select',
        label: 'Model size',
        default: 'nano',
        options: [
          { value: 'nano', label: 'Nano (fastest, CPU-friendly)' },
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium (GPU recommended)' },
          { value: 'large', label: 'Large (GPU)' },
          { value: 'xlarge', label: 'XLarge (GPU)' },
        ],
      },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
      { key: 'confidence', type: 'number', label: 'Detection confidence', default: 0.3, min: 0, max: 1, step: 0.05 },
      { key: 'callbackUrl', type: 'url', label: 'Events callback URL', default: '' },
      { key: 'callbackSecret', type: 'secret', label: 'Callback signing secret', default: '' },
    ],
  },
  TabComponent: PeopleCounterTab,
})
