/**
 * Shared full-page tab for the four vision Studio Apps (occupancy / counting /
 * crowd / demography). Each app's `src/plugins/<model>/index.tsx` is a thin
 * `makeVisionApp('<model>', …)` wrapper — this file holds the ONE parametrized
 * implementation so the four apps never diverge.
 *
 * A single model per app (the app id IS the model), served from the per-app
 * vision-apps API `/apps/:app/plugins/<model>/{overview,streams,streams/:room/
 * settings,events}`. Three sections:
 *   - Overview: today's detections, enabled state, edge-assignment + stream tallies;
 *   - Streams: active rooms + the per-room settings editor — the POLYGON / LINE /
 *     ROI canvas (zones for occupancy·crowd, a crossing line for counting, a
 *     single region-of-interest + interval/engine for demography);
 *   - Events: recent detections for this model (from its per-app db).
 *
 * The edge nodes + sizing surfaces are NOT here — edge is the cluster's
 * processing concept and lives on the Cluster page (Edge tab).
 *
 * Pure geometry lives in poly.util.ts (node:test); the draw→save flow is covered
 * by VisionAppTab.test (vitest). This file is the React shell.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import { HlsPlayer } from '@/components/player'
import { definePlugin } from '../types.ts'
import type {
  ConfigSchema,
  PluginComponentProps,
  PluginModule,
  PluginSectionMeta,
} from '../types.ts'
import { useSection } from '../useSection.ts'
import { PolygonEditor } from './PolygonEditor.tsx'
import {
  defaultLine,
  defaultPoiPoints,
  defaultZonePoints,
  demographyToConfig,
  editorMode,
  linesToConfig,
  parseDemography,
  parseLines,
  parseZones,
  zonesToConfig,
  type Demography,
  type DemographyEngine,
  type EditorMode,
  type Inside,
  type Line,
  type Zone,
} from './poly.util.ts'

const POLL_MS = 5000
type Section = 'overview' | 'streams' | 'events'

/**
 * Declared primary-surface sections (Studio deep links + launcher). labelKeys
 * are namespace-qualified (`visionApps:…`) so the shell's launcher — outside
 * this namespace — resolves them; the tab's own `t` resolves the `ns:key` form
 * just as well.
 */
const VISION_SECTIONS: PluginSectionMeta[] = [
  { id: 'overview', labelKey: 'visionApps:section.overview' },
  { id: 'streams', labelKey: 'visionApps:section.streams' },
  { id: 'events', labelKey: 'visionApps:section.events' },
]
const VISION_SECTION_IDS = ['overview', 'streams', 'events'] as const

// ---------------------------------------------------------------------------
// API shapes (unwrapped { data } payloads — per-model, not per-app)
// ---------------------------------------------------------------------------

interface Overview {
  model: string
  enabled: boolean
  today: number
  assignments: number
  activeStreams: number
}
interface StreamRow {
  room: string
  tags: string[]
  hasSettings: boolean
  updatedAt: string | null
}
interface EventRow {
  id: number
  model: string
  event: string
  room: string
  tag: string | null
  ts: string
  data: Record<string, unknown>
}
interface TagRow {
  slug: string
  label: string
}

// ---------------------------------------------------------------------------
// tiny presentational helpers
// ---------------------------------------------------------------------------

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-center">
      <div className={`font-mono text-2xl font-bold ${tone ?? 'text-sky2'}`}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wide opacity-70">{label}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewSection({ app, model }: { app: string; model: string }) {
  const { t } = useTranslation('visionApps')
  const [ov, setOv] = useState<Overview | null>(null)
  useEffect(
    () => startPoll(() => request<Overview>(`${base(app, model)}/overview`), setOv),
    [app, model],
  )
  if (!ov) return <p className="text-sm opacity-60">{t('loading')}</p>
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">{t(`model.${model}`)}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
              ov.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 opacity-60'
            }`}
          >
            {ov.enabled ? t('enabled') : t('disabled')}
          </span>
        </div>
        <div className="mt-2 font-mono text-3xl font-bold text-sky2">{ov.today}</div>
        <div className="text-xs opacity-60">{t('today')}</div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('activeStreams')} value={ov.activeStreams} />
        <Stat label={t('assignmentsLabel')} value={ov.assignments} tone="text-emerald-400" />
        <Stat
          label={t('status')}
          value={ov.enabled ? t('enabled') : t('disabled')}
          tone={ov.enabled ? 'text-emerald-400' : 'text-amber-300'}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Streams + editor
// ---------------------------------------------------------------------------

function StreamsSection({ app, model }: { app: string; model: string }) {
  const { t } = useTranslation('visionApps')
  const [rows, setRows] = useState<StreamRow[]>([])
  const [sel, setSel] = useState<string | null>(null)
  useEffect(
    () => startPoll(() => request<StreamRow[]>(`${base(app, model)}/streams`), setRows),
    [app, model],
  )

  if (sel) {
    return <StreamEditor app={app} model={model} room={sel} onBack={() => setSel(null)} />
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm opacity-60">
          {t('noStreams')}
        </div>
      ) : (
        rows.map((r) => (
          <div key={r.room} className="rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold">{r.room}</span>
              <div className="flex flex-wrap items-center gap-1">
                {r.tags.map((tg) => (
                  <span key={tg} className="rounded-full bg-sky2/15 px-2 py-0.5 text-[10px] text-sky2">
                    {tg}
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-3">
              <button
                type="button"
                data-testid={`edit-${r.room}`}
                onClick={() => setSel(r.room)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  r.hasSettings
                    ? 'bg-emerald-600/20 text-emerald-300'
                    : 'bg-white/10 hover:bg-white/15'
                }`}
              >
                {r.hasSettings ? t('editSettings') : t('configure')}
                {r.hasSettings ? ' ✓' : ''}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function StreamEditor({
  app,
  model,
  room,
  onBack,
}: {
  app: string
  model: string
  room: string
  onBack: () => void
}) {
  const { t } = useTranslation('visionApps')
  const mode: EditorMode = editorMode(model)
  const [zones, setZones] = useState<Zone[]>([])
  const [lines, setLines] = useState<Line[]>([])
  // POIs (owner item 34): tagged polygons for counting + demography — drawn with
  // the SAME PolygonEditor as occupancy/crowd zones.
  const [pois, setPois] = useState<Zone[]>([])
  const [fps, setFps] = useState(3.5)
  const [demography, setDemography] = useState<Demography>({
    roi: null,
    intervalSec: 120,
    engine: 'local',
    pois: [],
  })
  const [tags, setTags] = useState<TagRow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<'ok' | 'err' | null>(null)

  // Load current settings + the app's tags.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await request<{ config: unknown }>(
          `${base(app, model)}/streams/${enc(room)}/settings`,
        )
        if (!alive) return
        if (mode === 'zones') {
          const z = parseZones(s.config)
          setZones(z)
          setActiveId(z[0]?.id ?? null)
        } else if (mode === 'lines') {
          const l = parseLines(s.config)
          setLines(l.lines)
          setFps(l.fps)
          setPois(l.pois)
          setActiveId(l.lines[0]?.id ?? l.pois[0]?.id ?? null)
        } else {
          const d = parseDemography(s.config)
          // Fold a legacy single ROI into the POI list so old configs stay editable.
          const initialPois = d.pois.length
            ? d.pois
            : d.roi
              ? [{ ...d.roi, id: 'roi', tag: '' }]
              : []
          setDemography({ ...d, roi: null, pois: initialPois })
          setPois(initialPois)
          setActiveId(initialPois[0]?.id ?? null)
        }
      } catch {
        /* keep empty */
      }
      try {
        const tg = await request<TagRow[]>(`/apps/${enc(app)}/tags`)
        if (alive) setTags(tg)
      } catch {
        /* tags optional */
      }
    })()
    return () => {
      alive = false
    }
  }, [app, model, room, mode])

  // The canvas polygons are zones (occupancy/crowd) or POIs (counting/demography);
  // counting ALSO draws its crossing lines on the same canvas.
  const canvasZones = mode === 'zones' ? zones : pois
  const canvasLines = mode === 'lines' ? lines : []

  const addZone = () => {
    const id = `zone-${zones.length + 1}-${Date.now().toString(36)}`
    setZones([...zones, { id, tag: '', detect: 'personas', points: defaultZonePoints() }])
    setActiveId(id)
    setEditing(true)
  }
  const addLine = () => {
    const id = `line-${lines.length + 1}-${Date.now().toString(36)}`
    setLines([...lines, { id, tag: '', inside: 'top', ...defaultLine() }])
    setActiveId(id)
    setEditing(true)
  }
  const addPoi = () => {
    const id = `poi-${pois.length + 1}-${Date.now().toString(36)}`
    setPois([...pois, { id, tag: '', detect: 'personas', points: defaultPoiPoints() }])
    setActiveId(id)
    setEditing(true)
  }
  const addShape = () => {
    if (mode === 'zones') addZone()
    else if (mode === 'lines') addLine()
    else addPoi()
  }

  const removeZone = (id: string) => {
    setZones(zones.filter((z) => z.id !== id))
    if (activeId === id) setActiveId(null)
  }
  const removeLine = (id: string) => {
    setLines(lines.filter((l) => l.id !== id))
    if (activeId === id) setActiveId(null)
  }
  const removePoi = (id: string) => {
    setPois(pois.filter((p) => p.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const save = useCallback(async () => {
    setSaving(true)
    setSaved(null)
    try {
      const config =
        mode === 'zones'
          ? zonesToConfig(zones)
          : mode === 'lines'
            ? linesToConfig(lines, fps, undefined, pois)
            : demographyToConfig({ ...demography, roi: null, pois })
      await request(`${base(app, model)}/streams/${enc(room)}/settings`, {
        method: 'PUT',
        body: { config },
      })
      setSaved('ok')
      setEditing(false)
    } catch {
      setSaved('err')
    } finally {
      setSaving(false)
    }
  }, [app, model, room, mode, zones, lines, fps, pois, demography])

  const hlsSrc = `/hls/${enc(app)}/${enc(room)}/index.m3u8`

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-xs opacity-70 hover:opacity-100">
        ← {t('backToStreams')}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          {room} · {t(`model.${model}`)}
        </h3>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          <p className="mb-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 lg:hidden dark:text-amber-300">
            {t('smallScreenHint')}
          </p>
          <div className="relative overflow-hidden rounded-lg bg-black/40">
            <HlsPlayer src={hlsSrc} autoplay className="w-full" />
            <PolygonEditor
              zones={canvasZones}
              lines={canvasLines}
              activeId={activeId}
              editable={editing}
              onZonesChange={(next) => (mode === 'zones' ? setZones(next) : setPois(next))}
              onLinesChange={setLines}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                editing ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 hover:bg-white/15'
              }`}
            >
              {editing ? t('actions.done') : t('actions.edit')}
            </button>
            <button
              type="button"
              onClick={addShape}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/15"
            >
              {mode === 'lines'
                ? t('actions.addLine')
                : mode === 'roi'
                  ? t('actions.addPoi')
                  : t('actions.addZone')}
            </button>
            {mode === 'lines' && (
              <button
                type="button"
                onClick={addPoi}
                data-testid="vision-add-poi"
                className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/15"
              >
                {t('actions.addPoi')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              data-testid="vision-save"
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? t('actions.saving') : t('actions.save')}
            </button>
            {saved === 'ok' && <span className="text-xs text-emerald-400">{t('savedOk')}</span>}
            {saved === 'err' && <span className="text-xs text-red-400">{t('savedErr')}</span>}
          </div>
          {editing && <p className="mt-2 text-xs opacity-60">{t(`hint.${mode}`)}</p>}
        </div>

        {/* Shape list / demography controls */}
        <div className="w-full shrink-0 space-y-2 lg:w-72">
          {mode === 'roi' && <DemographyControls d={demography} onChange={setDemography} />}

          {mode === 'zones' && (
            <>
              <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">{t('zones')}</h4>
              {zones.length === 0 && <p className="text-xs opacity-50">{t('noShapes')}</p>}
              {zones.map((z) => (
                <ShapeRow
                  key={z.id}
                  active={activeId === z.id}
                  onSelect={() => setActiveId(z.id)}
                  onRemove={() => removeZone(z.id)}
                  tags={tags}
                  tag={z.tag}
                  onTag={(tag) => setZones(zones.map((x) => (x.id === z.id ? { ...x, tag } : x)))}
                  extra={
                    <select
                      aria-label={t('detect')}
                      value={z.detect}
                      onChange={(e) =>
                        setZones(
                          zones.map((x) =>
                            x.id === z.id ? { ...x, detect: e.target.value as Zone['detect'] } : x,
                          ),
                        )
                      }
                      className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
                    >
                      <option value="personas">{t('personas')}</option>
                      <option value="vehiculos">{t('vehiculos')}</option>
                    </select>
                  }
                />
              ))}
            </>
          )}

          {mode === 'lines' && (
            <>
              <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">{t('lines')}</h4>
              {lines.length === 0 && <p className="text-xs opacity-50">{t('noShapes')}</p>}
              {lines.map((l) => (
                <ShapeRow
                  key={l.id}
                  active={activeId === l.id}
                  onSelect={() => setActiveId(l.id)}
                  onRemove={() => removeLine(l.id)}
                  tags={tags}
                  tag={l.tag}
                  onTag={(tag) => setLines(lines.map((x) => (x.id === l.id ? { ...x, tag } : x)))}
                  extra={
                    <select
                      aria-label={t('inside')}
                      value={l.inside}
                      onChange={(e) =>
                        setLines(
                          lines.map((x) =>
                            x.id === l.id ? { ...x, inside: e.target.value as Inside } : x,
                          ),
                        )
                      }
                      className="rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
                    >
                      {(['top', 'bottom', 'left', 'right'] as Inside[]).map((s) => (
                        <option key={s} value={s}>
                          {t(`side.${s}`)}
                        </option>
                      ))}
                    </select>
                  }
                />
              ))}
              <label className="mt-2 block text-xs opacity-70">
                {t('fps')}
                <input
                  type="number"
                  min={0.5}
                  max={30}
                  step={0.5}
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value) || 3.5)}
                  className="ml-2 w-16 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
                />
              </label>
            </>
          )}

          {/* POI list — counting + demography gate detections to inside a POI. */}
          {(mode === 'lines' || mode === 'roi') && (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide opacity-70">{t('pois')}</h4>
              {pois.length === 0 && <p className="text-xs opacity-50">{t('noPois')}</p>}
              {pois.map((p) => (
                <ShapeRow
                  key={p.id}
                  active={activeId === p.id}
                  onSelect={() => setActiveId(p.id)}
                  onRemove={() => removePoi(p.id)}
                  tags={tags}
                  tag={p.tag}
                  onTag={(tag) => setPois(pois.map((x) => (x.id === p.id ? { ...x, tag } : x)))}
                  extra={null}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DemographyControls({
  d,
  onChange,
}: {
  d: Demography
  onChange: (d: Demography) => void
}) {
  const { t } = useTranslation('visionApps')
  const ENGINES: DemographyEngine[] = ['local', 'openai', 'deepseek']
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">{t('demography.title')}</h4>
      <label className="block text-xs opacity-70">
        {t('demography.engine')}
        <select
          aria-label={t('demography.engine')}
          value={d.engine}
          onChange={(e) => onChange({ ...d, engine: e.target.value as DemographyEngine })}
          className="mt-1 block w-full rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
        >
          {ENGINES.map((eng) => (
            <option key={eng} value={eng}>
              {t(`demography.engineOpt.${eng}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs opacity-70">
        {t('demography.interval')}
        <input
          type="number"
          min={5}
          max={86400}
          step={5}
          value={d.intervalSec}
          aria-label={t('demography.interval')}
          onChange={(e) => onChange({ ...d, intervalSec: Math.max(5, Number(e.target.value) || 120) })}
          className="mt-1 block w-24 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
        />
      </label>
      <p className="text-[11px] opacity-50">{t('demography.roiHint')}</p>
    </div>
  )
}

function ShapeRow({
  active,
  onSelect,
  onRemove,
  tags,
  tag,
  onTag,
  extra,
}: {
  active: boolean
  onSelect: () => void
  onRemove: () => void
  tags: TagRow[]
  tag: string
  onTag: (tag: string) => void
  extra: React.ReactNode
}) {
  const { t } = useTranslation('visionApps')
  return (
    <div
      className={`flex items-center gap-1 rounded-md border p-2 ${
        active ? 'border-sky2/60 bg-sky2/10' : 'border-white/10 bg-white/5'
      }`}
    >
      <button type="button" onClick={onSelect} className="flex-1 text-left text-xs">
        <select
          aria-label={t('tag')}
          value={tag}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onTag(e.target.value)}
          className="w-full rounded border border-white/10 bg-white/5 px-1 py-0.5 text-xs"
        >
          <option value="">{t('noTag')}</option>
          {tags.map((tg) => (
            <option key={tg.slug} value={tg.slug}>
              {tg.label}
            </option>
          ))}
        </select>
      </button>
      {extra}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('remove')}
        className="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-500/10"
      >
        ✕
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function EventsSection({ app, model }: { app: string; model: string }) {
  const { t } = useTranslation('visionApps')
  const [rows, setRows] = useState<EventRow[]>([])
  useEffect(
    () =>
      startPoll(
        () => request<EventRow[]>(`${base(app, model)}/events`, { query: { limit: 50 } }),
        setRows,
      ),
    [app, model],
  )
  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm opacity-60">{t('noEvents')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="opacity-60">
              <tr>
                <th className="py-1 pr-3">{t('col.event')}</th>
                <th className="py-1 pr-3">{t('col.room')}</th>
                <th className="py-1 pr-3">{t('col.tag')}</th>
                <th className="py-1 pr-3">{t('col.detail')}</th>
                <th className="py-1">{t('col.ts')}</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="py-1 pr-3 text-sky2">{r.event}</td>
                  <td className="py-1 pr-3">{r.room}</td>
                  <td className="py-1 pr-3">{r.tag ?? '—'}</td>
                  <td className="py-1 pr-3 opacity-70">{detailOf(model, r)}</td>
                  <td className="py-1 opacity-50">{r.ts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function detailOf(model: string, r: EventRow): string {
  const d = r.data ?? {}
  if (model === 'crowd') return `${d.count ?? '—'}${d.threshold ? ` / ${d.threshold}` : ''}`
  if (model === 'counting') return String(d.direction ?? d.track_id ?? '')
  if (model === 'demography') return `${d.gender ?? '?'} · ${d.age_range ?? d.age ?? '?'}`
  return String(d.zone ?? d.kind ?? '')
}

// ---------------------------------------------------------------------------
// root tab
// ---------------------------------------------------------------------------

function VisionAppTab({ ctx, pluginId, model }: PluginComponentProps & { model: string }) {
  const { t } = useTranslation('visionApps')
  const app = ctx.app ?? ''
  const [section, setSection] = useSection<Section>(ctx, VISION_SECTION_IDS, 'overview')
  const activeModel = model || pluginId
  if (!app) return null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-white/10 p-0.5">
        {VISION_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`section-${s.id}`}
            onClick={() => setSection(s.id as Section)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              section === s.id ? 'bg-sky2 text-navy-900' : 'opacity-70 hover:opacity-100'
            }`}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>
      {section === 'overview' && <OverviewSection app={app} model={activeModel} />}
      {section === 'streams' && <StreamsSection app={app} model={activeModel} />}
      {section === 'events' && <EventsSection app={app} model={activeModel} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function enc(s: string): string {
  return encodeURIComponent(s)
}

/** Per-model API base path. The app id (pluginId) IS the vision model. */
function base(app: string, model: string): string {
  return `/apps/${enc(app)}/plugins/${enc(model)}`
}

/**
 * Poll `fetcher` every POLL_MS into `set`. Returns a cleanup fn (usable directly
 * as a useEffect return). `reloadRef`, when passed, is populated with a manual
 * "refetch now" trigger.
 */
function startPoll<T>(
  fetcher: () => Promise<T>,
  set: (v: T) => void,
  reloadRef?: React.MutableRefObject<() => void>,
): () => void {
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    try {
      const v = await fetcher()
      if (alive) set(v)
    } catch {
      /* keep last */
    }
    if (alive) timer = setTimeout(run, POLL_MS)
  }
  if (reloadRef) {
    reloadRef.current = () => {
      if (timer !== undefined) clearTimeout(timer)
      void run()
    }
  }
  void run()
  return () => {
    alive = false
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// app factory
// ---------------------------------------------------------------------------

export interface VisionAppSpec {
  /** The model id — also the plugin/app id and the API path segment. */
  id: string
  name: string
  description: string
  /** SVG path or short glyph. */
  icon?: string
  version?: string
  configSchema: ConfigSchema
}

/**
 * Build one vision Studio App module. All four apps (occupancy / counting /
 * crowd / demography) are thin wrappers over the shared {@link VisionAppTab};
 * the id drives which model's API + editor the tab renders. `kind:'app'`,
 * `ui:'app-tab'`, `edge:true` are fixed — these are the edge-capable vision apps.
 */
export function makeVisionApp(spec: VisionAppSpec): PluginModule {
  const Tab = (props: PluginComponentProps) => <VisionAppTab {...props} model={spec.id} />
  return definePlugin({
    id: spec.id,
    kind: 'app',
    name: spec.name,
    description: spec.description,
    category: 'processor',
    ui: 'app-tab',
    sections: VISION_SECTIONS,
    edge: true,
    version: spec.version ?? '0.1.0',
    icon: spec.icon,
    configSchema: spec.configSchema,
    TabComponent: Tab,
  })
}

export { VisionAppTab }
