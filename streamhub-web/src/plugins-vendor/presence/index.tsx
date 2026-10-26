/**
 * Frontend plugin: presence — workstation-presence monitoring (app-tab).
 *
 * Auto-discovered (src/plugins/presence/index.tsx default-export) — no central
 * edit. Mirrors the streamhub-core `presence` plugin's config so the
 * Marketplace renders the generic settings form, and ships the TabComponent
 * with the two surfaces:
 *
 *   (a) ZONE EDITOR — draws normalized rects over a live HLS frame (hls.js
 *       into a bare <video>, overlay handles the pointer drags); Save PATCHes
 *       the plugin config (`zones` JSON) like every other plugin.
 *   (b) PRESENCE TIMELINE — polls the authenticated framework data route
 *       (GET /apps/:app/plugins/presence/data?room=…), which serves the
 *       latest state the worker pushed to the live-data channel: per-zone
 *       occupancy now, the occupancy step-function timeline and recent
 *       absent/returned/after-hours events.
 *
 * All pure logic (zone JSON, rect math, payload parsing, timeline segments)
 * lives in logic.ts (node:test-covered); this file is the thin React shell.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import { request } from '@/api/http'
import { pluginsApi } from '../../plugins/api.ts'
import { definePlugin } from '../../plugins/types.ts'
import type { PluginComponentProps } from '../../plugins/types.ts'
import { Button, ErrorBanner, TextInput, errMessage } from '../../plugins/ui.tsx'
import {
  EVENT_LABELS,
  formatClock,
  formatDuration,
  hitZone,
  nextZoneId,
  parseLivePayload,
  parseZones,
  rectFromDrag,
  serializeZones,
  zoneColor,
  zoneSegments,
  type PresenceState,
  type ZoneRect,
} from './logic.ts'

const POLL_MS = 3000
const STALE_MS = 15_000
const TIMELINE_WINDOW_S = 3600

interface LiveResponse {
  ts: number | null
  ageMs: number | null
  payload: unknown
}

// ---------------------------------------------------------------------------
// Live state poll (authenticated framework data route)
// ---------------------------------------------------------------------------

function usePresenceState(
  app: string | undefined,
  pluginId: string,
  room: string,
): { state: PresenceState | null; stale: boolean; offline: boolean } {
  const [state, setState] = useState<PresenceState | null>(null)
  const [stale, setStale] = useState(false)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (!app || !room) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await request<LiveResponse>(
          `/apps/${encodeURIComponent(app)}/plugins/${encodeURIComponent(pluginId)}/data`,
          { query: { room } },
        )
        if (!alive) return
        setOffline(false)
        setStale(typeof res?.ageMs === 'number' ? res.ageMs > STALE_MS : true)
        const parsed = parseLivePayload(res?.payload)
        if (parsed) setState(parsed)
      } catch {
        if (!alive) return
        setOffline(true) // 404 = worker disabled/never pushed; network error
      }
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [app, pluginId, room])

  return { state, stale, offline }
}

// ---------------------------------------------------------------------------
// Zone editor — live HLS frame + drag-to-draw rect overlay
// ---------------------------------------------------------------------------

function ZoneEditor({
  hlsUrl,
  zones,
  selected,
  personsByZone,
  onSelect,
  onDraw,
}: {
  hlsUrl: string
  zones: ZoneRect[]
  selected: string | null
  personsByZone: Record<string, number>
  onSelect: (id: string | null) => void
  onDraw: (rect: { x: number; y: number; w: number; h: number }) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [aspect, setAspect] = useState('16 / 9')
  const [hasVideo, setHasVideo] = useState(false)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // Attach the live HLS playlist (hls.js, or native HLS on Safari).
  useEffect(() => {
    const video = videoRef.current
    if (!video || !hlsUrl) return
    let hls: Hls | null = null
    const onMeta = () => {
      if (video.videoWidth && video.videoHeight) {
        setAspect(`${video.videoWidth} / ${video.videoHeight}`)
      }
      setHasVideo(true)
    }
    video.addEventListener('loadedmetadata', onMeta)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl
    } else if (Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true })
      hls.loadSource(hlsUrl)
      hls.attachMedia(video)
    }
    return () => {
      video.removeEventListener('loadedmetadata', onMeta)
      hls?.destroy()
      video.removeAttribute('src')
    }
  }, [hlsUrl])

  const toFrac = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const box = surfaceRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - box.left) / Math.max(1, box.width),
      y: (e.clientY - box.top) / Math.max(1, box.height),
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dragStart.current = toFrac(e)
    setDraft(null)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return
    setDraft(rectFromDrag(dragStart.current, toFrac(e)))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const start = dragStart.current
    dragStart.current = null
    setDraft(null)
    if (!start) return
    const rect = rectFromDrag(start, toFrac(e))
    if (rect) {
      onDraw(rect)
    } else {
      // A plain click: select the zone under the cursor (or clear).
      const p = toFrac(e)
      onSelect(hitZone(zones, p.x, p.y))
    }
  }

  return (
    <div
      ref={surfaceRef}
      className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-gray-950"
      style={{ aspectRatio: aspect }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="application"
      aria-label="Zone editor — drag to draw a zone"
    >
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      {!hasVideo && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:10%_10%]">
          <span className="rounded bg-black/60 px-2 py-1 text-xs text-gray-300">
            No live frame — start the stream, or draw zones over the grid
          </span>
        </div>
      )}
      {zones.map((z, i) => {
        const color = zoneColor(i)
        const persons = personsByZone[z.id] ?? 0
        const isSel = z.id === selected
        return (
          <div
            key={z.id}
            className="absolute"
            style={{
              left: `${z.x * 100}%`,
              top: `${z.y * 100}%`,
              width: `${z.w * 100}%`,
              height: `${z.h * 100}%`,
              border: `2px ${isSel ? 'solid' : 'dashed'} ${color}`,
              backgroundColor: `${color}${isSel ? '33' : '1a'}`,
            }}
          >
            <span
              className="absolute left-0 top-0 max-w-full truncate rounded-br px-1 font-mono text-[10px] leading-4 text-black"
              style={{ backgroundColor: color }}
            >
              {z.name}
              {persons > 0 ? ` · ${persons}` : ''}
            </span>
          </div>
        )
      })}
      {draft && (
        <div
          className="absolute border-2 border-white/80 bg-white/10"
          style={{
            left: `${draft.x * 100}%`,
            top: `${draft.y * 100}%`,
            width: `${draft.w * 100}%`,
            height: `${draft.h * 100}%`,
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-zone occupancy timeline (step-function segments over the last hour)
// ---------------------------------------------------------------------------

function Timeline({ state }: { state: PresenceState }) {
  const now = state.ts
  return (
    <div className="space-y-2">
      {state.zones.map((z, i) => {
        const segs = zoneSegments(state.timeline, z.id, TIMELINE_WINDOW_S, now)
        const color = zoneColor(i)
        return (
          <div key={z.id} className="flex items-center gap-3">
            <span
              className="w-28 shrink-0 truncate text-xs text-gray-500 dark:text-gray-400"
              title={z.name}
            >
              {z.name}
            </span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-gray-200 dark:bg-gray-800">
              {segs.map((s, j) => (
                <div
                  key={j}
                  className="absolute inset-y-0"
                  title={`${s.persons} person(s)`}
                  style={{
                    left: `${s.start * 100}%`,
                    width: `${Math.max(0.2, (s.end - s.start) * 100)}%`,
                    backgroundColor: s.persons > 0 ? color : 'transparent',
                    opacity: s.persons > 0 ? 0.45 + Math.min(0.55, s.persons * 0.2) : 1,
                  }}
                />
              ))}
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-xs">
              {z.persons > 0 ? (
                <span style={{ color }}>{z.persons}</span>
              ) : (
                <span className="text-gray-500">0</span>
              )}
            </span>
          </div>
        )
      })}
      <div className="ml-[7.75rem] flex justify-between text-[10px] text-gray-500">
        <span>-60 min</span>
        <span>-30 min</span>
        <span>now</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The app-tab surface
// ---------------------------------------------------------------------------

function PresenceTab({ ctx, pluginId }: PluginComponentProps) {
  const app = ctx.app
  const room = String(ctx.config.room ?? '').trim()
  const configZones = useMemo(
    () => parseZones(ctx.config.zones),
    [ctx.config.zones],
  )

  const [zones, setZones] = useState<ZoneRect[]>(configZones)
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Adopt externally-changed config zones while there are no local edits.
  useEffect(() => {
    if (!dirty) setZones(configZones)
  }, [configZones, dirty])

  const { state, stale, offline } = usePresenceState(app, pluginId, room)
  const personsByZone = useMemo(() => {
    const out: Record<string, number> = {}
    for (const z of state?.zones ?? []) out[z.id] = z.persons
    return out
  }, [state])

  const mutateZones = (next: ZoneRect[]) => {
    setZones(next)
    setDirty(true)
    setSaveError(null)
  }

  const onDraw = (rect: { x: number; y: number; w: number; h: number }) => {
    const id = nextZoneId(zones)
    mutateZones([...zones, { id, name: id, ...rect }])
    setSelected(id)
  }

  const onSave = async () => {
    if (!app) return
    setSaving(true)
    setSaveError(null)
    try {
      await pluginsApi.config(app, pluginId, { zones: serializeZones(zones) })
      setDirty(false)
    } catch (err) {
      setSaveError(errMessage(err, 'Could not save zones'))
    } finally {
      setSaving(false)
    }
  }

  if (!room) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Configure the plugin&apos;s <code>Room / stream</code> first (Plugins →
        Presence → Configure), then draw the zones here.
      </p>
    )
  }

  const selectedZone = zones.find((z) => z.id === selected) ?? null

  return (
    <div className="space-y-6">
      {/* status strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {offline || !state ? (
          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            Worker offline — enable the plugin to start monitoring
          </span>
        ) : (
          <>
            <span
              className={`rounded-full px-2 py-0.5 ${
                stale
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {stale ? 'Data stale' : 'Live'}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 ${
                state.schedule.inSchedule
                  ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              }`}
            >
              {state.schedule.inSchedule
                ? `In schedule ${state.schedule.window}`.trim()
                : 'Outside schedule (after hours)'}
            </span>
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              Absence threshold: {state.thresholdMin} min
            </span>
            {state.zones
              .filter((z) => z.absent)
              .map((z) => (
                <span
                  key={z.id}
                  className="rounded-full bg-red-500/15 px-2 py-0.5 text-red-600 dark:text-red-400"
                >
                  {z.name}: absent {formatDuration(z.emptyForSec)}
                </span>
              ))}
          </>
        )}
      </div>

      {/* editor + zone list */}
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <ZoneEditor
          hlsUrl={
            app
              ? `/hls/${encodeURIComponent(app)}/${encodeURIComponent(room)}/index.m3u8`
              : ''
          }
          zones={zones}
          selected={selected}
          personsByZone={personsByZone}
          onSelect={setSelected}
          onDraw={onDraw}
        />
        <div className="space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Drag on the frame to draw a zone; click a zone to select it.
          </p>
          <ul className="space-y-1">
            {zones.map((z, i) => (
              <li
                key={z.id}
                className={`flex items-center gap-2 rounded border px-2 py-1 text-sm ${
                  z.id === selected
                    ? 'border-primary-500'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <button
                  type="button"
                  className="h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: zoneColor(i) }}
                  onClick={() => setSelected(z.id)}
                  aria-label={`Select ${z.name}`}
                />
                <TextInput
                  value={z.name}
                  className="h-7 flex-1 px-1 py-0 text-sm"
                  onChange={(e) =>
                    mutateZones(
                      zones.map((zz) =>
                        zz.id === z.id ? { ...zz, name: e.target.value } : zz,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => {
                    mutateZones(zones.filter((zz) => zz.id !== z.id))
                    if (selected === z.id) setSelected(null)
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
            {zones.length === 0 && (
              <li className="text-sm text-gray-500 dark:text-gray-400">
                No zones yet — drag on the frame to create one.
              </li>
            )}
          </ul>
          {selectedZone && (
            <p className="font-mono text-[11px] text-gray-500">
              {selectedZone.id}: x={selectedZone.x.toFixed(3)} y=
              {selectedZone.y.toFixed(3)} w={selectedZone.w.toFixed(3)} h=
              {selectedZone.h.toFixed(3)}
            </p>
          )}
          {saveError && <ErrorBanner message={saveError} />}
          <div className="flex items-center gap-2">
            <Button
              variant="accent"
              disabled={!dirty || saving}
              onClick={() => void onSave()}
            >
              {saving ? 'Saving…' : 'Save zones'}
            </Button>
            {dirty && !saving && (
              <span className="text-xs text-amber-500">Unsaved changes</span>
            )}
          </div>
        </div>
      </div>

      {/* timeline */}
      {state && state.zones.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-100">
            Occupancy — last hour
          </h4>
          <Timeline state={state} />
        </div>
      )}

      {/* recent events */}
      {state && state.events.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-100">
            Recent events
          </h4>
          <ul className="space-y-1 text-sm">
            {state.events.slice(0, 12).map((e, i) => {
              const meta = EVENT_LABELS[e.event] ?? {
                label: e.event,
                tone: 'warn' as const,
              }
              const toneClass =
                meta.tone === 'bad'
                  ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                  : meta.tone === 'ok'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              return (
                <li key={`${e.ts}-${e.zone}-${i}`} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 font-mono text-xs text-gray-500">
                    {formatClock(e.ts)}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${toneClass}`}>
                    {meta.label}
                  </span>
                  <span className="truncate text-gray-700 dark:text-gray-300">
                    {e.zoneName ?? e.zone}
                    {typeof e.absentForSec === 'number' &&
                      ` — was absent ${formatDuration(e.absentForSec)}`}
                    {typeof e.persons === 'number' &&
                      e.event === 'presence.after_hours' &&
                      ` — ${e.persons} person(s)`}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

export default definePlugin({
  id: 'presence',
  kind: 'app',
  edge: true,
  name: 'Presence — Workstation Monitoring',
  description:
    'Person detection over configured zones of the live stream: absence / return / after-hours events, zone editor and occupancy timeline.',
  category: 'analytics',
  ui: 'app-tab',
  icon: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  version: '0.1.0',
  configSchema: {
    fields: [
      { key: 'room', type: 'string', label: 'Room / stream', required: true },
      {
        key: 'schedule',
        type: 'string',
        label: 'Work schedule',
        default: '08:00-18:00',
        placeholder: '08:00-18:00',
        description:
          'HH:MM-HH:MM. Presence outside it fires presence.after_hours; empty disables.',
      },
      {
        key: 'scheduleDays',
        type: 'string',
        label: 'Work days',
        default: 'mon-fri',
        placeholder: 'mon-fri',
      },
      {
        key: 'timezone',
        type: 'string',
        label: 'Timezone',
        default: '',
        placeholder: 'America/Argentina/Buenos_Aires',
        description: 'IANA timezone for the schedule; empty = server local time.',
      },
      {
        key: 'thresholdMin',
        type: 'number',
        label: 'Absence threshold (minutes)',
        default: 5,
        min: 0.1,
        max: 1440,
        step: 0.5,
      },
      {
        key: 'afterHours',
        type: 'boolean',
        label: 'After-hours detection',
        default: true,
      },
      {
        key: 'model',
        type: 'select',
        label: 'Model size',
        default: 'nano',
        options: [
          { value: 'nano', label: 'Nano (fastest, CPU-friendly)' },
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium (GPU recommended)' },
        ],
      },
      { key: 'cuda', type: 'boolean', label: 'Use CUDA (GPU)', default: false },
      {
        key: 'confidence',
        type: 'number',
        label: 'Confidence threshold',
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'fps',
        type: 'number',
        label: 'Sample FPS',
        default: 2,
        min: 0.1,
        max: 10,
        step: 0.5,
      },
      {
        key: 'callbackUrl',
        type: 'url',
        label: 'External webhook (optional)',
        default: '',
        placeholder: 'https://example.com/hooks/presence',
        description:
          "Extra raw-JSON POST per event; the app's signed callbacks fire regardless. Zones are drawn in the Presence tab.",
      },
    ],
  },
  TabComponent: PresenceTab,
})
