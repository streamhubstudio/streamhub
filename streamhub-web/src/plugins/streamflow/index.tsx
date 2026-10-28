/**
 * Frontend Studio App: streamflow — the visual n8n-style workflow builder.
 *
 * Auto-discovered (src/plugins/streamflow/index.tsx default export). Mirrors the
 * streamhub-core `streamflow` plugin so the Marketplace/Studio settings form
 * renders, and ships the full-page TabComponent with three sections:
 *
 *   - Workflows: list + create (blank or from the starter template) + enable /
 *     disable + delete + open-in-editor;
 *   - Editor: the node canvas (palette · draggable boxes with typed ports ·
 *     drag-to-connect cables · per-box config panel), Save → graph_json, plus a
 *     manual Run and a one-click "insert starter template";
 *   - Runs: recent executions with a per-step drill-down (what each box saw /
 *     emitted / errored, from GET runs/:id).
 *
 * Pure graph model + geometry + connection validation live in graph.util.ts
 * (node:test); the canvas draw/connect/save flow is covered by the vitest
 * component suite (streamflow.test.tsx). This file is the React shell + REST glue.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '@/api/http'
import { formatDateTime } from '@/lib/datetime'
import { useAppTimezone } from '@/lib/appTimezone'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps, PluginSectionMeta } from '../types.ts'
import { useSection } from '../useSection.ts'
import { NodeCanvas } from './NodeCanvas.tsx'
import {
  activeEdgeIds,
  buildIntrusionTemplate,
  deserializeGraph,
  parsePortable,
  portableFilename,
  serializeGraph,
  type BoxSpec,
  type CanvasGraph,
  type EventFamily,
  type PortableWorkflow,
} from './graph.util.ts'

const POLL_MS = 5000
type Section = 'workflows' | 'editor' | 'runs' | 'secrets'

/**
 * Declared primary-surface sections (Studio deep links + launcher). labelKeys
 * are namespace-qualified (`streamflow:…`) so the shell's launcher — which is
 * outside this namespace — can resolve them too; the tab's own `t` resolves the
 * `ns:key` form just as well.
 */
const SECTIONS: PluginSectionMeta[] = [
  { id: 'workflows', labelKey: 'streamflow:section.workflows' },
  { id: 'editor', labelKey: 'streamflow:section.editor' },
  { id: 'runs', labelKey: 'streamflow:section.runs' },
  { id: 'secrets', labelKey: 'streamflow:section.secrets' },
]
const SECTION_IDS = ['workflows', 'editor', 'runs', 'secrets'] as const

// ---------------------------------------------------------------------------
// API shapes (unwrapped { data } payloads)
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string
  name: string
  enabled: boolean
  graph: unknown
  createdAt: string
  updatedAt: string
}
type RunStatus = 'queued' | 'running' | 'ok' | 'failed'
interface RunRow {
  id: string
  workflowId: string
  triggerEvent: string
  status: RunStatus
  startedAt: string
  endedAt: string | null
  error: string | null
}
type StepStatus = 'ok' | 'failed' | 'skipped'
interface StepRow {
  id: string
  runId: string
  boxId: string
  boxType: string
  status: StepStatus
  input: unknown
  output: unknown
  ms: number | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Workflows section
// ---------------------------------------------------------------------------

function WorkflowsSection({ app, onOpen }: { app: string; onOpen: (id: string) => void }) {
  const { t } = useTranslation('streamflow')
  const [rows, setRows] = useState<WorkflowRow[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [ioMsg, setIoMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const reload = useRef<() => void>(() => {})

  useEffect(
    () =>
      startPoll(
        () => request<WorkflowRow[]>(`${base(app)}/workflows`),
        setRows,
        reload,
      ),
    [app],
  )

  const create = async (graph?: CanvasGraph, presetName?: string) => {
    const wfName = (presetName ?? name).trim() || t('wf.untitled')
    setBusy(true)
    try {
      const wf = await request<WorkflowRow>(`${base(app)}/workflows`, {
        method: 'POST',
        body: { name: wfName, graph: graph ? serializeGraph(graph) : undefined },
      })
      setName('')
      reload.current()
      if (wf?.id) onOpen(wf.id)
    } catch {
      /* surfaced by the button re-enabling */
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (wf: WorkflowRow) => {
    try {
      await request(`${base(app)}/workflows/${enc(wf.id)}/enable`, {
        method: 'POST',
        body: { enabled: !wf.enabled },
      })
    } finally {
      reload.current()
    }
  }

  const remove = async (wf: WorkflowRow) => {
    if (!confirm(t('wf.confirmDelete', { name: wf.name }))) return
    try {
      await request(`${base(app)}/workflows/${enc(wf.id)}`, { method: 'DELETE' })
    } finally {
      reload.current()
    }
  }

  const exportWf = async (wf: WorkflowRow) => {
    setIoMsg(null)
    try {
      const portable = await request<PortableWorkflow>(
        `${base(app)}/workflows/${enc(wf.id)}/export`,
      )
      downloadJson(portableFilename(wf.name), portable)
    } catch {
      setIoMsg(t('io.exportFailed'))
    }
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    setIoMsg(null)
    const text = await file.text().catch(() => '')
    const parsed = parsePortable(text)
    if (!parsed.ok) {
      setIoMsg(t('io.importInvalid'))
      return
    }
    setBusy(true)
    try {
      const wf = await request<WorkflowRow>(`${base(app)}/workflows/import`, {
        method: 'POST',
        body: { workflow: parsed.workflow },
      })
      reload.current()
      if (wf?.id) onOpen(wf.id)
    } catch {
      setIoMsg(t('io.importFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/5 p-3">
        <input
          type="text"
          value={name}
          placeholder={t('wf.namePlaceholder')}
          data-testid="sf-new-name"
          onChange={(e) => setName(e.target.value)}
          className="min-w-[12rem] flex-1 rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm"
        />
        <button
          type="button"
          disabled={busy}
          data-testid="sf-create"
          onClick={() => void create()}
          className="rounded-md bg-sky2 px-3 py-1.5 text-sm font-medium text-navy-900 disabled:opacity-40"
        >
          {t('wf.create')}
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="sf-create-template"
          onClick={() => void create(buildIntrusionTemplate(), t('template.name'))}
          className="rounded-md border border-emerald-400/40 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          {t('template.start')}
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="sf-import"
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-white/15 px-3 py-1.5 text-sm font-medium hover:bg-white/10 disabled:opacity-40"
        >
          {t('io.import')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          data-testid="sf-import-file"
          className="hidden"
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {ioMsg && <span className="text-xs text-red-400">{ioMsg}</span>}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm opacity-60">
          {t('wf.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((wf) => (
            <div
              key={wf.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{wf.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
                      wf.enabled
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-white/10 opacity-60'
                    }`}
                  >
                    {wf.enabled ? t('wf.enabled') : t('wf.disabled')}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] opacity-40">{wf.id}</div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="wf-open"
                  onClick={() => onOpen(wf.id)}
                  className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/15"
                >
                  {t('wf.open')}
                </button>
                <button
                  type="button"
                  onClick={() => void toggle(wf)}
                  className="rounded-md border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/10"
                >
                  {wf.enabled ? t('wf.disable') : t('wf.enable')}
                </button>
                <button
                  type="button"
                  data-testid="sf-export"
                  onClick={() => void exportWf(wf)}
                  className="rounded-md border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/10"
                >
                  {t('io.export')}
                </button>
                <button
                  type="button"
                  aria-label={t('wf.delete')}
                  onClick={() => void remove(wf)}
                  className="rounded-md border border-red-400/40 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editor section
// ---------------------------------------------------------------------------

function EditorSection({
  app,
  workflowId,
  onBack,
}: {
  app: string
  workflowId: string
  onBack: () => void
}) {
  const { t } = useTranslation('streamflow')
  const [catalogue, setCatalogue] = useState<BoxSpec[]>([])
  const [eventCatalogue, setEventCatalogue] = useState<EventFamily[]>([])
  const [name, setName] = useState('')
  const [graph, setGraph] = useState<CanvasGraph>({ boxes: [], edges: [] })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<'ok' | 'err' | null>(null)
  const [runMsg, setRunMsg] = useState<string | null>(null)
  const [activeEdges, setActiveEdges] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let alive = true
    setLoaded(false)
    void (async () => {
      let cat: BoxSpec[] = []
      try {
        cat = await request<BoxSpec[]>(`${base(app)}/boxes`)
      } catch {
        /* palette optional */
      }
      try {
        const evs = await request<EventFamily[]>(`${base(app)}/events`)
        if (alive) setEventCatalogue(evs)
      } catch {
        /* event picker falls back to the static list */
      }
      if (!alive) return
      setCatalogue(cat)
      try {
        const wf = await request<WorkflowRow>(`${base(app)}/workflows/${enc(workflowId)}`)
        if (!alive) return
        setName(wf.name)
        setGraph(deserializeGraph(wf.graph, cat))
      } catch {
        if (alive) setGraph({ boxes: [], edges: [] })
      }
      if (alive) setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [app, workflowId])

  const save = useCallback(async () => {
    setSaving(true)
    setSaved(null)
    try {
      await request(`${base(app)}/workflows/${enc(workflowId)}`, {
        method: 'PUT',
        body: { name: name.trim() || t('wf.untitled'), graph: serializeGraph(graph) },
      })
      setSaved('ok')
    } catch {
      setSaved('err')
    } finally {
      setSaving(false)
    }
  }, [app, workflowId, name, graph, t])

  /** Light up the edges the most recent run of this workflow flowed through. */
  const replay = useCallback(async () => {
    try {
      const runs = await request<RunRow[]>(`${base(app)}/runs`, {
        query: { workflowId, limit: 1 },
      })
      const latest = runs[0]
      if (!latest) return
      const detail = await request<{ run: RunRow; steps: StepRow[] }>(
        `${base(app)}/runs/${enc(latest.id)}`,
      )
      setActiveEdges(activeEdgeIds(graph, detail.steps.map((s) => s.boxId)))
    } catch {
      /* best-effort visual — ignore */
    }
  }, [app, workflowId, graph])

  const run = async () => {
    setRunMsg(null)
    try {
      await request(`${base(app)}/workflows/${enc(workflowId)}/run`, {
        method: 'POST',
        body: {},
      })
      setRunMsg(t('editor.runQueued'))
      // Give the run a moment to complete, then animate the path it took.
      setTimeout(() => void replay(), 1500)
    } catch {
      setRunMsg(t('editor.runFailed'))
    }
  }

  const insertTemplate = () => {
    if (graph.boxes.length && !confirm(t('editor.replaceConfirm'))) return
    setGraph(buildIntrusionTemplate())
    setSaved(null)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="sf-editor-back"
          className="text-xs opacity-70 hover:opacity-100"
        >
          ← {t('editor.back')}
        </button>
        <input
          type="text"
          value={name}
          data-testid="sf-editor-name"
          onChange={(e) => {
            setName(e.target.value)
            setSaved(null)
          }}
          className="min-w-[10rem] rounded border border-white/10 bg-white/5 px-2.5 py-1 text-sm font-semibold"
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={insertTemplate}
            className="rounded-md border border-emerald-400/40 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/10"
          >
            {t('template.insert')}
          </button>
          <button
            type="button"
            onClick={() => void run()}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs font-medium hover:bg-white/10"
          >
            {t('editor.run')}
          </button>
          <button
            type="button"
            data-testid="sf-replay"
            onClick={() => void replay()}
            className="rounded-md border border-sky-400/40 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/10"
          >
            {t('editor.replay')}
          </button>
          <button
            type="button"
            disabled={saving}
            data-testid="sf-save"
            onClick={() => void save()}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
          {saved === 'ok' && <span className="text-xs text-emerald-400">{t('editor.savedOk')}</span>}
          {saved === 'err' && <span className="text-xs text-red-400">{t('editor.savedErr')}</span>}
          {runMsg && <span className="text-xs opacity-70">{runMsg}</span>}
        </div>
      </div>

      {!loaded ? (
        <p className="text-sm opacity-60">{t('loading')}</p>
      ) : (
        <NodeCanvas
          catalogue={catalogue}
          graph={graph}
          onChange={setGraph}
          eventCatalogue={eventCatalogue}
          activeEdges={activeEdges}
        />
      )}
    </div>
  )
}

function EmptyEditor({ onGo }: { onGo: () => void }) {
  const { t } = useTranslation('streamflow')
  return (
    <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm opacity-60">
      {t('editor.none')}{' '}
      <button type="button" onClick={onGo} className="text-sky2 underline">
        {t('editor.goWorkflows')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Runs section
// ---------------------------------------------------------------------------

const RUN_TONE: Record<RunStatus, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  running: 'bg-amber-500/15 text-amber-300',
  queued: 'bg-white/10 opacity-70',
}
const STEP_TONE: Record<StepStatus, string> = {
  ok: 'text-emerald-300',
  failed: 'text-red-300',
  skipped: 'opacity-50',
}

function RunsView({ app }: { app: string }) {
  const { t } = useTranslation('streamflow')
  const tz = useAppTimezone()
  const [runs, setRuns] = useState<RunRow[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ run: RunRow; steps: StepRow[] } | null>(null)

  useEffect(
    () =>
      startPoll(
        () => request<RunRow[]>(`${base(app)}/runs`, { query: { limit: 50 } }),
        setRuns,
      ),
    [app],
  )

  useEffect(() => {
    if (!openId) {
      setDetail(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const d = await request<{ run: RunRow; steps: StepRow[] }>(
          `${base(app)}/runs/${enc(openId)}`,
        )
        if (alive) setDetail(d)
      } catch {
        if (alive) setDetail(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [app, openId])

  if (runs.length === 0) {
    return <p className="text-sm opacity-60">{t('runs.empty')}</p>
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        {runs.map((r) => (
          <button
            key={r.id}
            type="button"
            data-testid="sf-run-row"
            onClick={() => setOpenId(r.id === openId ? null : r.id)}
            className={`block w-full rounded-lg border p-3 text-left ${
              r.id === openId ? 'border-sky-400/60 bg-sky-500/5' : 'border-white/10 bg-white/5 hover:bg-white/10'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-sky2">{r.triggerEvent || t('runs.manual')}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${RUN_TONE[r.status]}`}>
                {t(`runs.status.${r.status}`)}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] opacity-50">
              <span>{formatDateTime(r.startedAt, tz)}</span>
              <span>{duration(r.startedAt, r.endedAt)}</span>
            </div>
            {r.error && <div className="mt-1 truncate text-[10px] text-red-400">{r.error}</div>}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        {!detail ? (
          <p className="text-sm opacity-50">{t('runs.pickOne')}</p>
        ) : (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide opacity-70">
              {t('runs.steps')}
            </h4>
            {detail.steps.length === 0 && <p className="text-xs opacity-50">{t('runs.noSteps')}</p>}
            {detail.steps.map((s) => (
              <details key={s.id} className="rounded-md border border-white/10 bg-white/5 p-2">
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs">
                  <span className="font-mono">
                    <span className="opacity-60">{s.boxId}</span>{' '}
                    <span className="opacity-40">· {s.boxType}</span>
                  </span>
                  <span className={`font-medium ${STEP_TONE[s.status]}`}>
                    {t(`runs.step.${s.status}`)}
                    {s.ms != null ? ` · ${s.ms}ms` : ''}
                  </span>
                </summary>
                {s.error && <p className="mt-1 text-[11px] text-red-400">{s.error}</p>}
                <StepIO label={t('runs.in')} value={s.input} />
                <StepIO label={t('runs.out')} value={s.output} />
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StepIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null
  return (
    <div className="mt-1">
      <div className="text-[10px] uppercase tracking-wide opacity-40">{label}</div>
      <pre className="max-h-40 overflow-auto rounded bg-black/30 p-1.5 text-[10px] leading-tight">
        {safeStringify(value)}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Secrets section (write-only; values never returned)
// ---------------------------------------------------------------------------

interface SecretMeta {
  name: string
  last4: string
  createdAt: string
  updatedAt: string
}

function SecretsView({ app }: { app: string }) {
  const { t } = useTranslation('streamflow')
  const [rows, setRows] = useState<SecretMeta[]>([])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const reload = useRef<() => void>(() => {})

  useEffect(
    () => startPoll(() => request<SecretMeta[]>(`${base(app)}/secrets`), setRows, reload),
    [app],
  )

  const save = async () => {
    const key = name.trim().toUpperCase()
    if (!/^[A-Z0-9_]{1,64}$/.test(key)) {
      setErr(t('secrets.badName'))
      return
    }
    if (!value) {
      setErr(t('secrets.needValue'))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await request(`${base(app)}/secrets/${enc(key)}`, { method: 'PUT', body: { value } })
      setName('')
      setValue('')
      reload.current()
    } catch {
      setErr(t('secrets.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (s: SecretMeta) => {
    if (!confirm(t('secrets.confirmDelete', { name: s.name }))) return
    try {
      await request(`${base(app)}/secrets/${enc(s.name)}`, { method: 'DELETE' })
    } finally {
      reload.current()
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
        {t('secrets.help')}
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-white/10 bg-white/5 p-3">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide opacity-60">
          {t('secrets.name')}
          <input
            type="text"
            value={name}
            placeholder="API_KEY"
            data-testid="sf-secret-name"
            onChange={(e) => setName(e.target.value)}
            className="min-w-[10rem] rounded border border-white/10 bg-white/5 px-2.5 py-1.5 font-mono text-sm normal-case"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-wide opacity-60">
          {t('secrets.value')}
          <input
            type="password"
            value={value}
            autoComplete="off"
            data-testid="sf-secret-value"
            onChange={(e) => setValue(e.target.value)}
            className="min-w-[12rem] rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm normal-case"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          data-testid="sf-secret-save"
          onClick={() => void save()}
          className="rounded-md bg-sky2 px-3 py-1.5 text-sm font-medium text-navy-900 disabled:opacity-40"
        >
          {t('secrets.save')}
        </button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm opacity-60">
          {t('secrets.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <div
              key={s.name}
              data-testid="sf-secret-row"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 p-3"
            >
              <div className="min-w-0">
                <span className="font-mono text-sm font-semibold">{s.name}</span>
                <span className="ml-2 font-mono text-xs opacity-50">
                  {s.last4 ? `…${s.last4}` : '••••'}
                </span>
                <div className="mt-0.5 text-[10px] opacity-40">
                  {t('secrets.refPrefix')}{' '}
                  <code className="font-mono">{`{{secret.${s.name}}}`}</code>
                </div>
              </div>
              <button
                type="button"
                aria-label={t('secrets.delete')}
                onClick={() => void remove(s)}
                className="rounded-md border border-red-400/40 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// root tab
// ---------------------------------------------------------------------------

function StreamflowTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation('streamflow')
  const app = ctx.app ?? ''
  const [section, setSection] = useSection<Section>(ctx, SECTION_IDS, 'workflows')
  const [editingId, setEditingId] = useState<string | null>(null)

  const open = (id: string) => {
    setEditingId(id)
    setSection('editor')
  }

  if (!app) return null
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-lg border border-white/10 p-0.5">
        {SECTIONS.map((s) => (
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
      {section === 'workflows' && <WorkflowsSection app={app} onOpen={open} />}
      {section === 'editor' &&
        (editingId ? (
          <EditorSection app={app} workflowId={editingId} onBack={() => setSection('workflows')} />
        ) : (
          <EmptyEditor onGo={() => setSection('workflows')} />
        ))}
      {section === 'runs' && <RunsView app={app} />}
      {section === 'secrets' && <SecretsView app={app} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function enc(s: string): string {
  return encodeURIComponent(s)
}

function base(app: string): string {
  return `/apps/${enc(app)}/plugins/streamflow`
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** Trigger a client-side JSON file download (best-effort; no-op without DOM). */
function downloadJson(filename: string, data: unknown): void {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    /* non-browser env (tests) — ignore */
  }
}

/** Human duration between two SQLite timestamps (best-effort). */
function duration(start: string, end: string | null): string {
  if (!end) return '—'
  const a = Date.parse(start.replace(' ', 'T'))
  const b = Date.parse(end.replace(' ', 'T'))
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—'
  const ms = b - a
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Poll `fetcher` every POLL_MS into `set`. Returns a cleanup fn (usable directly
 * as a useEffect return). `reloadRef`, when passed, gets a manual "refetch now".
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

export default definePlugin({
  id: 'streamflow',
  kind: 'app',
  name: 'Streamflow — Workflow Engine',
  description:
    'Chain boxes to turn any StreamHub event into an automation: trigger on a ' +
    'domain event, snapshot the room, analyze it with ChatGPT/DeepSeek, branch ' +
    'on the result, then notify / emit / store — a visual n8n-style builder.',
  category: 'tool',
  ui: 'app-tab',
  sections: SECTIONS,
  version: '0.1.0',
  icon: 'M4 5a2 2 0 114 0 2 2 0 01-4 0zM16 5a2 2 0 114 0 2 2 0 01-4 0zM10 19a2 2 0 114 0 2 2 0 01-4 0zM8 5h8M6 7v3a2 2 0 002 2h8a2 2 0 002-2V7M12 14v3',
  configSchema: {
    fields: [
      {
        key: 'ai_provider',
        type: 'select',
        label: 'AI provider',
        default: 'openai',
        options: [
          { value: 'openai', label: 'OpenAI' },
          { value: 'deepseek', label: 'DeepSeek' },
        ],
      },
      { key: 'ai_api_key', type: 'secret', label: 'AI API key', default: '' },
      { key: 'ai_model', type: 'string', label: 'AI model', default: 'gpt-4o-mini' },
      {
        key: 'ai_budget_monthly_usd',
        type: 'number',
        label: 'Monthly AI budget (USD)',
        default: 20,
        min: 0,
        max: 100000,
      },
      {
        key: 'max_runs_per_min',
        type: 'number',
        label: 'Max runs / minute',
        default: 60,
        min: 1,
        max: 100000,
      },
      {
        key: 'dangerousNodes',
        type: 'boolean',
        label: 'Enable execution nodes (code / ssh / shell / db)',
        default: false,
      },
    ],
  },
  TabComponent: StreamflowTab,
})
